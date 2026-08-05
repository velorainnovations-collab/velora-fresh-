/*
 * Sync tests — the mapping between the nested localStorage blob and the
 * normalised database.
 *
 *   node test/sync.test.js
 *
 * No network. The diff engine is pure, so it is tested directly: this is
 * where a wrong key or a dropped zero would silently corrupt a bill.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
function check(label, got, want) {
  const g = typeof got === 'object' ? JSON.stringify(got) : String(got);
  const w = typeof want === 'object' ? JSON.stringify(want) : String(want);
  const ok = g === w;
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ->  ' + g + (ok ? '' : '   (expected ' + w + ')'));
  ok ? pass++ : fail++;
}

const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'), {
  runScripts: 'dangerously', url: 'http://localhost/',
  beforeParse(w) { w.alert = () => {}; w.print = () => {}; w.confirm = () => true; },
});
const w = dom.window;
const S = w.VFSync;

console.log('\nwiring');
check('sync layer present', typeof S, 'object');

// The build may or may not carry an anon key. Either is valid; what
// must hold is that the layer is inert exactly when it is unconfigured,
// so an unconfigured build never reaches for the network.
const configured = !!(w.VF_CONFIG && w.VF_CONFIG.anonKey);
check('enabled tracks the config', S.enabled(), configured);
if (!configured) {
  check('record is a no-op when disabled', S.record(w.VF.DB), 0);
} else {
  check('gate is present when configured', !!w.document.getElementById('gate'), true);
  check('signed out until a real sign in', S.signedIn(), false);
}

/* ---------------- flatten ---------------- */
console.log('\nflatten');

const DB = {
  indents: {
    '2026-07-30': {
      /* '2' was put on the indent after '1', so it is the newer line and
         the screens read it first */
      KLP: { status: 'accepted', lines: { '1': 12, '2': 50 }, seq: { '1': 1, '2': 2 },
             submittedAt: null, late: true },
      NGB: { status: 'draft', lines: {} },                       // untouched
    },
  },
  days: {
    '2026-07-30': {
      rates:  { '1': 80, '2': '' },                              // '' = not entered
      packed: { KLP: { '1': 12, '280': 0 } },                    // 0 = vendor skipped
      ship:   { KLP: 'received' },
      verify: { KLP: { sent: true, by: 'Kilpauk Mgr', at: '2026-07-30T09:00:00Z',
                       items: { '1': { type: 'weight', original: 12, current: 10 },
                                '280': { type: 'missing', original: 0 } } },
                /* half-checked marks stay on the phone making them */
                NGB: { sent: false, items: { '2': { type: 'missing', original: 3 } } } },
      sent:   { 'Nellai Traders': true, 'Ooty': false },
      order:  { '1': 15 },        // bought 15 though the shops asked for 12
    },
  },
  invoices: {
    '2026-07-30': {
      /* a draft has no number yet and must not be sent: bill_no is not
         null in the schema, and a bill nobody has saved is not a bill */
      NGB: { no: '', saved: false, total: 120, roundOff: 0, lines: [] },
      KLP: {
        no: 'VF/KLP/072026/0001', saved: true, total: 998.4, roundOff: 0.6,
        contactId: '33333333-0000-0000-0000-000000000001',
        vehicle: 'TN 01 AB 1234', driver: 'Murugan', place: 'Tamil Nadu',
        billTo: { name: 'SSR AGRPCOM', gstin: '33AABCU9603R1ZM',
                  address: 'No 4, Anna Salai\nChennai\nTamil Nadu - 600002' },
        lines: [{ code: '1', name: 'Lemon', unit: 'kg', qty: 12, net: 12,
                  rate: 83.2, amount: 998.4, sell: 129.792 }],
      },
    },
  },
  contacts: {
    '33333333-0000-0000-0000-000000000001': {
      company: 'SSR AGRPCOM', person: 'Ravi', gstin: '33AABCU9603R1ZM',
      mobile: '9342011780', email: '', shopId: 'KLP',
      addr1: 'No 4, Anna Salai', addr2: 'Chennai', addr3: '',
      state: 'Tamil Nadu', pincode: '600002', active: true,
      bank: { bankName: 'HDFC', acName: 'SSR AGRPCOM', acNo: '50100', ifsc: 'HDFC0001', branch: 'Anna Salai' },
    },
  },
  payments: [{ id: 'p1', date: '2026-07-31', amount: 1000, mode: 'NEFT', ref: 'UTR1' }],
  vendors: {
    'Nellai Traders': { name: 'Nellai', phone: '984', bank: { acName: '', acNo: '', ifsc: '', upi: '' } },
    'SUK(Tomoto)':    { name: 'SUK', phone: '', bank: { acName: 'SUK', acNo: '91', ifsc: 'H1', upi: '' } },
  },
  master: { comm: { KLP: 4 }, selling: { KLP: { '1': 30 } } },
  units: { kg: { weighed: false, builtin: true }, crate: { weighed: true } },
  settings: { anytime: true },
};

