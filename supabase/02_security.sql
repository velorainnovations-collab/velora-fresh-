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

-- This file is meant to be run again whenever it changes — a new
-- function, a tightened policy — on a project that already has data.
-- So everything in it either replaces what is there or steps over it.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'app_role') then
    create type app_role as enum ('owner','admin','ho','shop');
  end if;
end $$;

-- One row per login. Deactivate, never delete: past indents must stay
-- attached to whoever entered them (docs/ROADMAP.md, "Real logins").
create table if not exists app_users (
  id         uuid primary key,                       -- auth.users.id on Supabase
  -- Nullable: shop staff sign in by phone, but owner and admin sign in
  -- with email and password, so a phone would be noise on those rows.
  -- Unique still holds for the rows that have one — Postgres allows
  -- many nulls in a unique index.
  phone      text unique,
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
  constraint client_roles_have_client check (role in ('owner','admin') or client_id is not null),
  -- shop staff sign in by phone, so that row must carry one
  constraint shop_role_has_phone check (role <> 'shop' or phone is not null)
);
create index if not exists app_users_client_id_idx on app_users (client_id);

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

-- Every rate a shop was charged on one day, in one call.
--
-- purchase_rate() answers for a single product, which is fine for a
-- line being looked at and hopeless for a screen listing two hundred.
-- Same rule, same SECURITY DEFINER reasoning: the resulting rate is
-- returned, never the market rate or the margin behind it.
create or replace function purchase_rates_on(p_shop text, p_date date)
returns table (product_code text, rate numeric)
language sql stable security definer set search_path = public as $$
  select r.product_code,
         r.rate * (1 + coalesce(m.pct, c.comm_pct, 0) / 100)
    from day_rates r
    join shops s on s.id = p_shop
    join clients c on c.id = s.client_id
    left join margin_comm m on m.shop_id = p_shop
   where r.trade_date = p_date
     and may_see_shop(p_shop)
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
-- clearing a day, for testing
--
-- TEMPORARY. Delete this function and its grant before the desk is
-- used for real trading — see the same note on TESTING_TOOLS in
-- src/template.html. It exists so that a day of test data can be thrown
-- away from any login, not only the office's: while the flow is being
-- tried out, whoever is holding the phone needs to be able to start the
-- day again.
--
-- It is SECURITY DEFINER because that is the whole point. Row level
-- security lets a shop delete its own indent and nothing else, so a
-- shop clearing a day by itself would leave the rates, the packing and
-- the bill behind and the day would come back half full on the next
-- refresh. This clears the lot, in one transaction, for anyone signed
-- in. It is deliberately narrow: one date, only the tables a trading
-- day is made of, and never the catalogue, the shops or the people.
create or replace function wipe_day(p_date date)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = 'insufficient_privilege';
  end if;

  -- children before parents where there is no cascade to rely on
  delete from indent_lines  where indent_id in (select id from indents where trade_date = p_date);
  delete from indents       where trade_date = p_date;
  delete from day_rates     where trade_date = p_date;
  delete from packed        where trade_date = p_date;
  delete from shipments     where trade_date = p_date;
  delete from delivery_issues where trade_date = p_date;
  delete from vendor_order_lines where trade_date = p_date;
  delete from vendor_orders      where trade_date = p_date;
  -- invoice_lines follow their invoice on delete cascade
  delete from invoices           where trade_date = p_date;
  -- payments are chain level and dated by when they were paid, not by a
  -- trading day, so they are none of this function's business
end;
$$;

