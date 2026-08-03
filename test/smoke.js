/*
 * Smoke test — runs the whole day cycle headlessly and checks the numbers.
 *
 *   npm install jsdom
 *   node test/smoke.js
 *
 * Every screen is rendered and every calculation exercised. This exists
 * because string-replacement edits to a single-file app can break scope
 * silently: `node --check` only catches syntax, not wiring.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const file = path.join(__dirname, '..', 'index.html');
const errs = [], alerts = [];
let pass = 0, fail = 0;

function check(label, got, want) {
  const ok = String(got) === String(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ->  ' + got + (ok ? '' : '   (expected ' + want + ')'));
  ok ? pass++ : fail++;
}

const dom = new JSDOM(fs.readFileSync(file, 'utf8'), {
  runScripts: 'dangerously', url: 'http://localhost/',
  beforeParse(w) {
    w.alert = m => alerts.push(m);
    w.print = () => {};
    w.confirm = () => true;
    w.addEventListener('error', e => errs.push(e.message));
  }
});
const w = dom.window, d = dom.window.document;

console.log('\ncatalogue and groups');
check('products loaded', Object.keys(w.VF.CAT).length, 241);
const G = w.VF.GROUPS;
const totalGrouped = Object.keys(G).reduce((t, g) => t + G[g].length, 0);
check('every product has a group', totalGrouped, 241);
check('no unmapped codes', w.VF.CODES.filter(c => !w.VF.CODE2GROUP[c]).length, 0);

w.setRole('owner');
w.setAnytime(true);

console.log('\nindent');
w.setRole('KLP');
const ind = w.indentOf(w.VF.DATE, 'KLP');
ind.lines = { '1': 12, '2': 50, '303': 2, '280': 2 };
w.save(); w.render(); w.submitIndent();
check('submitted', w.indentOf(w.VF.DATE, 'KLP').status, 'submitted');
w.setRole('admin');
w.acceptIndent('KLP');
check('accepted', w.indentOf(w.VF.DATE, 'KLP').status, 'accepted');

console.log('\norders');
w.go('orders');
const gr = w.VF.grouped(w.VF.DATE);
check('groups needed today', Object.keys(gr.groups).length > 0, 'true');
w.sendOrder(Object.keys(gr.groups)[0]);
check('order marked sent', /Sent|Ordered/.test(d.getElementById('main').innerHTML), 'true');

console.log('\nrates and pricing');
w.go('rates');
w.setRate('1', 80); w.setRate('2', 27); w.setRate('303', 142); w.setRate('280', 300);
check('market 80 + 4% commission', w.purchaseRate('KLP', '1').toFixed(2), '83.20');
check('2 boxes of 303 = net kg', w.netKg('303', 2, 'box'), 40);

console.log('\npacking and delivery');
w.go('pack'); w.setPackShop('KLP');
w.setPacked('1', 12); w.setPacked('2', 42); w.setPacked('303', 2); w.setPacked('280', 0);
w.markOut('KLP');
check('out for delivery', w.shopStatus('KLP'), 'shipped');
w.confirmReceipt('KLP');
check('received', w.shopStatus('KLP'), 'received');

console.log('\ninvoice');
w.go('inv'); w.makeInvoice('KLP');
const inv = w.VF.DB.invoices[w.VF.DATE]['KLP'];
check('lines on the bill', inv.lines.length, 3);
// a draft until it is saved: no number, and nothing downstream counts it
check('a draft has no bill number', inv.no, '');
check('and the day is not billed yet', w.shopStatus('KLP'), 'received');
w.saveInvoice('KLP');
check('saving issues the number', /^VF\/KLP\//.test(inv.no), true);
check('and the day is billed', w.shopStatus('KLP'), 'billed');
check('vendor-skipped line excluded', inv.lines.filter(l => l.code === '280').length, 0);
check('lemon amount', inv.lines[0].amount.toFixed(2), '998.40');
check('lemon selling price', inv.lines[0].sell.toFixed(2), '129.79');
check('no service line', /Service Cost/.test(d.getElementById('main').innerHTML), 'false');

console.log('\nmargin master is retrospective-safe');
w.setRole('owner'); w.go('master'); w.setComm('KLP', 5);
check('new rate uses 5%', w.purchaseRate('KLP', '1').toFixed(2), '84.00');
check('issued bill unchanged', inv.lines[0].rate.toFixed(2), '83.20');
w.setComm('KLP', 4);

console.log('\naccounts');
w.go('acct');
const billTotal = Math.round(inv.total);
w.VF.DB.payments.push({ id: 'p1', date: w.VF.DATE, amount: 1000, mode: 'NEFT', ref: 'UTR1' });
w.save();
let st = w.VF.settled();
check('partial applied to oldest', st[0].state, 'part');
w.VF.DB.payments.push({ id: 'p2', date: w.VF.DATE, amount: billTotal - 1000, mode: 'UPI', ref: 'UPI9' });
w.save();
st = w.VF.settled();
check('cleared after full payment', st[0].state, 'cleared');
check('nothing due', st.reduce((t, b) => t + b.due, 0), 0);

console.log('\npermissions');
w.setRole('ho'); w.go('acct');
check('head office cannot record payments', /Record a payment/.test(d.getElementById('main').innerHTML), 'false');
w.go('inv');
check('head office cannot generate bills', /Create invoice/.test(d.getElementById('main').innerHTML), 'false');
w.setRole('KLP'); w.go('mybills');
check('shop sees its outstanding', /Outstanding/.test(d.getElementById('main').innerHTML), 'true');

check('runtime errors', errs.length, 0);
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
w.close();
process.exit(fail ? 1 : 0);
