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
      KLP: { status: 'accepted', lines: { '1': 12, '2': 50 }, submittedAt: null, late: true },
      NGB: { status: 'draft', lines: {} },                       // untouched
    },
  },
  days: {
    '2026-07-30': {
      rates:  { '1': 80, '2': '' },                              // '' = not entered
      packed: { KLP: { '1': 12, '280': 0 } },                    // 0 = vendor skipped
      ship:   { KLP: 'received' },
      sent:   { 'Nellai Traders': true, 'Ooty': false },
    },
  },
  invoices: {
    '2026-07-30': {
      KLP: {
        no: 'VF/KLP/072026/0001', total: 998.4, roundOff: 0.6,
        lines: [{ code: '1', name: 'Lemon', unit: 'kg', qty: 12, net: 12,
                  rate: 83.2, amount: 998.4, sell: 129.792 }],
      },
    },
  },
  payments: [{ id: 'p1', date: '2026-07-31', amount: 1000, mode: 'NEFT', ref: 'UTR1' }],
  vendors: {
    'Nellai Traders': { name: 'Nellai', phone: '984', bank: { acName: '', acNo: '', ifsc: '', upi: '' } },
    'SUK(Tomoto)':    { name: 'SUK', phone: '', bank: { acName: 'SUK', acNo: '91', ifsc: 'H1', upi: '' } },
  },
  master: { comm: { KLP: 4 }, selling: { KLP: { '1': 30 } } },
  settings: { anytime: true },
};

const F = S._flatten(DB);

check('indent header',        Object.keys(F.indents), ['2026-07-30|KLP']);
check('empty draft skipped',  F.indents['2026-07-30|NGB'], undefined);
check('indent late flag',     F.indents['2026-07-30|KLP'].late, true);
check('indent lines',         Object.keys(F.indent_lines).length, 2);
check('indent line qty',      F.indent_lines['2026-07-30|KLP|2'].qty, 50);

check('rate entered',         F.day_rates['2026-07-30|1'].rate, 80);
check('blank rate skipped',   F.day_rates['2026-07-30|2'], undefined);

check('packed qty',           F.packed['2026-07-30|KLP|1'].qty, 12);
// a skipped line must survive the mapping: it is how the invoice knows
// to leave the product off the bill
check('vendor-skipped 0 kept', F.packed['2026-07-30|KLP|280'].qty, 0);

check('shipment state',       F.shipments['2026-07-30|KLP'].state, 'received');
check('order sent',           Object.keys(F.vendor_orders), ['2026-07-30|Nellai Traders']);

check('invoice header',       F.invoices['2026-07-30|KLP'].bill_no, 'VF/KLP/072026/0001');
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

/* ---------------- every table is reachable ---------------- */
console.log('\ncoverage');
const empty = S._flatten({});
const populated = Object.keys(F).filter(t => Object.keys(F[t]).length > 0);
check('every table has a conflict target',
  Object.keys(empty).filter(t => !populated.includes(t)), []);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
w.close();
process.exit(fail ? 1 : 0);
