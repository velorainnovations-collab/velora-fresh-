-- ============================================================
-- Velora Fresh — security tests
--
--   psql -d vf -f supabase/test_security.sql
--
-- Every test signs in as a real role through the `authenticated`
-- Postgres role and the same auth.uid() claim Supabase sets, then
-- tries to reach something it should not. A leak fails the run.
--
-- Superusers bypass RLS, so this must never be run as postgres
-- without the `set role authenticated` below.
-- ============================================================

\set ON_ERROR_STOP on
\pset pager off

create temp table results (n serial, label text, got text, want text);
-- the tests run as `authenticated`, so it must be able to log results
grant all on results to authenticated;
grant usage, select, update on sequence results_n_seq to authenticated;

create or replace function t(p_label text, p_got text, p_want text) returns void
language plpgsql as $$
begin
  insert into results (label, got, want) values (p_label, p_got, p_want);
end $$;

-- sign in as a given app user
create or replace function login(p_uid text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid)::text, false);
end $$;

create or replace function logout() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', false);
end $$;

-- count rows a role can see, swallowing permission errors as -1
create or replace function cnt(p_sql text) returns integer language plpgsql as $$
declare n integer;
begin
  execute p_sql into n;
  return n;
exception when insufficient_privilege then
  return -1;
end $$;

\set OWNER '''00000000-0000-0000-0000-00000000000a'''
\set ADMIN '''00000000-0000-0000-0000-00000000000b'''
\set HO    '''00000000-0000-0000-0000-00000000000c'''
\set KLP   '''00000000-0000-0000-0000-00000000000d'''
\set NGB   '''00000000-0000-0000-0000-00000000000e'''
\set GONE  '''00000000-0000-0000-0000-00000000000f'''

set role authenticated;

-- ============================================================
-- 1. anonymous
-- ============================================================
select logout();
select t('anon sees no shops',    cnt('select count(*) from shops')::text,   '0');
select t('anon sees no invoices', cnt('select count(*) from invoices')::text,'0');
select t('anon sees no products', cnt('select count(*) from products')::text,'0');
select t('anon sees no payments', cnt('select count(*) from payments')::text,'0');

-- ============================================================
-- 2. shop isolation — the core promise
-- ============================================================
select login(:KLP);
select t('shop sees own invoice',        cnt($$select count(*) from invoices where shop_id='KLP'$$)::text, '1');
select t('shop cannot see other bills',  cnt($$select count(*) from invoices where shop_id<>'KLP'$$)::text, '0');
select t('shop cannot see other indent', cnt($$select count(*) from indents where shop_id='NGB'$$)::text, '0');
select t('shop cannot see other packed', cnt($$select count(*) from packed where shop_id='NGB'$$)::text, '0');
select t('shop sees own invoice lines',  cnt($$select count(*) from invoice_lines$$)::text, '2');

-- the other shop, mirrored
select login(:NGB);
select t('other shop sees no KLP bill',  cnt($$select count(*) from invoices where shop_id='KLP'$$)::text, '0');

-- ============================================================
-- 3. cost and margin must not reach the client side
-- ============================================================
select login(:KLP);
select t('shop cannot read market rates', cnt('select count(*) from day_rates')::text,      '0');
select t('shop cannot read margins',      cnt('select count(*) from margin_comm')::text,    '0');
select t('shop cannot read selling pct',  cnt('select count(*) from margin_selling')::text, '0');
select t('shop cannot read vendors',      cnt('select count(*) from vendors')::text,        '0');
select t('shop cannot read bank details', cnt('select count(*) from vendor_bank')::text,    '0');

select login(:HO);
select t('head office cannot read rates', cnt('select count(*) from day_rates')::text,      '0');
select t('head office cannot read bank',  cnt('select count(*) from vendor_bank')::text,    '0');
select t('head office cannot read margin',cnt('select count(*) from margin_selling')::text, '0');
select t('head office sees chain bills',  cnt('select count(*) from invoices')::text,       '1');
select t('head office sees the ledger',   cnt('select count(*) from payments')::text,       '1');

