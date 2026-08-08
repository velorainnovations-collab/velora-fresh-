-- ============================================================
-- Velora Fresh — user management tests
--
--   psql -d vf -f supabase/test_users.sql
--
-- Run after test_security.sql loads. Checks that an owner can hand out
-- tags from the app, that nobody else can, that signing up without an
-- invite grants nothing, and that an owner cannot lock the business
-- out by demoting themselves.
-- ============================================================

\set ON_ERROR_STOP on
\pset pager off

create temp table r2 (n serial, label text, got text, want text);
grant all on r2 to authenticated;
grant usage, select, update on sequence r2_n_seq to authenticated;

create or replace function t2(p_label text, p_got text, p_want text) returns void
language plpgsql as $$
begin insert into r2 (label, got, want) values (p_label, p_got, p_want); end $$;

-- Same helpers as test_security.sql, repeated so this suite stands alone.
create or replace function login(p_uid text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid)::text, false);
end $$;

create or replace function cnt(p_sql text) returns integer language plpgsql as $$
declare n integer;
begin
  execute p_sql into n;
  return n;
exception when insufficient_privilege then
  return -1;
end $$;

create or replace function try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception
  when insufficient_privilege then return 'blocked';
  when check_violation        then return 'refused';
  when others                 then return 'error:' || sqlstate;
end $$;

\set OWNER '''00000000-0000-0000-0000-00000000000a'''
\set ADMIN '''00000000-0000-0000-0000-00000000000b'''
\set KLPU  '''00000000-0000-0000-0000-00000000000d'''

set role authenticated;

-- ============================================================
-- only an owner may add people
-- ============================================================
select login(:ADMIN);
select t2('admin cannot invite',
  try($$select invite_person('shop','Sneaky','9111111111',null,'KPN','KLP')$$), 'blocked');

select login(:KLPU);
select t2('shop cannot invite',
  try($$select invite_person('owner','Sneaky',null,'x@y.com',null,null)$$), 'blocked');
select t2('shop sees no people list', cnt('select count(*) from list_people()')::text, '0');

select login(:OWNER);
select t2('owner can invite a manager',
  try($$select invite_person('admin','New Manager','9222222222')$$), 'ok');
select t2('owner can invite a shopkeeper',
  try($$select invite_person('shop','Mambakkam Mgr','9333333333',null,'KPN','MBK')$$), 'ok');
select t2('owner can invite another owner',
  try($$select invite_person('owner','Second Owner',null,'owner2@velora.example')$$), 'ok');

-- shape rules are enforced at invite time, not after signup
-- (the check constraint raises check_violation, which try() reports as refused)
select t2('shop invite needs a shop',
  try($$select invite_person('shop','No Shop','9444444444')$$), 'refused');

-- ============================================================
-- signing up links the invite and applies the tag
-- ============================================================
reset role;
insert into auth.users (id, phone) values
  ('00000000-0000-0000-0000-0000000000b1', '9222222222');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000b2', 'owner2@velora.example');
-- nobody invited this one
insert into auth.users (id, phone) values
  ('00000000-0000-0000-0000-0000000000b3', '9999999999');
set role authenticated;

select login(:OWNER);
select t2('invited manager got the admin tag',
  (select role::text from app_users where id = '00000000-0000-0000-0000-0000000000b1'), 'admin');
select t2('invited owner got the owner tag',
  (select role::text from app_users where id = '00000000-0000-0000-0000-0000000000b2'), 'owner');
select t2('uninvited signup gets no row',
  (select count(*)::text from app_users where id = '00000000-0000-0000-0000-0000000000b3'), '0');
select t2('invite marked used',
  (select count(*)::text from user_invites where phone = '9222222222' and used_at is not null), '1');
select t2('unused invite still listed',
  (select count(*)::text from list_people() where kind = 'invite'), '1');

-- the uninvited account can sign in and see nothing at all
select login('00000000-0000-0000-0000-0000000000b3');
select t2('uninvited user sees no shops',    cnt('select count(*) from shops')::text, '0');
select t2('uninvited user sees no invoices', cnt('select count(*) from invoices')::text, '0');
select t2('uninvited user has no role',      coalesce(current_role_name()::text,'null'), 'null');

