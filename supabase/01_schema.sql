-- ============================================================
-- Velora Fresh — supply desk schema
--
-- Mirrors docs/DATA_MODEL.md. The localStorage shape is a nested
-- object keyed by date; here it is normalised, because every item
-- on the reporting roadmap (rate history, consumption per shop,
-- fill rate, margin, ageing) is a query over these tables.
--
-- Run order: 01_schema.sql, 02_security.sql, 03_seed.sql
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- tenancy ----------

create table clients (
  id          text primary key,
  name        text not null,
  comm_pct    numeric(6,3) not null default 4,      -- default, overridden per shop
  bill_prefix text not null default 'VF',
  cutoff      time not null default '21:00',
  created_at  timestamptz not null default now()
);

create table shops (
  id        text primary key,
  client_id text not null references clients(id) on delete restrict,
  name      text not null,
  prefix    text not null,
  active    boolean not null default true
);
create index on shops (client_id);

-- ---------- catalogue ----------

create table products (
  code           text primary key,
  name           text not null,
  tamil          text not null default '',
  unit           text not null default 'kg',
  unit_weight_kg numeric(10,3),                     -- null = no weight on file
  alias          text not null default ''
);

create table vendor_groups (
  name     text primary key,
  manual   boolean not null default false,          -- placed by hand, app only marks it
  sort_ord integer not null default 0
);

-- A product belongs to exactly one group. There is no backup vendor.
-- Unique on product_code enforces that; anything unmapped falls to
-- 'Manual order' by the resolver in 02_security.sql.
create table product_groups (
  product_code text primary key references products(code) on delete cascade,
  group_name   text not null references vendor_groups(name) on delete restrict
);
create index on product_groups (group_name);

create table vendors (
  group_name text primary key references vendor_groups(name) on delete cascade,
  name       text not null default '',
  phone      text not null default '',
  contact    text not null default '',
  address    text not null default '',
  notes      text not null default ''
);

-- Bank details are a separate table, not columns on `vendors`, because
-- RLS is row-level: a policy cannot hide a column. Owner-only access is
-- enforced by giving this table its own policy.
create table vendor_bank (
  group_name text primary key references vendor_groups(name) on delete cascade,
  ac_name    text not null default '',
  ac_no      text not null default '',
  ifsc       text not null default '',
  upi        text not null default ''
);

-- ---------- margins (owner only) ----------

create table margin_comm (
  shop_id text primary key references shops(id) on delete cascade,
  pct     numeric(6,3) not null default 4
);

create table margin_selling (
  shop_id      text not null references shops(id) on delete cascade,
  product_code text not null references products(code) on delete cascade,
  pct          numeric(6,3) not null,
  primary key (shop_id, product_code)
);

-- ---------- the trading day ----------

create type indent_status as enum ('draft','submitted','accepted');

create table indents (
  id           uuid primary key default gen_random_uuid(),
  trade_date   date not null,
  shop_id      text not null references shops(id) on delete cascade,
  status       indent_status not null default 'draft',
  submitted_at timestamptz,
  -- when it was closed, and by whom. Accepted is final
  -- (02_security.sql), so this is the moment the row became the record
  -- of what was ordered. The name is stored rather than the id because
  -- the shop is shown it, and a shop may not read app_users.
  accepted_at      timestamptz,
  accepted_by_name text not null default '',
  late         boolean not null default false,
  unique (trade_date, shop_id)
);
create index on indents (trade_date);

create table indent_lines (
  indent_id    uuid not null references indents(id) on delete cascade,
  product_code text not null references products(code) on delete restrict,
  qty          numeric(12,3) not null check (qty >= 0),
  primary key (indent_id, product_code)
);

-- Market rate: entered once per product per day, same for every shop.
create table day_rates (
  trade_date   date not null,
  product_code text not null references products(code) on delete restrict,
  rate         numeric(12,4) not null check (rate >= 0),
  primary key (trade_date, product_code)
);

