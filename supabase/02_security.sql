-- ============================================================
-- Velora Fresh — auth, RLS and the functions that guard money
--
-- Roles (docs/README "Roles"):
--   owner  Velora  everything; only role that records payments,
--                  edits margins, or sees vendor bank details
--   admin  Velora  the day; no margins, no payments, no bank details
--   ho     client  indents (may edit), invoices, accounts — read-only
--                  on money; no selling price, no cost
--   shop   client  its own indent, deliveries, bills and balance
--
-- Isolation is enforced here, in the database, not in the interface.
-- ============================================================

-- ------------------------------------------------------------
-- auth.uid() shim for local testing.
--
-- On Supabase, schema `auth` and auth.uid() already exist and this
-- block is skipped. Locally it reads the same JWT claim Supabase sets,
-- so the policies below are exercised exactly as they will run live.
-- ------------------------------------------------------------
create schema if not exists auth;

do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'uid'
  ) then
    execute $fn$
      create function auth.uid() returns uuid language sql stable as $body$
        -- nullif the setting *before* the cast: '' is not valid json
        select nullif(
                 nullif(current_setting('request.jwt.claims', true), '')::json->>'sub',
                 ''
               )::uuid
      $body$;
    $fn$;
  end if;
end $$;

-- ------------------------------------------------------------
-- who is asking
-- ------------------------------------------------------------

create type app_role as enum ('owner','admin','ho','shop');

-- One row per login. Deactivate, never delete: past indents must stay
-- attached to whoever entered them (docs/ROADMAP.md, "Real logins").
create table app_users (
  id         uuid primary key,                       -- auth.users.id on Supabase
  phone      text not null unique,
  full_name  text not null default '',
  role       app_role not null,
  client_id  text references clients(id) on delete restrict,
  shop_id    text references shops(id) on delete restrict,
  active     boolean not null default true,
  -- PIN is for shop staff on shared phones. Owner authenticates with a
  -- real password through Supabase Auth and has no PIN here.
  pin_hash   text,
  pin_tries  smallint not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),

  constraint shop_role_has_shop check (role <> 'shop' or shop_id is not null),
  constraint client_roles_have_client check (role in ('owner','admin') or client_id is not null)
);
create index on app_users (client_id);

-- Helpers. STABLE so the planner caches them per statement; each reads
-- only the caller's own row, so they are safe as SECURITY DEFINER.
create or replace function current_app_user()
returns app_users language sql stable security definer set search_path = public as $$
  select * from app_users where id = auth.uid() and active
$$;

create or replace function current_role_name() returns app_role
language sql stable security definer set search_path = public as $$
  select role from app_users where id = auth.uid() and active
$$;

create or replace function current_client() returns text
language sql stable security definer set search_path = public as $$
  select client_id from app_users where id = auth.uid() and active
$$;

create or replace function current_shop() returns text
language sql stable security definer set search_path = public as $$
  select shop_id from app_users where id = auth.uid() and active
$$;

create or replace function is_velora() returns boolean
language sql stable as $$ select current_role_name() in ('owner','admin') $$;

create or replace function is_owner() returns boolean
language sql stable as $$ select current_role_name() = 'owner' $$;

-- Does the caller have any business seeing this shop?
create or replace function may_see_shop(p_shop text) returns boolean
language sql stable security definer set search_path = public as $$
  select case current_role_name()
    when 'owner' then true
    when 'admin' then true
    when 'ho'    then exists (select 1 from shops s where s.id = p_shop and s.client_id = current_client())
    when 'shop'  then p_shop = current_shop()
    else false
  end
$$;

-- ------------------------------------------------------------
-- pricing, as functions
--
-- Admin runs the day but must not read the commission percentage.
-- purchase_rate() is SECURITY DEFINER: it returns the resulting rate
-- without exposing the margin behind it. The invoice already shows
-- that rate, so nothing new leaks — but margin_comm stays owner-only.
-- ------------------------------------------------------------

create or replace function purchase_rate(p_shop text, p_code text, p_date date)
returns numeric language sql stable security definer set search_path = public as $$
  select case
    when not may_see_shop(p_shop) then null
    else (select r.rate * (1 + coalesce(m.pct, c.comm_pct, 0) / 100)
            from day_rates r
            join shops s on s.id = p_shop
            join clients c on c.id = s.client_id
            left join margin_comm m on m.shop_id = p_shop
           where r.trade_date = p_date and r.product_code = p_code)
  end
