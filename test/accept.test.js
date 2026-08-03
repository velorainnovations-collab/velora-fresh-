/*
 * The indent from one end to the other, across two devices.
 *
 *   npm run test:accept
 *
 * A shop on its own phone and the office on its own screen, at the same
 * time, talking only through the server — which is the only way to see
 * whether a submitted indent actually turns up without somebody
 * pressing reload, and whether accepting it really does close it for
 * both of them.
 */
const { chromium } = require('playwright');
const { received, opts } = require('./mock-supabase.js');

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = String(got) === String(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ->  ' + got + (ok ? '' : '   (expected ' + want + ')'));
  ok ? pass++ : fail++;
}

async function device(b) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('PAGEERROR:', e.message));
  await p.route('**://*.supabase.co/**', async route => {
    const q = route.request(); const u = new URL(q.url());
    const r = await fetch('http://127.0.0.1:8123' + u.pathname + u.search, {
      method: q.method(), headers: q.headers(),
      body: ['GET', 'HEAD'].includes(q.method()) ? undefined : q.postData(),
    });
    await route.fulfill({ status: r.status, headers: { 'content-type': 'application/json' },
                          body: await r.text() });
  });
  await p.goto('http://127.0.0.1:8092/index.html', { waitUntil: 'networkidle' });
  await p.waitForTimeout(300);
  return { ctx, p };
}