-- ============================================================
-- 4. admin is trusted with the day, not with the money
-- ============================================================
select login(:ADMIN);
select t('admin runs the day',            cnt('select count(*) from day_rates')::text,      '2');
select t('admin sees vendors',            cnt('select count(*) from vendors')::text,        '2');
select t('admin CANNOT see bank details', cnt('select count(*) from vendor_bank')::text,    '0');
select t('admin CANNOT see commission',   cnt('select count(*) from margin_comm')::text,    '0');
select t('admin CANNOT see selling pct',  cnt('select count(*) from margin_selling')::text, '0');

-- ...but still needs the resulting rate, via the definer function
select t('admin gets purchase rate', round(purchase_rate('KLP','1',date '2026-07-30'),2)::text, '83.20');

select login(:OWNER);
select t('owner sees bank details',       cnt('select count(*) from vendor_bank')::text,    '1');
select t('owner sees commission',         cnt('select count(*) from margin_comm')::text,    '2');

-- ============================================================
-- 5. selling price is hidden from head office
-- ============================================================
select login(:OWNER);
select t('owner sees selling price', round(selling_price('KLP','1',date '2026-07-30'),2)::text, '108.16');
select login(:HO);
select t('head office selling price is null', coalesce(selling_price('KLP','1',date '2026-07-30')::text,'null'), 'null');

-- ============================================================
-- 6. writes
-- ============================================================
select login(:KLP);
select t('shop cannot write rates',
  (select case when cnt($$with x as (insert into day_rates (trade_date,product_code,rate)
        values (date '2026-07-30','3',34) on conflict do nothing returning 1)
     select count(*) from x$$) <= 0 then 'blocked' else 'LEAKED' end), 'blocked');

select t('shop cannot edit accepted indent',
  (select case when cnt($$with x as (update indents set status='draft'
        where shop_id='KLP' and trade_date=date '2026-07-30' returning 1)
     select count(*) from x$$) <= 0 then 'blocked' else 'LEAKED' end), 'blocked');

select t('shop cannot record a payment',
  (select case when cnt($$with x as (insert into payments (client_id,paid_on,amount)
        values ('KPN', current_date, 1) returning 1)
     select count(*) from x$$) <= 0 then 'blocked' else 'LEAKED' end), 'blocked');

select login(:HO);
select t('head office cannot record a payment',
  (select case when cnt($$with x as (insert into payments (client_id,paid_on,amount)
        values ('KPN', current_date, 1) returning 1)
     select count(*) from x$$) <= 0 then 'blocked' else 'LEAKED' end), 'blocked');

select login(:ADMIN);
select t('admin cannot record a payment',
  (select case when cnt($$with x as (insert into payments (client_id,paid_on,amount)
        values ('KPN', current_date, 1) returning 1)
     select count(*) from x$$) <= 0 then 'blocked' else 'LEAKED' end), 'blocked');

select login(:OWNER);
select t('owner can record a payment',
  (select case when cnt($$with x as (insert into payments (client_id,paid_on,amount,mode,ref)
        values ('KPN', current_date, 500, 'UPI', 'T1') returning 1)
     select count(*) from x$$) = 1 then 'ok' else 'BLOCKED' end), 'ok');

-- head office may enter an indent on a shop's behalf (WORKFLOW.md)
select login(:HO);
select t('head office may edit a submitted indent',
  (select case when cnt($$with x as (update indents set late=false
        where shop_id='NGB' and status='submitted' returning 1)
     select count(*) from x$$) = 1 then 'ok' else 'BLOCKED' end), 'ok');

-- ============================================================
-- 7. deactivated user keeps history but loses access
-- ============================================================
select login(:GONE);
select t('deactivated user sees nothing', cnt('select count(*) from invoices')::text, '0');
select t('deactivated user has no role',  coalesce(current_role_name()::text,'null'), 'null');