-- the new owner really does have full control
select login('00000000-0000-0000-0000-0000000000b2');
select t2('new owner sees bank details', cnt('select count(*) from vendor_bank')::text, '1');
select t2('new owner can invite',
  try($$select invite_person('admin','Third Person','9555555555')$$), 'ok');

-- the new manager has the admin limits, not owner
select login('00000000-0000-0000-0000-0000000000b1');
select t2('new manager cannot see bank details', cnt('select count(*) from vendor_bank')::text, '0');
select t2('new manager cannot see margins',      cnt('select count(*) from margin_comm')::text, '0');
select t2('new manager runs the day',            cnt('select count(*) from day_rates')::text, '2');
select t2('new manager cannot invite',
  try($$select invite_person('owner','Nope',null,'nope@x.com')$$), 'blocked');

-- ============================================================
-- changing tags
-- ============================================================
select login(:OWNER);
select t2('owner can promote a manager',
  try($$select set_person_role('00000000-0000-0000-0000-0000000000b1','owner')$$), 'ok');
select t2('promoted user is now owner',
  (select role::text from app_users where id = '00000000-0000-0000-0000-0000000000b1'), 'owner');
select t2('owner can demote again',
  try($$select set_person_role('00000000-0000-0000-0000-0000000000b1','admin')$$), 'ok');

-- the business must not be able to lock itself out
-- quote_literal: :OWNER expands to a quoted literal, and those quotes are
-- consumed by the concatenation, leaving the uuid bare in the built SQL
select t2('owner cannot demote themselves',
  try('select set_person_role(' || quote_literal(:OWNER) || ',''admin'')'), 'refused');
select t2('owner cannot deactivate themselves',
  try('select set_person_active(' || quote_literal(:OWNER) || ',false)'), 'refused');

select t2('owner can deactivate someone else',
  try($$select set_person_active('00000000-0000-0000-0000-0000000000b1',false)$$), 'ok');
select login('00000000-0000-0000-0000-0000000000b1');
select t2('deactivated person sees nothing', cnt('select count(*) from day_rates')::text, '0');

select login(:OWNER);
select t2('owner can cancel an unused invite',
  try($$select cancel_invite((select id from user_invites where used_at is null limit 1))$$), 'ok');

-- ============================================================
-- a deactivated login frees its phone number
--
-- The number belongs to whoever holds it now. Deactivating is the
-- app's normal way of removing somebody, and before the partial index
-- their number stayed locked to a row everyone thought was gone —
-- "phone already exists" with nobody visible holding it.
-- ============================================================
reset role;
insert into app_users (id, phone, full_name, role, client_id, shop_id, active) values
  ('00000000-0000-0000-0000-0000000000c1','9876543210','Old Manager','shop','KPN','KLP',true);
update app_users set active = false where id = '00000000-0000-0000-0000-0000000000c1';

select t2('the number can be given to their replacement',
  try($$insert into app_users (id, phone, full_name, role, client_id, shop_id, active) values
        ('00000000-0000-0000-0000-0000000000c2','9876543210','New Manager','shop','KPN','KLP',true)$$),
  'ok');
select t2('two active logins may not share it',
  try($$insert into app_users (id, phone, full_name, role, client_id, shop_id, active) values
        ('00000000-0000-0000-0000-0000000000c3','9876543210','Third','shop','KPN','KLP',true)$$),
  'error:23505');
select t2('and waking the old login is refused while the number is taken',
  try($$update app_users set active = true
        where id = '00000000-0000-0000-0000-0000000000c1'$$),
  'error:23505');
set role authenticated;

-- ============================================================
-- results
-- ============================================================
reset role;

select n, label,
       case when got is not distinct from want then 'ok' else 'FAIL' end as res,
       got, want
  from r2 order by n;

select count(*) filter (where got is not distinct from want) as passed,
       count(*) filter (where got is distinct from want)     as failed
  from r2;

do $$
declare f integer;
begin
  select count(*) into f from r2 where got is distinct from want;
  if f > 0 then raise exception '% user test(s) FAILED', f; end if;
end $$;