(async () => {
  const b = await chromium.launch();

  /* ---------- the shop ---------- */
  const shop = await device(b);
  await shop.p.selectOption('#gateWho', 'shop');
  await shop.p.waitForTimeout(200);
  await shop.p.fill('#gateName', 'Kilpauk Mgr');
  await shop.p.fill('#gatePhone', '9000000004');
  await shop.p.fill('#gatePass', 'shoppass1');
  await shop.p.click('#gateBtn');
  await shop.p.waitForTimeout(1500);

  /* ---------- the office, on the same day ---------- */
  const office = await device(b);
  await office.p.evaluate(() => setGateWho('admin'));
  await office.p.fill('#gateEmail', 'owner@velora.example');
  await office.p.fill('#gatePass', 'right');
  await office.p.click('#gateBtn');
  await office.p.waitForTimeout(1500);
  const today = await shop.p.evaluate(() => DATE);
  /* The same week-old bill on both devices. In the trade it gets there
     by itself — the office raises it and both pull it — but the mock
     does not carry invoices between browsers, so it is set on each. */
  const bill = () => {
    const back = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    DB.invoices[back] = { KLP: { no: 'W1', saved: true, total: 0, roundOff: 0, lines: [
      { code: '1', name: 'Lemon', unit: 'kg', qty: 9, net: 9, rate: 100, amount: 900, sell: 130 },
    ] } };
    save(); render();
  };
  await shop.p.evaluate(bill);
  await office.p.evaluate(bill);
  await office.p.evaluate(d => { setDate(d); go('indents'); }, today);
  await office.p.waitForTimeout(800);

  console.log('\nbefore anything is sent');
  check('the office sees nothing from this shop',
        /Not submitted/.test(await office.p.locator('#main tbody tr').first().textContent()), true);
  /* one button, always the same words, dead until there is something */
  const btn0 = office.p.locator('#main tbody tr').first().locator('button');
  check('the button is there', /Review & accept/.test(await btn0.textContent()), true);
  check('but cannot be pressed', await btn0.isDisabled(), true);
  check('and says why', /has not submitted/.test(await btn0.getAttribute('title') || ''), true);
  check('no Open button anywhere',
        /Open/.test(await office.p.locator('#main').textContent()), false);

  console.log('\nthe shop fills it in and presses the button');
  await shop.p.evaluate(() => {
    const ind = indentOf(DATE, ROLE);
    ind.lines = { '1': 5, '2': 12 };
    save(); render();
  });
  await shop.p.waitForTimeout(400);
  await shop.p.click('button:has-text("Submit indent")');
  await shop.p.waitForTimeout(1500);
  check('it is submitted', await shop.p.evaluate(() => indentOf(DATE, ROLE).status), 'submitted');
  check('the shop is told it is waiting to be reviewed',
        /waiting for review/.test(await shop.p.locator('#main .sub').first().textContent()), true);
  check('and can still change it until it is accepted',
        await shop.p.locator('button:has-text("Update indent")').count(), 1);

  console.log('\nand it turns up in the office without anybody pressing anything');
  /* the screen refreshes itself; this is the wait, not a reload */
  await office.p.evaluate(() => watchIndents());
  await office.p.waitForTimeout(1200);
  const row = office.p.locator('#main tbody tr', { hasText: 'Kilpauk' }).first();
  check('the shop is shown as submitted',
        /Submitted/.test(await row.textContent()), true);
  check('with its lines counted', (await row.locator('td').nth(1).textContent()).trim(), '2');
  check('and the button is the one to press',
        /Review & accept/.test(await row.textContent()), true);
  check('now it can be pressed', await row.locator('button').isDisabled(), false);

  console.log('\nthe office opens it and sees what the shop saw');
  await row.locator('button').click();
  await office.p.waitForTimeout(600);
  check('both lines are there', await office.p.locator('#main tbody tr').count(), 2);
  check('the same columns as the shop',
        (await office.p.locator('#main thead th').allTextContents())
          .map(t => t.trim()).filter(Boolean).join(' | '),
        'Code | Product | Last order | Last price | Quantity');
  /* five kilos of lemon at the hundred it was billed at; the other line
     has no price behind it and is left out and said so */
  check('and the same estimate the shop was shown',
        /₹500\.00/.test(await office.p.locator('.estbar').textContent()), true);
  check('with the uncounted line named',
        /1 product not counted/.test(await office.p.locator('.estbar').textContent()), true);
  const first = office.p.locator('#main tbody tr').first();
  await first.locator('input').fill('3');
  await first.locator('input').blur();
  await office.p.waitForTimeout(600);
  check('a quantity can be cut before accepting',
        await office.p.evaluate(d => indentOf(d, 'KLP').lines['1'], today), 3);
  check('and the estimate follows the cut',
        /₹300\.00/.test(await office.p.locator('.estbar').textContent()), true);
  await office.p.locator('#main tbody tr').nth(1).locator('button.rm').click();
  await office.p.waitForTimeout(600);
  check('and a line removed',
        await office.p.evaluate(d => Object.keys(indentOf(d, 'KLP').lines).length, today), 1);

  console.log('\naccepting it');
  let asked = '';
  office.p.once('dialog', async dlg => { asked = dlg.message(); await dlg.accept(); });
  await office.p.click('button:has-text("Accept indent")');
  await office.p.waitForTimeout(1500);
  check('it says what accepting means', /closed after this/.test(asked), true);
  check('the status is accepted',
        await office.p.evaluate(d => indentOf(d, 'KLP').status, today), 'accepted');
  check('the moment is recorded',
        !!(await office.p.evaluate(d => indentOf(d, 'KLP').acceptedAt, today)), true);
  check('and who did it',
        /Owner/.test(await office.p.evaluate(d => indentOf(d, 'KLP').acceptedBy || '', today)), true);
  check('the list says who accepted it',
        /Accepted by Velora Fresh/.test(await office.p.locator('#main').textContent()), true);

  console.log('\nand it is closed for the office too');
  await office.p.locator('#main tbody tr', { hasText: 'Kilpauk' }).first().locator('button').click();
  await office.p.waitForTimeout(600);
  await office.p.evaluate(() => { OPENIND = null; render(); });
  await office.p.waitForTimeout(500);
  check('the button now only views',
        /View/.test(await office.p.locator('#main tbody tr', { hasText: 'Kilpauk' })
                                  .first().textContent()), true);
  await office.p.locator('#main tbody tr', { hasText: 'Kilpauk' }).first().locator('button').click();
  await office.p.waitForTimeout(600);
  check('no quantity boxes', await office.p.locator('#main tbody input').count(), 0);
  check('no remove buttons',  await office.p.locator('#main tbody button.rm').count(), 0);
  check('no accept button',   await office.p.locator('button:has-text("Accept indent")').count(), 0);
  check('it says who closed it and when',
        /Accepted by Velora Fresh/.test(await office.p.locator('#main .note').first().textContent()), true);
  received.length = 0;
  await office.p.evaluate(d => adminQty(d, '1', 99), today);
  await office.p.waitForTimeout(500);
  check('and calling the edit directly changes nothing',
        await office.p.evaluate(d => indentOf(d, 'KLP').lines['1'], today), 3);

  console.log('\nthe shop finds out by itself, and is locked out');
  await shop.p.evaluate(() => watchIndents());
  await shop.p.waitForTimeout(1500);
  check('the shop sees it accepted',
        await shop.p.evaluate(() => indentOf(DATE, ROLE).status), 'accepted');
  check('told by whom',
        /Accepted by Velora Fresh/.test(await shop.p.locator('#main .note').first().textContent()), true);
  check('the update button is gone',
        await shop.p.locator('button:has-text("Update indent")').count(), 0);
  check('so is the submit button',
        await shop.p.locator('button:has-text("Submit indent")').count(), 0);
  check('no quantity boxes left', await shop.p.locator('#mylist input').count(), 0);
  check('nor the sheet import',   await shop.p.locator('#myImport').count(), 0);
  check('nor the repeat button',  await shop.p.locator('#myRepeat').count(), 0);

  let refused = '';
  shop.p.once('dialog', async dlg => { refused = dlg.message(); await dlg.accept(); });
  await shop.p.evaluate(() => myQty('1', 50));
  await shop.p.waitForTimeout(500);
  check('and typing one in from the console is refused',
        /can no longer be changed/.test(refused), true);
  check('with the quantity left alone',
        await shop.p.evaluate(() => indentOf(DATE, ROLE).lines['1']), 3);

  console.log('\nand the lorry leaving reaches the shop on its own');
  /* the office packs and sends it out; the shop is looking at a screen
     drawn before any of that happened */
  await office.p.evaluate(d => {
    setPacked && (PACKSHOP = 'KLP');
    const day = dayOf(d);
    day.packed = day.packed || {}; day.packed['KLP'] = { '1': 3 };
    day.ship = day.ship || {}; day.ship['KLP'] = 'out';
    save();
  }, today);
  await office.p.waitForTimeout(1200);
  await shop.p.evaluate(() => go('mydel'));
  await shop.p.waitForTimeout(1500);
  check('the shop sees it is out for delivery',
        await shop.p.evaluate(d => dayOf(d).ship['KLP'], today), 'out');
  check('and it says so on their screen',
        /Out for delivery/i.test(await shop.p.locator('#main').textContent()), true);
  check('without anybody reloading anything',
        await shop.p.evaluate(() => TAB), 'mydel');

  console.log('\nand a day can be cleared while the app is being tried out');
  /* testing only — TESTING_TOOLS takes the button away for good */
  check('the button is there for the office',
        await office.p.locator('#wipeDay').isVisible(), true);
  check('and for the shop as well, not only the office',
        await shop.p.locator('#wipeDay').isVisible(), true);
  let warned = '';
  office.p.once('dialog', async d => { warned = d.message(); await d.dismiss(); });
  await office.p.click('#wipeDay');
  await office.p.waitForTimeout(600);
  check('it says what it will do', /permanently removes every record/.test(warned), true);
  check('and that there is no undo', /cannot be undone/.test(warned), true);
  check('saying no leaves the day alone',
        await office.p.evaluate(d => Object.keys(indentOf(d, 'KLP').lines).length, today), 1);

  console.log('\nthe shop clears it, and the whole day goes — not just its own part');
  /* row level security lets a shop delete its own indent and nothing
     else, so clearing a day from a shop phone used to leave the rates,
     the packing and the lorry behind and the day came back half full.
     wipe_day() in 02_security.sql does the lot, for whoever is signed
     in, in one call. */
  received.length = 0;
  let said = '';
  const acceptAll = async d => { said = d.message(); await d.accept(); };
  shop.p.on('dialog', acceptAll);
  await shop.p.click('#wipeDay');
  await shop.p.waitForTimeout(2500);
  check('it went in one call, not table by table',
        received.filter(r => r.table === 'rpc:wipe_day').length, 1);
  check('the shop is told it all went, not only its own records',
        /All data for/.test(said), true);
  check('the day is empty on the shop phone',
        await shop.p.evaluate(d => Object.keys(indentOf(d, 'KLP').lines).length, today), 0);
  await office.p.evaluate(() => { go('indents'); });
  await office.p.waitForTimeout(2500);
  check('and the office sees it gone too',
        await office.p.evaluate(d => Object.keys(indentOf(d, 'KLP').lines).length, today), 0);
  check('with the packing and the lorry gone with it',
        await office.p.evaluate(d => JSON.stringify([dayOf(d).packed['KLP'] || {},
                                                     dayOf(d).ship['KLP'] || '']), today),
        '[{},""]');
  shop.p.off('dialog', acceptAll);

  console.log('\nand on a project that has not been given the function yet');
  /* it falls back to deleting a table at a time, which is all the
     office's login can do anyway — and says what was left behind */
  opts.noWipeFn = true;
  await office.p.evaluate(d => {
    const day = dayOf(d);
    day.rates['1'] = 90; day.packed['KLP'] = { '1': 4 }; day.ship['KLP'] = 'out';
    indentOf(d, 'KLP').lines['1'] = 4;
    save();
  }, today);
  await office.p.waitForTimeout(1500);
  received.length = 0;
  office.p.on('dialog', acceptAll);
  await office.p.click('#wipeDay');
  await office.p.waitForTimeout(2500);
  check('the office still clears the day',
        await office.p.evaluate(d => Object.keys(indentOf(d, 'KLP').lines).length, today), 0);
  check('the indent is gone from the server too',
        received.some(r => r.method === 'DELETE' && r.table === 'indents'), true);
  check('with the rates, packing and lorry',
        ['day_rates', 'packed', 'shipments'].every(t =>
          received.some(r => r.method === 'DELETE' && r.table === t)), true);
  check('and a table this project has not got yet does not stop it',
        received.some(r => r.method === 'DELETE' && r.table === 'vendor_order_lines'), true);
  check('nothing was said to have been kept back',
        /keeps the rest/.test(said), false);
  office.p.off('dialog', acceptAll);

  console.log('\nbut a shop on that project is told what it could not clear');
  await office.p.evaluate(d => {
    const day = dayOf(d);
    day.rates['1'] = 90; day.packed['KLP'] = { '1': 4 };
    indentOf(d, 'KLP').lines['1'] = 4;
    save();
  }, today);
  await office.p.waitForTimeout(1500);
  await shop.p.evaluate(() => go('myindent'));
  await shop.p.waitForTimeout(2500);
  received.length = 0;
  shop.p.on('dialog', acceptAll);
  await shop.p.click('#wipeDay');
  await shop.p.waitForTimeout(2500);
  check('its own indent still goes',
        await shop.p.evaluate(d => Object.keys(indentOf(d, 'KLP').lines).length, today), 0);
  check('it did not even ask to delete the rates',
        received.some(r => r.method === 'DELETE' && r.table === 'day_rates'), false);
  check('and it is told the packing and the bills stay',
        /keeps the rest/.test(said) && /the packing/.test(said), true);
  check('and how to make the whole day clearable', /wipe_day/.test(said), true);
  shop.p.off('dialog', acceptAll);
  opts.noWipeFn = false;

  await shop.ctx.close();
  await office.ctx.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