$$;

-- Selling price is the shop's shelf price. Head office must not see it
-- (README: "No selling price, no cost"), so this returns null for them.
create or replace function selling_price(p_shop text, p_code text, p_date date)
returns numeric language sql stable security definer set search_path = public as $$
  select case
    when current_role_name() = 'ho' then null
    when not may_see_shop(p_shop) then null
    else (select purchase_rate(p_shop, p_code, p_date) * (1 + coalesce(ms.pct, 0) / 100)
            from (select 1) _
            left join margin_selling ms on ms.shop_id = p_shop and ms.product_code = p_code)
  end
$$;

-- ------------------------------------------------------------
-- bill numbers, issued inside a transaction
--
-- docs/DATA_MODEL.md: "On a server this must be issued inside a
-- transaction, or two devices generating at once will collide."
-- The insert..on conflict..do update takes a row lock, so a second
-- caller blocks until the first commits and then reads the new value.
-- ------------------------------------------------------------

create or replace function next_bill_no(p_shop text, p_date date)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_period text := to_char(p_date, 'MMYYYY');
  v_prefix text;
  v_n      integer;
begin
  -- insufficient_privilege so PostgREST answers 403, not 500
  if not is_velora() then
    raise exception 'only Velora may issue bill numbers'
      using errcode = 'insufficient_privilege';
  end if;

  select prefix into v_prefix from shops where id = p_shop;
  if v_prefix is null then
    raise exception 'unknown shop %', p_shop;
  end if;

  insert into bill_serial (shop_id, period, n)
       values (p_shop, v_period, 1)
  on conflict (shop_id, period)
    do update set n = bill_serial.n + 1
    returning n into v_n;

  return v_prefix || '/' || v_period || '/' || lpad(v_n::text, 4, '0');
end $$;

-- ------------------------------------------------------------
-- enable RLS everywhere
--
-- Forgetting this on one table is the single most common way a
-- Supabase project leaks. The check at the bottom of this file fails
-- loudly if any table is left unprotected.
-- ------------------------------------------------------------

do $$
declare t text;
begin
  for t in
    select tablename from pg_tables
     where schemaname = 'public' and tablename <> 'schema_migrations'
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

-- ---------- reference data: readable by any signed-in user ----------

create policy read_products      on products      for select using (auth.uid() is not null);
create policy read_groups        on vendor_groups for select using (auth.uid() is not null);
create policy read_prodgroups    on product_groups for select using (auth.uid() is not null);
create policy write_products     on products      for all using (is_velora()) with check (is_velora());
create policy write_groups       on vendor_groups for all using (is_velora()) with check (is_velora());
create policy write_prodgroups   on product_groups for all using (is_velora()) with check (is_velora());

-- ---------- clients and shops ----------

create policy read_clients on clients for select
  using (is_velora() or id = current_client());
create policy write_clients on clients for all
  using (is_owner()) with check (is_owner());

create policy read_shops on shops for select
  using (is_velora() or client_id = current_client());
create policy write_shops on shops for all
  using (is_owner()) with check (is_owner());

-- ---------- app_users ----------
-- A user may read their own row. Only the owner may see or change the rest.
create policy read_self on app_users for select
  using (id = auth.uid() or is_owner());
create policy write_users on app_users for all
  using (is_owner()) with check (is_owner());

-- ---------- vendors ----------
-- Velora only. The client side of the chain has no business seeing
-- who Velora buys from.
create policy read_vendors  on vendors for select using (is_velora());
create policy write_vendors on vendors for all using (is_velora()) with check (is_velora());

-- Bank details: owner alone. Admin is explicitly excluded.
create policy owner_bank on vendor_bank for all
  using (is_owner()) with check (is_owner());

-- ---------- margins: owner alone ----------
create policy owner_comm on margin_comm for all
  using (is_owner()) with check (is_owner());
create policy owner_selling on margin_selling for all
  using (is_owner()) with check (is_owner());