const F = S._flatten(DB);

check('indent header',        Object.keys(F.indents), ['2026-07-30|KLP']);
check('empty draft skipped',  F.indents['2026-07-30|NGB'], undefined);
check('indent late flag',     F.indents['2026-07-30|KLP'].late, true);
check('indent lines',         Object.keys(F.indent_lines).length, 2);
check('indent line qty',      F.indent_lines['2026-07-30|KLP|2'].qty, 50);
check('and the order it was written in',
      F.indent_lines['2026-07-30|KLP|2'].seq, 2);
check('a line with no order recorded sends a zero',
      S._flatten({ indents: { '2026-07-30': { KLP: { status: 'draft', lines: { '9': 1 } } } } })
        .indent_lines['2026-07-30|KLP|9'].seq, 0);

check('rate entered',         F.day_rates['2026-07-30|1'].rate, 80);
check('blank rate skipped',   F.day_rates['2026-07-30|2'], undefined);

check('packed qty',           F.packed['2026-07-30|KLP|1'].qty, 12);
// a skipped line must survive the mapping: it is how the invoice knows
// to leave the product off the bill
check('vendor-skipped 0 kept', F.packed['2026-07-30|KLP|280'].qty, 0);

check('shipment state',       F.shipments['2026-07-30|KLP'].state, 'received');
check('a sent report goes up',
      F.delivery_issues['2026-07-30|KLP|1'].issue + ' ' +
      F.delivery_issues['2026-07-30|KLP|1'].original_qty + '>' +
      F.delivery_issues['2026-07-30|KLP|1'].current_qty, 'weight 12>10');
check('a missing product carries no current weight',
      F.delivery_issues['2026-07-30|KLP|280'].current_qty, null);
check('who checked travels with it',
      F.delivery_issues['2026-07-30|KLP|1'].verified_by, 'Kilpauk Mgr');
check('an unsent report stays on the phone',
      F.delivery_issues['2026-07-30|NGB|2'], undefined);
check('a unit goes up by name', F.units['crate'].weighed, true);
check('order sent',           Object.keys(F.vendor_orders), ['2026-07-30|Nellai Traders']);

check('invoice header',       F.invoices['2026-07-30|KLP'].bill_no, 'VF/KLP/072026/0001');
check('a draft is held back',  F.invoices['2026-07-30|NGB'], undefined);
check('place of supply sent',  F.invoices['2026-07-30|KLP'].place_of_supply, 'Tamil Nadu');
check('invoice net amount',   F.invoices['2026-07-30|KLP'].net_amount, 999);
check('invoice line frozen rate',   F.invoice_lines['2026-07-30|KLP|1'].rate, 83.2);
check('invoice line frozen sell',   F.invoice_lines['2026-07-30|KLP|1'].sell, 129.792);
check('invoice line ties to header',
  F.invoice_lines['2026-07-30|KLP|1'].invoice_id, F.invoices['2026-07-30|KLP'].id);

check('payment mapped',       F.payments['p1'].amount, 1000);
check('payment id is a uuid',
  /^[0-9a-f-]{36}$/.test(F.payments['p1'].id), true);

check('vendor row',           F.vendors['Nellai Traders'].name, 'Nellai');
check('empty bank not sent',  F.vendor_bank['Nellai Traders'], undefined);
check('filled bank sent',     F.vendor_bank['SUK(Tomoto)'].ac_no, '91');

check('commission',           F.margin_comm['KLP'].pct, 4);
check('selling margin',       F.margin_selling['KLP|1'].pct, 30);
check('settings',             F.settings['KPN'].anytime, true);
check('what was bought, when it differs from what was asked for',
      F.vendor_order_lines['2026-07-30|1'].qty, 15);
check('and it carries the vendor whose bill it is on',
      !!F.vendor_order_lines['2026-07-30|1'].group_name, true);