-- ------------------------------------------------------------
-- renaming a vendor group
--
-- The group name is its own key, and five tables point at it. Postgres
-- will not let it be edited in place — the foreign keys are declared
-- without `on update cascade`, deliberately, so that a stray update
-- cannot orphan a year of orders. So the rename is done the long way:
-- the new name is added, everything is moved onto it, the old name is
-- dropped. All in one transaction, so it either all happens or none of
-- it does.
--
-- SECURITY DEFINER because of vendor_bank. Row level security hides
-- those rows from an admin, and a row you cannot see is a row you
-- cannot move; the delete at the end would then take the vendor's bank
-- details with it. Running as the owner of the function keeps them.
-- is_velora() below is the real guard.
-- ------------------------------------------------------------
create or replace function rename_group(p_old text, p_new text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_velora() then
    raise exception 'only Velora may rename a vendor group'
      using errcode = 'insufficient_privilege';
  end if;

  p_new := btrim(coalesce(p_new, ''));
  if p_new = '' then
    raise exception 'a vendor group needs a name';
  end if;
  if p_old = p_new then
    return;                                   -- nothing asked for
  end if;
  if not exists (select 1 from vendor_groups where name = p_old) then
    raise exception 'there is no vendor group called %', p_old;
  end if;
  if exists (select 1 from vendor_groups where name = p_new) then
    raise exception 'there is already a vendor group called %', p_new;
  end if;

  insert into vendor_groups (name, manual, sort_ord)
       select p_new, manual, sort_ord from vendor_groups where name = p_old;

  update vendors            set group_name = p_new where group_name = p_old;
  update vendor_bank        set group_name = p_new where group_name = p_old;
  update product_groups     set group_name = p_new where group_name = p_old;
  update vendor_orders      set group_name = p_new where group_name = p_old;
  update vendor_order_lines set group_name = p_new where group_name = p_old;

  -- nothing references the old name now, so this takes the row alone
  delete from vendor_groups where name = p_old;
end $$;

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

-- ------------------------------------------------------------
-- clear the old policies before writing them again
--
-- `create policy` has no `or replace`, so without this the second run
-- of this file stops on the first line below and nothing in it — not a
-- new function, not a corrected policy — ever reaches the database.
--
-- Dropping them all is safe because this file is the whole of the
-- rule book: every table gets its policies back a few lines down, and
-- the check at the end of the file refuses to finish if one does not.
-- The SQL editor runs the file in a single transaction, so a failure
-- part way through leaves the old rules exactly as they were.
-- ------------------------------------------------------------

do $$
declare r record;
begin
  for r in select tablename, policyname from pg_policies
            where schemaname = 'public'
              -- 06_users.sql makes this table and its policy, and runs
              -- after this file. Dropping its rules here would leave it
              -- unprotected, and the check at the end of this file
              -- would rightly refuse to finish.
              and tablename <> 'user_invites'
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
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

-- ---------- units: read by anyone signed in, kept by Velora ----------
create policy read_units  on units for select using (auth.uid() is not null);
create policy write_units on units for all using (is_velora()) with check (is_velora());

-- ---------- delivery verification ----------
-- The shop reports on its own delivery and nobody else's; the office
-- reads every report and clears them once the packing is put right.
create policy read_issues on delivery_issues for select using (may_see_shop(shop_id));
create policy write_issues on delivery_issues for all
  using (is_velora() or (current_role_name() = 'shop' and shop_id = current_shop()))
  with check (is_velora() or (current_role_name() = 'shop' and shop_id = current_shop()));

-- ---------- contacts: who a bill is made out to ----------
-- Velora keeps them and only the owner edits them, the same as the
-- margin master they sit beside. A chain may read its own — the company
-- name, GST number and delivery address on the contact are the client's
-- own details, and a shop reading them learns nothing it did not give.
create policy read_contacts on contacts for select
  using (is_velora() or client_id = current_client());
create policy write_contacts on contacts for all
  using (is_owner()) with check (is_owner());

-- Bank details: owner alone, for the same reason as vendor_bank.
create policy owner_contact_bank on contact_bank for all
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
--   draft/submitted  the shop, its head office, and Velora
--   accepted         nobody, bar an owner
--
-- Accepted is final. The vendor orders were placed on the strength of
-- it and the shop was told what it is getting, so a quantity that moves
-- afterwards makes the bill disagree with the packing slip. USING says
-- which existing rows may be touched; WITH CHECK says what they may be
-- turned into. Accepting is therefore still allowed — the row being
-- changed is 'submitted' at the time — while changing it afterwards is
-- not, for the office as much as for the shop.
--
-- The owner is the administrative override, and the only one: correcting
-- a mistake in a closed indent is their call to make and to answer for.
create policy write_indents on indents for all
  using (
    case
      when is_owner() then true
      when is_velora() then status in ('draft','submitted')
      when current_role_name() in ('shop','ho')
        then may_see_shop(shop_id) and status in ('draft','submitted')
      else false
    end
  )
  with check (
    case
      when is_owner() then true
      when is_velora() then true
      when current_role_name() in ('shop','ho')
        then may_see_shop(shop_id) and status in ('draft','submitted')
      else false
    end
  );

-- A line follows its header: once the indent is accepted its lines are
-- the record too, and only an owner may touch them.
create policy rw_indent_lines on indent_lines for all
  using (exists (
    select 1 from indents i
     where i.id = indent_id
       and may_see_shop(i.shop_id)
       and (is_owner() or i.status in ('draft','submitted'))
  ))
  with check (exists (
    select 1 from indents i
     where i.id = indent_id
       and may_see_shop(i.shop_id)
       and (is_owner() or i.status in ('draft','submitted'))
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

-- What is bought is Velora's business and its cost base: a shop asked
-- for a quantity, it does not decide what is purchased.
create policy rw_vendor_order_lines on vendor_order_lines for all
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
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

-- anon gets nothing but the ability to attempt a login. Every table is
-- reachable only after authenticating, and then only through RLS.
grant select, insert, update, delete on all tables in schema public to authenticated;
grant execute on all functions in schema public to authenticated;

-- service_role is what the edge functions hold. It bypasses RLS, but a
-- grant is a separate thing from a policy: without this it is refused at
-- the table before any policy is consulted, and the function comes back
-- with "permission denied for table app_users". Supabase's own default
-- privileges usually cover this; they do not survive a schema built by
-- hand, so it is stated here rather than assumed.
grant select, insert, update, delete on all tables in schema public to service_role;
grant execute on all functions in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- and for anything added later
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public
  grant execute on functions to service_role;

-- On Supabase the auth schema belongs to supabase_auth_admin and these
-- grants are already in place, so a permission error here is expected
-- and harmless. Locally they are needed.
do $$
begin
  execute 'grant usage on schema auth to anon, authenticated';
  execute 'grant execute on function auth.uid() to anon, authenticated';
exception when insufficient_privilege or dependent_privilege_descriptors_still_exist then
  raise notice 'auth schema grants skipped (already managed by Supabase)';
end $$;

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