-- Packed quantity, per shop. 0 means the vendor skipped it on quality —
-- a skipped line must not reach the invoice. A packed row with no matching
-- indent line is an addition, by definition; no flag is stored.
create table packed (
  trade_date   date not null,
  shop_id      text not null references shops(id) on delete cascade,
  product_code text not null references products(code) on delete restrict,
  qty          numeric(12,3) not null check (qty >= 0),
  primary key (trade_date, shop_id, product_code)
);

create type ship_state as enum ('out','received');

create table shipments (
  trade_date  date not null,
  shop_id     text not null references shops(id) on delete cascade,
  state       ship_state not null,
  out_at      timestamptz,
  received_at timestamptz,
  primary key (trade_date, shop_id)
);

create table vendor_orders (
  trade_date date not null,
  group_name text not null references vendor_groups(name) on delete cascade,
  sent_at    timestamptz not null default now(),
  primary key (trade_date, group_name)
);

-- What is actually bought, when it differs from the sum of the indents.
-- A vendor sells by the crate and a rate is better for ten kilos than
-- for seven, so the quantity ordered is not always the quantity asked
-- for. Only the difference is stored: no row means buy exactly what the
-- shops asked for. The shops' own lines are never touched by this —
-- packing still divides whatever arrives between them.
create table vendor_order_lines (
  trade_date   date not null,
  group_name   text not null references vendor_groups(name) on delete cascade,
  product_code text not null references products(code) on delete restrict,
  qty          numeric(12,3) not null check (qty >= 0),
  primary key (trade_date, group_name, product_code)
);

-- ---------- invoices ----------

create table invoices (
  id         uuid primary key default gen_random_uuid(),
  bill_no    text not null unique,
  trade_date date not null,
  shop_id    text not null references shops(id) on delete restrict,
  total      numeric(14,2) not null,
  round_off  numeric(6,2) not null default 0,
  net_amount numeric(14,2) not null,
  created_at timestamptz not null default now(),
  unique (trade_date, shop_id)
);
create index on invoices (shop_id, trade_date);

-- Frozen by design: rate, amount and sell are stored values, never
-- recomputed from margin_comm / margin_selling. Changing a margin must
-- not re-price a bill that has already been raised.
-- See docs/DATA_MODEL.md, "Invoice lines are frozen".
create table invoice_lines (
  invoice_id   uuid not null references invoices(id) on delete cascade,
  line_no      integer not null,
  product_code text not null,
  name         text not null,
  tamil        text not null default '',
  unit         text not null,
  qty          numeric(12,3) not null,
  net_kg       numeric(12,3) not null,
  rate         numeric(12,4) not null,   -- market x (1 + commission%), frozen
  amount       numeric(14,2) not null,   -- frozen
  sell         numeric(12,4) not null,   -- shelf price, frozen
  primary key (invoice_id, line_no)
);

-- ---------- money ----------

-- Payments are recorded at chain level, not per shop: the client owner
-- pays one amount for all his shops.
create table payments (
  id         uuid primary key default gen_random_uuid(),
  client_id  text not null references clients(id) on delete restrict,
  paid_on    date not null,
  amount     numeric(14,2) not null check (amount > 0),
  mode       text not null default 'NEFT',
  ref        text not null default '',
  created_at timestamptz not null default now()
);
create index on payments (client_id, paid_on);

-- No allocation table on purpose. Settlement is recomputed from bill
-- order and total received every time it is displayed, so it cannot
-- drift and correcting a mistyped payment re-settles everything.

-- ---------- bill numbers ----------

-- Incremented locally today; on a server it must be issued inside a
-- transaction or two devices generating at once will collide.
-- See next_bill_no() in 02_security.sql.
create table bill_serial (
  shop_id text not null references shops(id) on delete cascade,
  period  text not null,                  -- MMYYYY
  n       integer not null default 0,
  primary key (shop_id, period)
);

-- ---------- settings ----------

create table settings (
  client_id text primary key references clients(id) on delete cascade,
  anytime   boolean not null default false   -- ignore the indent window
);