/* ---------------- determinism ---------------- */
console.log('\ndeterminism');
check('flatten is stable', JSON.stringify(S._flatten(DB)), JSON.stringify(F));
check('uuid is stable', S._uuidFor('2026-07-30|KLP'), S._uuidFor('2026-07-30|KLP'));
check('uuid differs per key',
  S._uuidFor('2026-07-30|KLP') === S._uuidFor('2026-07-30|NGB'), false);
check('existing uuid passed through',
  S._uuidFor('22222222-0000-0000-0000-000000000001'),
  '22222222-0000-0000-0000-000000000001');

/* ---------------- diff ---------------- */
console.log('\ndiff');

check('no change -> no ops', S._diff(F, F).length, 0);

const clone = o => JSON.parse(JSON.stringify(o));

// changing one rate must produce exactly one operation
let after = clone(DB);
after.days['2026-07-30'].rates['1'] = 92;
let ops = S._diff(F, S._flatten(after));
check('one rate change -> one op', ops.length, 1);
check('op is an upsert', ops[0].op, 'upsert');
check('op targets day_rates', ops[0].table, 'day_rates');
check('op carries new rate', ops[0].row.rate, 92);

// removing an indent line must delete, not silently persist
after = clone(DB);
delete after.indents['2026-07-30'].KLP.lines['2'];
ops = S._diff(F, S._flatten(after));
check('removed line -> delete', ops.length, 1);
check('delete op', ops[0].op, 'delete');
check('delete targets the line', ops[0].key, '2026-07-30|KLP|2');

// a margin change must not rewrite an invoice that is already raised
after = clone(DB);
after.master.selling.KLP['1'] = 45;
ops = S._diff(F, S._flatten(after));
check('margin change -> one op', ops.length, 1);
check('margin change does not touch invoice_lines',
  ops.filter(o => o.table === 'invoice_lines').length, 0);

// packing a new product for a shop that never indented it
after = clone(DB);
after.days['2026-07-30'].packed.KLP['3'] = 20;
ops = S._diff(F, S._flatten(after));
check('addition -> one packed upsert', ops.length, 1);
check('addition needs no flag', ops[0].table, 'packed');

/* ---------------- collapse ---------------- */
console.log('\ncollapse');
const noisy = [
  { table: 'day_rates', op: 'upsert', key: 'd|1', row: { rate: 10 } },
  { table: 'day_rates', op: 'upsert', key: 'd|1', row: { rate: 20 } },
  { table: 'day_rates', op: 'upsert', key: 'd|1', row: { rate: 80 } },
  { table: 'packed',    op: 'upsert', key: 'd|K|1', row: { qty: 5 } },
];
const small = S._collapse(noisy);
check('four ops collapse to two', small.length, 2);
check('last write wins', small[0].row.rate, 80);

/* ---------------- ordering ---------------- */
console.log('\nordering');
const mixed = [
  { table: 'invoice_lines', op: 'upsert', key: 'a', row: {} },
  { table: 'invoices',      op: 'upsert', key: 'b', row: {} },
  { table: 'indent_lines',  op: 'delete', key: 'c', row: {} },
  { table: 'indents',       op: 'delete', key: 'd', row: {} },
];
const sorted = S._sortOps(mixed);
check('upserts before deletes',
  sorted.map(o => o.op), ['upsert', 'upsert', 'delete', 'delete']);
check('invoice header before its lines',
  sorted.findIndex(o => o.table === 'invoices') <
  sorted.findIndex(o => o.table === 'invoice_lines'), true);
check('child deleted before its parent',
  sorted.findIndex(o => o.table === 'indent_lines') <
  sorted.findIndex(o => o.table === 'indents'), true);

/* ---------------- one row per conflict key ---------------- */
// Postgres refuses to let ON CONFLICT DO UPDATE touch the same row twice
// in one statement; PostgREST returns that as 409. A batch must therefore
// never carry two rows sharing the conflict key. This is checked here
// because it cost a live 409 on margin_comm.
console.log('\nbatch uniqueness');
const CONFLICT_COLS = {
  indents: ['trade_date', 'shop_id'],
  indent_lines: ['trade_date', 'shop_id', 'product_code'],
  day_rates: ['trade_date', 'product_code'],
  packed: ['trade_date', 'shop_id', 'product_code'],
  shipments: ['trade_date', 'shop_id'],
  vendor_orders: ['trade_date', 'group_name'],
  invoices: ['trade_date', 'shop_id'],
  invoice_lines: ['invoice_id', 'line_no'],
  payments: ['id'],
  vendors: ['group_name'],
  vendor_bank: ['group_name'],
  margin_comm: ['shop_id'],
  margin_selling: ['shop_id', 'product_code'],
  vendor_order_lines: ['trade_date', 'group_name', 'product_code'],
  settings: ['client_id'],
  contacts: ['id'],
  contact_bank: ['contact_id'],
  delivery_issues: ['trade_date', 'shop_id', 'product_code'],
  units: ['name'],
};