-- ---------- indents ----------
-- Shop: its own. Head office: any shop in its chain, and may edit on a
-- shop's behalf. Velora: all.
create policy read_indents on indents for select using (may_see_shop(shop_id));

-- Who may still change an indent depends on its state
-- (docs/WORKFLOW.md, "Indent states"):
--   draft/submitted  the shop and its head office
--   accepted         Velora only
create policy write_indents on indents for all
  using (
    case
      when is_velora() then true
      when current_role_name() in ('shop','ho')
        then may_see_shop(shop_id) and status in ('draft','submitted')
      else false
    end
  )
  with check (
    case
      when is_velora() then true
      when current_role_name() in ('shop','ho')
        then may_see_shop(shop_id) and status in ('draft','submitted')
      else false
    end
  );

create policy rw_indent_lines on indent_lines for all
  using (exists (select 1 from indents i where i.id = indent_id and may_see_shop(i.shop_id)))
  with check (exists (
    select 1 from indents i
     where i.id = indent_id
       and may_see_shop(i.shop_id)
       and (is_velora() or i.status in ('draft','submitted'))
  ));

-- ---------- rates: Velora writes, and only Velora reads ----------
-- The market rate is Velora's cost base. README: head office sees
-- "no cost".
create policy read_rates  on day_rates for select using (is_velora());
create policy write_rates on day_rates for all using (is_velora()) with check (is_velora());

-- ---------- packing and delivery ----------
-- The shop may read what was packed for it; only Velora may write.
create policy read_packed  on packed for select using (may_see_shop(shop_id));
create policy write_packed on packed for all using (is_velora()) with check (is_velora());

create policy read_ship on shipments for select using (may_see_shop(shop_id));
-- Velora marks out for delivery; the shop confirms receipt itself.
create policy write_ship on shipments for all
  using (is_velora() or (current_role_name() = 'shop' and shop_id = current_shop()))
  with check (is_velora() or (current_role_name() = 'shop' and shop_id = current_shop()));

create policy rw_vendor_orders on vendor_orders for all
  using (is_velora()) with check (is_velora());

-- ---------- invoices ----------
create policy read_invoices on invoices for select using (may_see_shop(shop_id));
create policy write_invoices on invoices for all
  using (is_velora()) with check (is_velora());

create policy read_invoice_lines on invoice_lines for select
  using (exists (select 1 from invoices i where i.id = invoice_id and may_see_shop(i.shop_id)));
create policy write_invoice_lines on invoice_lines for all
  using (is_velora()) with check (is_velora());

-- ---------- payments ----------
-- Chain level. Head office and shops see the ledger, and can change
-- nothing. Only the Velora owner records a payment.
create policy read_payments on payments for select
  using (is_velora() or client_id = current_client());
create policy write_payments on payments for all
  using (is_owner()) with check (is_owner());

-- ---------- serials and settings ----------
create policy no_direct_serial on bill_serial for select using (is_owner());
-- writes go through next_bill_no() only

create policy read_settings on settings for select
  using (is_velora() or client_id = current_client());
create policy write_settings on settings for all
  using (is_velora()) with check (is_velora());

-- ------------------------------------------------------------
-- roles and grants
--
-- Supabase already has anon and authenticated; this creates them
-- locally so the policies are tested under the same roles that run
-- in production. Superusers bypass RLS entirely, which is exactly why
-- the tests must not connect as postgres.
-- ------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
end $$;

grant usage on schema public, auth to anon, authenticated;

-- anon gets nothing but the ability to attempt a login. Every table is
-- reachable only after authenticating, and then only through RLS.
grant select, insert, update, delete on all tables in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
grant execute on function auth.uid() to anon, authenticated;

-- bill_serial is never touched directly — next_bill_no() owns it
revoke insert, update, delete on bill_serial from authenticated;

-- ------------------------------------------------------------
-- fail loudly if a table was left unprotected
-- ------------------------------------------------------------
do $$
declare bad text;
begin
  select string_agg(c.relname, ', ') into bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if bad is not null then
    raise exception 'RLS is not enabled on: %', bad;
  end if;

  select string_agg(c.relname, ', ') into bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and not exists (select 1 from pg_policy p where p.polrelid = c.oid);
  if bad is not null then
    raise exception 'RLS enabled but no policy on: %', bad;
  end if;
end $$;
