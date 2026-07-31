-- ============================================================
-- Velora Fresh — seed for local testing
--
-- One client, five shops, a handful of products, and one login per
-- role. Fixed UUIDs so the security tests can impersonate them.
-- Not for production: real users arrive through Supabase Auth.
-- ============================================================

insert into clients (id, name, comm_pct, bill_prefix) values
  ('KPN', 'Kalpaviruksha Pazhamudir Nilayam', 4, 'VF');

insert into shops (id, client_id, name, prefix) values
  ('KLP', 'KPN', 'Kilpauk',      'VF/KLP'),
  ('NGB', 'KPN', 'Nungambakkam', 'VF/NGB'),
  ('SHN', 'KPN', 'Shenoy Nagar', 'VF/SHN'),
  ('MMB', 'KPN', 'Mambakkam',    'VF/MMB'),
  ('HIR', 'KPN', 'Hiranandani',  'VF/HIR');

insert into products (code, name, tamil, unit, unit_weight_kg) values
  ('1',   'Lemon',           'லெமன்',            'kg',  1),
  ('2',   'Potato',          'உருளை',            'kg',  1),
  ('3',   'Cabbage',         'கோஸ்',             'kg',  1),
  ('23',  'Country Tomato',  'நாட்டு தக்காளி',    'kg',  1),
  ('28',  'Coriander',       'மல்லி',            'piece', null),
  ('280', 'Strawberry',      'ஸ்டராபெரி',        'box', null),
  ('303', 'Apple Washington','ஆப்பிள் வாஷிங்டன்', 'box', 20);

insert into vendor_groups (name, manual, sort_ord) values
  ('Others',          true,  1),
  ('Nellai Traders',  false, 2),
  ('ASR(Coriander)',  false, 3),
  ('SUK(Tomoto)',     false, 4),
  ('Manual order',    true,  9);

insert into product_groups (product_code, group_name) values
  ('1',   'Others'),
  ('2',   'Nellai Traders'),
  ('3',   'Nellai Traders'),
  ('23',  'SUK(Tomoto)'),
  ('28',  'ASR(Coriander)'),
  ('280', 'Manual order'),
  ('303', 'Manual order');

insert into vendors (group_name, name, phone) values
  ('Nellai Traders', 'Nellai Traders', '9840000001'),
  ('SUK(Tomoto)',    'SUK Traders',    '9840000002');

insert into vendor_bank (group_name, ac_name, ac_no, ifsc, upi) values
  ('Nellai Traders', 'Nellai Traders', '918273645500', 'HDFC0000123', 'nellai@upi');

insert into margin_comm (shop_id, pct) values ('KLP', 4), ('NGB', 4);
insert into margin_selling (shop_id, product_code, pct) values
  ('KLP', '1', 30), ('KLP', '2', 26), ('KLP', '3', 28);

insert into settings (client_id, anytime) values ('KPN', true);

-- ---------- logins, one per role ----------
insert into app_users (id, phone, full_name, role, client_id, shop_id) values
  ('00000000-0000-0000-0000-00000000000a', '9000000001', 'Velora Owner',  'owner', null,  null),
  ('00000000-0000-0000-0000-00000000000b', '9000000002', 'Velora Admin',  'admin', null,  null),
  ('00000000-0000-0000-0000-00000000000c', '9000000003', 'KPN Head Off',  'ho',    'KPN', null),
  ('00000000-0000-0000-0000-00000000000d', '9000000004', 'Kilpauk Mgr',   'shop',  'KPN', 'KLP'),
  ('00000000-0000-0000-0000-00000000000e', '9000000005', 'Nungambakkam',  'shop',  'KPN', 'NGB'),
  ('00000000-0000-0000-0000-00000000000f', '9000000006', 'Left The Job',  'shop',  'KPN', 'SHN');

-- deactivated: past indents stay attached, but access stops
update app_users set active = false where id = '00000000-0000-0000-0000-00000000000f';

-- ---------- one trading day ----------
insert into indents (id, trade_date, shop_id, status, submitted_at) values
  ('11111111-0000-0000-0000-000000000001', date '2026-07-30', 'KLP', 'accepted', now()),
  ('11111111-0000-0000-0000-000000000002', date '2026-07-30', 'NGB', 'submitted', now());

insert into indent_lines (indent_id, product_code, qty) values
  ('11111111-0000-0000-0000-000000000001', '1', 12),
  ('11111111-0000-0000-0000-000000000001', '2', 50),
  ('11111111-0000-0000-0000-000000000002', '1', 8);

insert into day_rates (trade_date, product_code, rate) values
  (date '2026-07-30', '1', 80),
  (date '2026-07-30', '2', 27);

insert into packed (trade_date, shop_id, product_code, qty) values
  (date '2026-07-30', 'KLP', '1', 12),
  (date '2026-07-30', 'KLP', '2', 42);

insert into shipments (trade_date, shop_id, state, out_at, received_at) values
  (date '2026-07-30', 'KLP', 'received', now(), now());

insert into invoices (id, bill_no, trade_date, shop_id, total, round_off, net_amount) values
  ('22222222-0000-0000-0000-000000000001', 'VF/KLP/072026/0001', date '2026-07-30', 'KLP', 2177.76, 0.24, 2178.00);

insert into invoice_lines (invoice_id, line_no, product_code, name, unit, qty, net_kg, rate, amount, sell) values
  ('22222222-0000-0000-0000-000000000001', 1, '1', 'Lemon',  'kg', 12, 12, 83.2000,  998.40, 129.7920),
  ('22222222-0000-0000-0000-000000000001', 2, '2', 'Potato', 'kg', 42, 42, 28.0800, 1179.36,  35.3808);

insert into payments (client_id, paid_on, amount, mode, ref) values
  ('KPN', date '2026-07-31', 1000, 'NEFT', 'UTR8891');