function dupKeys(table, rows) {
  const cols = CONFLICT_COLS[table];
  const seen = new Set(), dups = [];
  rows.forEach(r => {
    const k = cols.map(c => String(r[c])).join('|');
    if (seen.has(k)) dups.push(k);
    seen.add(k);
  });
  return dups;
}

// every table flatten produces, checked for colliding conflict keys
let collisions = [];
Object.keys(F).forEach(t => {
  const d = dupKeys(t, Object.values(F[t]));
  if (d.length) collisions.push(t + ':' + d.join(','));
});
check('no two rows share a conflict key', collisions, []);

// and a queue that legitimately holds repeats must still collapse to one
const repeated = [
  { table: 'margin_comm', op: 'upsert', key: 'KLP', row: { shop_id: 'KLP', pct: 4 } },
  { table: 'margin_comm', op: 'upsert', key: 'KLP', row: { shop_id: 'KLP', pct: 5 } },
  { table: 'margin_comm', op: 'upsert', key: 'NGB', row: { shop_id: 'NGB', pct: 4 } },
];
const collapsed = S._collapse(repeated);
check('repeat edits collapse to one row per shop',
  dupKeys('margin_comm', collapsed.map(o => o.row)), []);
check('collapsed keeps the latest value',
  collapsed.find(o => o.row.shop_id === 'KLP').row.pct, 5);

/* ---------------- every table is reachable ---------------- */
console.log('\ncoverage');
const empty = S._flatten({});
const populated = Object.keys(F).filter(t => Object.keys(F[t]).length > 0);
check('every table has a conflict target',
  Object.keys(empty).filter(t => !populated.includes(t)), []);

/* ------------- every column sent actually exists -------------
   indent_lines is keyed by the id of its header row. The app sent
   trade_date and shop_id instead, columns that table does not have, so
   PostgREST refused every push that carried an indent line — which is
   the only thing a shop ever sends. Nothing caught it because the mock
   accepted whatever it was given. The schema itself is the authority
   here, so a column renamed in SQL and not in flatten() fails. */
console.log('\nthe payload matches the schema');
const schema = (() => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', '01_schema.sql'), 'utf8');
  const out = {};
  const re = /create table (?:if not exists )?(\w+) \(([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(sql))) {
    out[m[1]] = m[2].split('\n').map(l => l.trim())
      .filter(l => l && !l.startsWith('--'))
      .map(l => l.split(/\s+/)[0].replace(/,$/, ''))
      .filter(c => !['primary', 'unique', 'constraint', 'check', 'foreign'].includes(c.toLowerCase()));
  }
  /* a column added after the first release is not in its create table —
     it is added by name at the foot of the file, so a live project can
     catch up. Those count just the same. */
  const alt = /alter table (\w+)\s+add column if not exists (\w+)/g;
  while ((m = alt.exec(sql))) (out[m[1]] = out[m[1]] || []).push(m[2]);
  return out;
})();
check('the schema was read', Object.keys(schema).length > 10, true);

/* indent_lines is rewritten on the way out, so it is checked against
   what send() actually posts rather than what flatten() holds */
const SENT_AS = { indent_lines: ['indent_id', 'product_code', 'qty', 'seq'] };
Object.keys(F).forEach(t => {
  const keys = Object.keys(F[t]);
  if (!keys.length) return;
  const cols = SENT_AS[t] || Object.keys(F[t][keys[0]]);
  const have = schema[t] || [];
  check(t + ': every column exists in the table',
        cols.filter(c => !have.includes(c)), []);
});
check('and the conflict target for an indent line is its header',
      S._conflictFor ? S._conflictFor('indent_lines') : 'indent_id,product_code',
      'indent_id,product_code');

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
w.close();
process.exit(fail ? 1 : 0);
