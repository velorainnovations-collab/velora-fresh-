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

-- run something for its effect. 'refused' is the policy or the guard
-- saying no, which is a pass in some tests; 'error' is anything else,
-- reported rather than allowed to stop the run.
create or replace function try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception
  when insufficient_privilege then return 'refused';
  when others then return 'error';
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
-- 12. renaming a vendor group
--
-- The name is the key and five tables point at it, so the rename is
-- only ever right if everything moves together. What is checked here is
-- that it does: the products, the vendor, the bank details a role that
-- called it cannot even see, and orders already placed. And that a shop
-- cannot do it at all.
-- ============================================================
set role authenticated;
select login(:OWNER);

select t('a group to rename',
  try($$insert into vendor_groups (name, manual, sort_ord) values ('Hosur', false, 7)$$), 'ok');
select t('with a vendor on it',
  try($$insert into vendors (group_name, name, phone)
        values ('Hosur','Hosur Traders','919000000001')$$), 'ok');
select t('bank details only the owner can see',
  try($$insert into vendor_bank (group_name, ac_name, ac_no)
        values ('Hosur','Hosur Traders','1234567890')$$), 'ok');
select t('a product filed under it',
  try($$insert into product_groups (product_code, group_name) values ('1','Hosur')
        on conflict (product_code) do update set group_name = 'Hosur'$$), 'ok');
select t('and an order already placed',
  try($$insert into vendor_orders (trade_date, group_name) values ('2026-09-11','Hosur')$$), 'ok');

select login(:KLP);
select t('a shop may not rename a group',
  try($$select rename_group('Hosur','Shop Renamed')$$), 'refused');

-- an admin cannot see vendor_bank, which is exactly why the function is
-- SECURITY DEFINER: the details must travel even when the caller is
-- blind to them
select login(:ADMIN);
select t('an admin may rename one',
  try($$select rename_group('Hosur','Krishnagiri')$$), 'ok');

select t('the old name is gone',
  (select case when cnt($$select count(*) from vendor_groups where name = 'Hosur'$$) = 0
          then 'ok' else 'LEFT' end), 'ok');
select t('the product moved across',
  (select case when cnt($$select count(*) from product_groups
        where product_code = '1' and group_name = 'Krishnagiri'$$) = 1
          then 'ok' else 'LOST' end), 'ok');
select t('the vendor moved across',
  (select case when cnt($$select count(*) from vendors where group_name = 'Krishnagiri'$$) = 1
          then 'ok' else 'LOST' end), 'ok');
select t('the order moved across',
  (select case when cnt($$select count(*) from vendor_orders
        where trade_date = '2026-09-11' and group_name = 'Krishnagiri'$$) = 1
          then 'ok' else 'LOST' end), 'ok');

select login(:OWNER);
select t('and the bank details went with it, unseen by the admin',
  (select case when cnt($$select count(*) from vendor_bank
        where group_name = 'Krishnagiri' and ac_no = '1234567890'$$) = 1
          then 'ok' else 'LOST' end), 'ok');
select t('a name already in use is refused',
  try($$select rename_group('Krishnagiri','Nellai Traders')$$), 'error');
select t('and the group is still called what it was',
  (select case when cnt($$select count(*) from vendor_groups where name = 'Krishnagiri'$$) = 1
          then 'ok' else 'LOST' end), 'ok');
select t('an empty name is refused too',
  try($$select rename_group('Krishnagiri','   ')$$), 'error');

-- ============================================================
-- 13. removing a product
--
-- The catalogue is Velora's, so the client side cannot touch it. And a
-- product that a trading day still points at cannot be removed at all:
-- an indent, a rate, a packing line or a vendor order referencing a
-- product that is no longer there could not be priced or billed.
--
-- A bill already raised is the exception that proves it. invoice_lines
-- keeps its own copy of the name, unit and rate and has no foreign key
-- back to products, precisely so that a catalogue tidied up in October
-- cannot change what a customer was charged in July.
-- ============================================================
set role authenticated;