-- ============================================================
-- 8. bill numbers
-- ============================================================
select login(:ADMIN);
select t('bill no format',   next_bill_no('NGB', date '2026-07-30'), 'VF/NGB/072026/0001');
select t('bill no advances', next_bill_no('NGB', date '2026-07-30'), 'VF/NGB/072026/0002');
select t('bill no per month',next_bill_no('NGB', date '2026-08-01'), 'VF/NGB/082026/0001');

select login(:KLP);
select t('shop cannot issue a bill number',
  (select case when cnt($$select 1 from (select next_bill_no('KLP', current_date)) _$$) <= 0
    then 'blocked' else 'LEAKED' end), 'blocked');

-- ============================================================
-- 9. service_role — the key the edge functions hold
--
-- It bypasses RLS, but a grant is a separate thing from a policy: with
-- no grant it is refused at the table before any policy is consulted,
-- and create-user comes back with "permission denied for table
-- app_users" no matter how correct the key is.
-- ============================================================
reset role;
grant all on results to service_role;
grant usage, select, update on sequence results_n_seq to service_role;
set role service_role;

select t('edge functions may read app_users',
  (select case when cnt('select count(*) from app_users') >= 0 then 'ok' else 'BLOCKED' end), 'ok');
select t('edge functions see every row, not one client',
  (select case when cnt('select count(*) from app_users') >= 6 then 'ok' else 'FILTERED' end), 'ok');
select t('edge functions may create a login',
  (select case when cnt($$with x as (insert into app_users (id, full_name, role)
        values ('00000000-0000-0000-0000-0000000000ff','Edge Made','admin') returning 1)
     select count(*) from x$$) = 1 then 'ok' else 'BLOCKED' end), 'ok');
select t('and remove one it could not finish',
  (select case when cnt($$with x as (delete from app_users
        where id = '00000000-0000-0000-0000-0000000000ff' returning 1)
     select count(*) from x$$) = 1 then 'ok' else 'BLOCKED' end), 'ok');

-- ============================================================
-- results
-- ============================================================
-- 10. accepted is final
--
-- The vendor orders were placed on the strength of it and the shop was
-- told what it is getting, so a quantity that moves afterwards makes
-- the bill disagree with the packing slip. The office is not an
-- exception; the owner is, because correcting a closed indent is their
-- call to make and to answer for.
--
-- The seeded indents are already accepted, so this works on one of its
-- own: a fresh day, submitted, then closed.
-- ============================================================
set role authenticated;
select login(:ADMIN);

select t('a manager may put up a submitted indent',
  (select case when cnt($$with x as (insert into indents (trade_date, shop_id, status)
        values ('2026-09-09','KLP','submitted') returning 1) select count(*) from x$$) = 1
          then 'ok' else 'REFUSED' end), 'ok');

select t('and may change it while it is submitted',
  (select case when cnt($$with x as (update indents set late = true
                                      where trade_date = '2026-09-09' and shop_id = 'KLP'
                                      returning 1) select count(*) from x$$) = 1
          then 'ok' else 'REFUSED' end), 'ok');

select t('a manager may accept it',
  (select case when cnt($$with x as (update indents set status = 'accepted'
                                      where trade_date = '2026-09-09' and shop_id = 'KLP'
                                      returning 1) select count(*) from x$$) = 1
          then 'ok' else 'REFUSED' end), 'ok');

select t('but not change it afterwards',
  (select case when cnt($$with x as (update indents set late = false
                                      where trade_date = '2026-09-09' and shop_id = 'KLP'
                                      returning 1) select count(*) from x$$) = 0
          then 'ok' else 'CHANGED' end), 'ok');

select t('nor add a line to it',
  (select case when cnt($$with x as (insert into indent_lines (indent_id, product_code, qty)
        select id, '1', 5 from indents
         where trade_date = '2026-09-09' and shop_id = 'KLP' returning 1)
     select count(*) from x$$) < 1
          then 'ok' else 'ADDED' end), 'ok');

