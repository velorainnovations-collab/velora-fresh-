/*
 * WhatsApp links.
 *
 *   npm run test:whatsapp
 *
 * A wa.me link opens WhatsApp with the number and message ready. The
 * number matters more than it looks: a bare Indian mobile without 91
 * opens a chat with nobody, silently, and the order is simply never
 * sent. So the formatting is checked hard.
 */
const { chromium } = require('playwright');
require('./mock-supabase.js');

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = String(got) === String(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ->  ' + got + (ok ? '' : '   (expected ' + want + ')'));
  ok ? pass++ : fail++;
}

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 950 },
                                   permissions: ['clipboard-read', 'clipboard-write'] });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('PAGEERROR:', e.message));
  await p.route('**://*.supabase.co/**', async route => {
    const req = route.request(); const u = new URL(req.url());
    const r = await fetch('http://127.0.0.1:8123' + u.pathname + u.search, {
      method: req.method(), headers: req.headers(),
      body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postData(),
    });
    await route.fulfill({ status: r.status, headers: { 'content-type': 'application/json' },
                          body: await r.text() });
  });
  await p.goto('http://127.0.0.1:8092/index.html', { waitUntil: 'networkidle' });
  /* Everyone below signs in with an email, and the gate opens on the
     Shop tab. Pick Office first, as a person at a desk would. Skipped on
     the reset-password screen, which has no tabs. */
  await p.evaluate(() => {
    if (typeof setGateWho === 'function' && GATE_MODE !== 'set') setGateWho('admin');
  });
  await p.fill('#gateEmail', 'owner@velora.example');
  await p.fill('#gatePass', 'right');
  await p.click('#gateBtn');
  await p.waitForTimeout(1200);

  console.log('\nthe number');
  const n = sel => p.evaluate(v => waNumber(v), sel);
  check('bare Indian mobile gains 91', await n('9840000001'), '919840000001');
  check('leading zero dropped',        await n('09840000001'), '919840000001');
  check('already prefixed left alone', await n('919840000001'), '919840000001');
  check('spaces and dashes stripped',  await n('98400 00001'), '919840000001');
  check('+91 handled',                 await n('+91 98400 00001'), '919840000001');
  check('empty stays empty',           await n(''), '');
  check('rubbish stays empty',         await n('   '), '');

  console.log('\nthe link');
  // catch the popup rather than actually opening WhatsApp
  await p.evaluate(() => { window.__opened = null;
                           window.open = (u) => { window.__opened = u; return {}; }; });
  await p.evaluate(() => waOpen('9840000001', 'hello there'));
  const url = await p.evaluate(() => window.__opened);
  check('goes to wa.me', /^https:\/\/wa\.me\/919840000001\?text=/.test(url), true);
  check('message is encoded', /hello%20there/.test(url), true);

  console.log('\nan order');
  await p.evaluate(() => {
    setAnytime(true);
    const ind = indentOf(VF.DATE, 'KLP');
    ind.lines = { '1': 12, '2': 50 };
    ind.status = 'accepted';
    save();
    DB.vendors['Others'] = DB.vendors['Others'] || {};
    DB.vendors['Others'].phone = '9840000009';
    DB.vendors['Others'].manual = false;
    DB.vendors['Others'].name = 'Others Vendor';
    save();
    window.__opened = null;
    go('orders');
  });
  await p.waitForTimeout(400);
  await p.evaluate(() => sendOrder('Others'));
  await p.waitForTimeout(300);
  const orderUrl = await p.evaluate(() => window.__opened);
  check('order opens WhatsApp', /wa\.me\/919840000009/.test(orderUrl || ''), true);
  check('order names a product',
        /Lemon/.test(decodeURIComponent(orderUrl || '')), true);
  check('marked as sent', await p.evaluate(() => !!dayOf(VF.DATE).sent['Others']), true);

  console.log('\nbuying more than the shops asked for');
  /* a vendor sells by the crate, and the rate is better for ten kilos
     than for seven — so what is bought is not always what was asked
     for, and the shops' own figures must not move with it */
  await p.evaluate(() => { go('orders'); });
  await p.waitForTimeout(400);
  const box = p.locator('#main input.row-inp').first();
  check('every line can be changed before it goes',
        await box.count(), 1);
  check('and starts at what the shops asked for', await box.inputValue(), '12');
  await box.fill('15');
  await box.blur();
  await p.waitForTimeout(400);
  check('the change is kept', await p.evaluate(() => dayOf(VF.DATE).order['1']), 15);
  check('the shop is untouched',
        await p.evaluate(() => indentOf(VF.DATE, 'KLP').lines['1']), 12);
  check('the screen still shows what they asked for',
        /shops asked for/.test(await p.locator('#main').textContent()), true);

  await p.evaluate(() => { window.__opened = null; sendOrder('Others'); });
  await p.waitForTimeout(300);
  const changed = decodeURIComponent(await p.evaluate(() => window.__opened) || '');
  /* the name now carries its Tamil too, so the quantity is matched
     after it rather than straight after the English name */
  check('the vendor is asked for the new quantity', /Lemon[^—]*— 15/.test(changed), true);
  check('and reads it in Tamil as well', /லெமன்/.test(changed), true);
  check('and the shop split is still theirs', /Kilpauk 12/.test(changed), true);

  console.log('\nshops across the top, one row per product');
  /* a second shop asks for the same product: it becomes a column by
     itself, and the product still has exactly one row */
  await p.evaluate(() => {
    const ind2 = indentOf(VF.DATE, 'NGB');
    ind2.lines = { '1': 8, '11': 6 };   /* Cauliflower shares Lemon's vendor */
    ind2.status = 'accepted';
    save(); go('orders');
  });
  await p.waitForTimeout(400);
  const mhead = await p.locator('#main .omx thead').first().textContent();
  check('the shops are the columns', /Kilpauk/.test(mhead) && /Nungambakkam/.test(mhead), true);
  check('with Total on the far right', /Total/.test(mhead), true);
  check('one row per product, not one per shop',
        await p.locator('#main .omx tbody tr', { hasText: 'Lemon' }).count(), 1);
  const lemonRow = await p.locator('#main .omx tbody tr', { hasText: 'Lemon' }).textContent();
  check('each shop under its own column, added up',
        /12/.test(lemonRow) && /8/.test(lemonRow) && /20/.test(lemonRow), true);
  const cauliRow = await p.locator('#main .omx tbody tr', { hasText: 'Cauliflower' }).textContent();
  check('a shop that did not ask shows a dash, not a hidden row',
        /—/.test(cauliRow) && /6/.test(cauliRow), true);
  check('a vendor only one shop buys from has just that column',
        await p.evaluate(() => {
          /* the Nellai Traders card: only Kilpauk asked it for anything,
             so Nungambakkam must not be one of its columns */
          const cards = Array.from(document.querySelectorAll('#main .card'));
          const nel = cards.find(c => /Nellai/.test(c.textContent));
          return !!nel && !/Nungambakkam/.test(nel.querySelector('thead').textContent);
        }), true);
  check('the product column stays put while the shops scroll',
        await p.evaluate(() => getComputedStyle(
          document.querySelector('.omx tbody td')).position), 'sticky');

  console.log('\nand the rates screen shows what is being bought');
  await p.evaluate(() => go('rates'));
  await p.waitForTimeout(400);
  const rateRow = p.locator('#main tbody tr', { hasText: 'Lemon' }).first();
  check('the column is there',
        /Buying/.test(await p.locator('#main thead').textContent()), true);
  check('and it is the quantity bought, not the one asked for',
        /15/.test(await rateRow.textContent()), true);

  console.log('\na vendor ordered by hand');
  await p.evaluate(() => {
    DB.vendors['Manual order'] = DB.vendors['Manual order'] || {};
    DB.vendors['Manual order'].manual = true;
    save();
    window.__opened = null;
    window.__alert = null;
    window.alert = m => { window.__alert = m; };
  });
  await p.evaluate(() => sendOrder('Manual order'));
  await p.waitForTimeout(300);
  check('no WhatsApp opened for a manual vendor',
        await p.evaluate(() => window.__opened), 'null');
  check('told it was copied',
        /copied/.test(await p.evaluate(() => window.__alert) || ''), true);

  console.log('\na vendor with no number');
  await p.evaluate(() => {
    DB.vendors['Ooty'] = DB.vendors['Ooty'] || {};
    DB.vendors['Ooty'].phone = '';
    DB.vendors['Ooty'].manual = false;
    save();
    window.__opened = null; window.__alert = null;
  });
  await p.evaluate(() => sendOrder('Ooty'));
  await p.waitForTimeout(300);
  check('nothing opened', await p.evaluate(() => window.__opened), 'null');
  check('told no number is saved',
        /No WhatsApp number saved/.test(await p.evaluate(() => window.__alert) || ''), true);

  console.log('\nshop numbers');
  await p.evaluate(() => go('shops'));
  await p.waitForTimeout(400);
  check('a WhatsApp column exists',
        /WhatsApp/.test(await p.locator('#main thead').textContent()), true);
  await p.evaluate(() => { setShopPhone('KLP', '98400 12345'); });
  check('saved without spaces',
        await p.evaluate(() => shopById('KLP').phone), '9840012345');
  check('kept for next time',
        await p.evaluate(() => DB.shopPhones['KLP']), '9840012345');

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await ctx.close();
  await b.close();
  process.exit(fail ? 1 : 0);
})();