select login(:KLP);
select t('a shop may not remove a product',
  (select case when cnt($$with x as (delete from products where code = '303' returning 1)
        select count(*) from x$$) = 0 then 'ok' else 'DELETED' end), 'ok');

select login(:ADMIN);
select t('nor may Velora, while a day still points at it',
  try($$delete from products where code = '1'$$), 'error');
select t('and the day is still intact',
  (select case when cnt($$select count(*) from day_rates where product_code = '1'$$) = 1
          then 'ok' else 'LOST' end), 'ok');

select t('one no day points at goes',
  try($$delete from products where code = '303'$$), 'ok');
select t('its group mapping went with it',
  (select case when cnt($$select count(*) from product_groups where product_code = '303'$$) = 0
          then 'ok' else 'LEFT' end), 'ok');

select login(:KLP);
select t('and a bill already raised still reads the same',
  (select case when cnt($$select count(*) from invoice_lines where product_code = '1'$$) = 1
          then 'ok' else 'LOST' end), 'ok');

-- ============================================================
-- 14. the contact master
--
-- The customer's own details, kept once and printed on every bill.
-- Velora keeps them and only the owner edits them; a chain may read its
-- own, because the company name, GST number and delivery address on a
-- contact are the client's own details and it learns nothing it did not
-- give. Bank details are the owner's alone, the same as a vendor's.
-- ============================================================
set role authenticated;
select login(:OWNER);

select t('the owner adds a contact',
  try($$insert into contacts (id, client_id, shop_id, company_name, gstin, addr1, state, pincode)
        values ('44444444-0000-0000-0000-000000000001','KPN','KLP','SSR AGRPCOM',
                '33AABCU9603R1ZM','No 4, Anna Salai','Tamil Nadu','600002')$$), 'ok');
select t('with bank details',
  try($$insert into contact_bank (contact_id, bank_name, ac_no, ifsc)
        values ('44444444-0000-0000-0000-000000000001','HDFC','50100','HDFC0001')$$), 'ok');

select login(:ADMIN);
select t('an admin may read one, to make a bill out',
  cnt($$select count(*) from contacts where company_name = 'SSR AGRPCOM'$$)::text, '1');
select t('but may not edit it',
  (select case when cnt($$with x as (update contacts set company_name = 'Changed'
        where company_name = 'SSR AGRPCOM' returning 1) select count(*) from x$$) = 0
          then 'ok' else 'CHANGED' end), 'ok');
select t('and cannot see its bank details',
  cnt('select count(*) from contact_bank')::text, '0');

select login(:KLP);
select t('a shop sees its own chain''s contact',
  cnt($$select count(*) from contacts$$)::text, '1');
select t('and no bank details at all',
  cnt('select count(*) from contact_bank')::text, '0');
-- an insert the policy refuses raises, where an update or a delete just
-- matches nothing, so this one is asked a different way
select t('nor may it add one',
  try($$insert into contacts (client_id, company_name) values ('KPN','Sneaky')$$), 'refused');

select login(:OWNER);
select t('a bill can be made out to it',
  try($$update invoices set contact_id = '44444444-0000-0000-0000-000000000001',
            vehicle_no = 'TN 01 AB 1234', driver_name = 'Murugan',
            bill_to_name = 'SSR AGRPCOM', bill_to_gstin = '33AABCU9603R1ZM',
            bill_to_address = 'No 4, Anna Salai'
        where bill_no = 'VF/KLP/072026/0001'$$), 'ok');
-- on delete set null, deliberately: the bill does not need the contact
-- row to survive, because it kept its own copy of what it printed
select t('the contact can be deleted outright',
  try($$delete from contacts where id = '44444444-0000-0000-0000-000000000001'$$), 'ok');
select t('and the bill still says who it was for',
  (select case when cnt($$select count(*) from invoices
        where bill_no = 'VF/KLP/072026/0001' and bill_to_name = 'SSR AGRPCOM'$$) = 1
          then 'ok' else 'LOST' end), 'ok');

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
