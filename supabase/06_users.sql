-- ============================================================
-- Velora Fresh — adding people from inside the app
--
-- The owner should not have to open the SQL editor to add a user.
-- But creating a login needs the service_role key, and that key must
-- never reach a browser: it bypasses every policy in 02_security.sql.
--
-- So the owner does not create the account. The owner records an
-- invite — phone or email, plus the tag that person gets. When they
-- sign themselves up, a trigger on auth.users matches the invite and
-- creates their app_users row with exactly that tag.
--
-- Nothing privileged is ever exposed to the client, and an uninvited
-- signup lands with no app_users row, which every policy reads as
-- "sees nothing".
--
-- Run after 02_security.sql.
-- ============================================================

-- Local stub. On Supabase auth.users already exists and this is skipped.
do $$
begin
  if not exists (
    select 1 from pg_tables where schemaname = 'auth' and tablename = 'users'
  ) then
    create table auth.users (
      id    uuid primary key,
      email text,
      phone text
    );
  end if;
end $$;

-- ------------------------------------------------------------
-- invites
-- ------------------------------------------------------------

create table if not exists user_invites (
  id         uuid primary key default gen_random_uuid(),
  phone      text unique,
  email      text unique,
  full_name  text not null default '',
  role       app_role not null,
  client_id  text references clients(id) on delete cascade,
  shop_id    text references shops(id) on delete cascade,
  invited_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  used_at    timestamptz,

  -- the same shape rules app_users enforces, checked before the person
  -- signs up rather than after
  constraint invite_needs_contact check (phone is not null or email is not null),
  constraint invite_shop_has_shop check (role <> 'shop' or shop_id is not null),
  constraint invite_shop_has_phone check (role <> 'shop' or phone is not null),
  constraint invite_client_roles check (role in ('owner','admin') or client_id is not null)
);

alter table user_invites enable row level security;
alter table user_invites force row level security;

-- Only an owner may invite, and only an owner may see who was invited.
-- An owner can therefore hand out any tag, including owner — which is
-- the "he will give access to the next person" rule.
create policy owner_invites on user_invites for all
  using (is_owner()) with check (is_owner());

grant select, insert, update, delete on user_invites to authenticated;

-- ------------------------------------------------------------
-- the link
--
-- Fires when someone completes signup. SECURITY DEFINER because the
-- new user has no app_users row yet, so no policy would let them
-- create one — which is the point: they cannot grant themselves a tag.
-- ------------------------------------------------------------

create or replace function link_invited_user()
returns trigger language plpgsql security definer set search_path = public, auth as $$
declare
  inv user_invites;
begin
  select * into inv from user_invites
   where used_at is null
     and (   (phone is not null and phone = new.phone)
          or (email is not null and lower(email) = lower(new.email)))
   order by created_at
   limit 1;

  -- No invite: the account exists but sees nothing. Deliberate.
  if inv.id is null then
    return new;
  end if;

  insert into app_users (id, phone, full_name, role, client_id, shop_id)
       values (new.id,
               coalesce(inv.phone, new.phone),
               inv.full_name,
               inv.role,
               inv.client_id,
               inv.shop_id)
  on conflict (id) do nothing;

  update user_invites set used_at = now() where id = inv.id;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function link_invited_user();

-- ------------------------------------------------------------
-- what the app calls
-- ------------------------------------------------------------

-- The Users screen. Shows active people and invites not yet taken up.
-- Owner-only: the underlying policies already refuse everyone else, and
-- this returns an empty set rather than an error.
create or replace function list_people()
returns table (
  kind      text,          -- 'user' | 'invite'
  id        uuid,
  phone     text,
  full_name text,
  role      app_role,
  client_id text,
  shop_id   text,
  active    boolean,
  since     timestamptz
) language sql stable security definer set search_path = public as $$
  select 'user', u.id, u.phone, u.full_name, u.role, u.client_id, u.shop_id,
         u.active, u.created_at
    from app_users u
   where is_owner()
  union all
  select 'invite', i.id, i.phone, i.full_name, i.role, i.client_id, i.shop_id,
         false, i.created_at
    from user_invites i
   where is_owner() and i.used_at is null
   order by 9 desc
$$;

-- Add a person. Returns the invite id.
create or replace function invite_person(
  p_role      app_role,
  p_full_name text,
  p_phone     text default null,
  p_email     text default null,
  p_client_id text default null,
  p_shop_id   text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not is_owner() then
    raise exception 'only an owner may add people'
      using errcode = 'insufficient_privilege';
  end if;

  insert into user_invites (phone, email, full_name, role, client_id, shop_id, invited_by)
       values (nullif(p_phone,''), nullif(p_email,''), coalesce(p_full_name,''),
               p_role, nullif(p_client_id,''), nullif(p_shop_id,''), auth.uid())
    returning id into v_id;

  return v_id;
end $$;

-- Change someone's tag, or switch them off. Never deletes: past indents
-- must stay attached to whoever entered them.
create or replace function set_person_role(p_user uuid, p_role app_role)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_owner() then
    raise exception 'only an owner may change a role'
      using errcode = 'insufficient_privilege';
  end if;
  -- an owner cannot demote themselves and lock the business out
  if p_user = auth.uid() and p_role <> 'owner' then
    raise exception 'you cannot remove your own owner access'
      using errcode = 'check_violation';
  end if;
  update app_users set role = p_role where id = p_user;
end $$;

create or replace function set_person_active(p_user uuid, p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_owner() then
    raise exception 'only an owner may deactivate a person'
      using errcode = 'insufficient_privilege';
  end if;
  if p_user = auth.uid() and not p_active then
    raise exception 'you cannot deactivate yourself'
      using errcode = 'check_violation';
  end if;
  update app_users set active = p_active where id = p_user;
end $$;

-- Withdraw an invite that has not been taken up yet.
create or replace function cancel_invite(p_invite uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_owner() then
    raise exception 'only an owner may cancel an invite'
      using errcode = 'insufficient_privilege';
  end if;
  delete from user_invites where id = p_invite and used_at is null;
end $$;

grant execute on function list_people, invite_person, set_person_role,
                         set_person_active, cancel_invite to authenticated;