select login(:KLP);
select t('and the shop certainly cannot reopen it',
  (select case when cnt($$with x as (update indents set status = 'submitted'
                                      where trade_date = '2026-09-09' and shop_id = 'KLP'
                                      returning 1) select count(*) from x$$) = 0
          then 'ok' else 'CHANGED' end), 'ok');

select login(:OWNER);
select t('the owner is the one override',
  (select case when cnt($$with x as (update indents set late = false
                                      where trade_date = '2026-09-09' and shop_id = 'KLP'
                                      returning 1) select count(*) from x$$) = 1
          then 'ok' else 'REFUSED' end), 'ok');

-- ============================================================
-- 11. clearing a day, for testing
--
-- TEMPORARY, with wipe_day() itself: delete this section when the
-- function goes. While the flow is being tried out, any login must be
-- able to throw a test day away — a shop clearing only its own indent
-- would leave the rates, the packing and the bill behind and the day
-- would come back half full on the next refresh.
-- ============================================================
set role authenticated;
select login(:ADMIN);

select t('a day is set up to be thrown away',
  (select case when cnt($$with x as (insert into indents (trade_date, shop_id, status)
        values ('2026-09-10','KLP','accepted') returning 1) select count(*) from x$$) = 1
          then 'ok' else 'REFUSED' end), 'ok');
select t('with a market rate on it',
  (select case when cnt($$with x as (insert into day_rates (trade_date, product_code, rate)
        values ('2026-09-10','1',60) returning 1) select count(*) from x$$) = 1
          then 'ok' else 'REFUSED' end), 'ok');
select t('and something packed against it',
  (select case when cnt($$with x as (insert into packed (trade_date, shop_id, product_code, qty)
        values ('2026-09-10','KLP','1',4) returning 1) select count(*) from x$$) = 1
          then 'ok' else 'REFUSED' end), 'ok');

select login(:KLP);
select t('on its own a shop cannot delete the market rate',
  (select case when cnt($$with x as (delete from day_rates where trade_date = '2026-09-10'
                                      returning 1) select count(*) from x$$) = 0
          then 'ok' else 'DELETED' end), 'ok');
select t('nor the packing',
  (select case when cnt($$with x as (delete from packed where trade_date = '2026-09-10'
                                      returning 1) select count(*) from x$$) = 0
          then 'ok' else 'DELETED' end), 'ok');

select t('but it may clear the whole day through the function',
  (select case when cnt($$with x as (select wipe_day('2026-09-10')) select count(*) from x$$) = 1
          then 'ok' else 'REFUSED' end), 'ok');

select login(:ADMIN);
select t('the indent is gone',
  (select case when cnt($$select count(*) from indents where trade_date = '2026-09-10'$$) = 0
          then 'ok' else 'LEFT' end), 'ok');
select t('the market rate with it',
  (select case when cnt($$select count(*) from day_rates where trade_date = '2026-09-10'$$) = 0
          then 'ok' else 'LEFT' end), 'ok');
select t('and the packing too',
  (select case when cnt($$select count(*) from packed where trade_date = '2026-09-10'$$) = 0
          then 'ok' else 'LEFT' end), 'ok');
select t('while the day beside it is untouched',
  (select case when cnt($$select count(*) from indents where trade_date = '2026-09-09'$$) = 1
          then 'ok' else 'TOUCHED' end), 'ok');

-- ============================================================
reset role;

select n, label,
       case when got is not distinct from want then 'ok' else 'FAIL' end as res,
       got, want
  from results order by n;

select count(*) filter (where got is not distinct from want) as passed,
       count(*) filter (where got is distinct from want)     as failed
  from results;

do $$
declare f integer;
begin
  select count(*) into f from results where got is distinct from want;
  if f > 0 then
    raise exception '% security test(s) FAILED', f;
  end if;
end $$;
