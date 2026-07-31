-- ============================================================
-- Velora Fresh — production seed
--
-- Your real client, shops and settings. No test users, no test
-- trading day. Run this INSTEAD of 03_seed.sql when going live.
--
-- Order:  01_schema  ->  02_security  ->  04_catalogue  ->  05_production
--
-- Safe to re-run: every insert upserts.
-- ============================================================

-- ---------- the client ----------
-- comm_pct is the default commission; a per-shop figure in margin_comm
-- overrides it. Edit the name if it should read differently on a bill.
insert into clients (id, name, comm_pct, bill_prefix, cutoff) values
  ('KPN', 'Kalpaviruksha Pazhamudir Nilayam', 4, 'VF', '21:00')
on conflict (id) do update set name        = excluded.name,
                               comm_pct    = excluded.comm_pct,
                               bill_prefix = excluded.bill_prefix,
                               cutoff      = excluded.cutoff;

-- ---------- shops ----------
insert into shops (id, client_id, name, prefix) values
  ('KLP', 'KPN', 'Kilpauk',      'VF/KLP'),
  ('NGB', 'KPN', 'Nungambakkam', 'VF/NGB'),
  ('SHN', 'KPN', 'Shenoy Nagar', 'VF/SHN'),
  ('MBK', 'KPN', 'Mambakkam',    'VF/MBK'),
  ('HRN', 'KPN', 'Hiranandani',  'VF/HRN')
on conflict (id) do update set name   = excluded.name,
                               prefix = excluded.prefix;

-- ---------- commission per shop ----------
-- 4% for every shop today. Change a single shop here without touching
-- the others; bills already raised keep the rate frozen on the line.
insert into margin_comm (shop_id, pct) values
  ('KLP', 4), ('NGB', 4), ('SHN', 4), ('MBK', 4), ('HRN', 4)
on conflict (shop_id) do update set pct = excluded.pct;

-- ---------- settings ----------
-- anytime = false enforces the 6 pm / 9 pm / 11:30 pm indent window.
-- Set it true only while testing.
insert into settings (client_id, anytime) values ('KPN', false)
on conflict (client_id) do update set anytime = excluded.anytime;

-- ---------- selling margins ----------
-- Left empty on purpose. The owner is sending an Excel with one tab per
-- shop (docs/ROADMAP.md, open questions). Until it arrives, a product
-- with no row here sells at cost, which is visible rather than silently
-- wrong. Load it with:
--
--   insert into margin_selling (shop_id, product_code, pct) values
--     ('KLP', '1', 30), ('KLP', '2', 26)
--   on conflict (shop_id, product_code) do update set pct = excluded.pct;

-- ============================================================
-- Users are NOT seeded here.
--
-- Every row in app_users.id must match a real Supabase Auth user, so
-- the account has to exist first:
--
--   1. Authentication -> Users -> Add user
--      Owner and admin: email + a strong password.
--      Shop staff: phone number.
--   2. Copy the new user's UID.
--   3. Insert the matching row, for example:
--
--      insert into app_users (id, phone, full_name, role, client_id, shop_id)
--      values ('<paste-uid>', '9840000000', 'Full Name',
--              'owner',  null,  null);      -- Velora owner
--
--      role      client_id   shop_id
--      owner     null        null
--      admin     null        null
--      ho        'KPN'       null
--      shop      'KPN'       'KLP'
--
-- A user with no app_users row can sign in and see nothing at all —
-- every policy resolves to false. That is the intended default.
--
-- To remove someone, deactivate rather than delete, so past indents
-- stay attached to whoever entered them:
--
--   update app_users set active = false where phone = '9840000000';
-- ============================================================
