/*
 * Delivery verification, the unit master, and the selling price page.
 *
 *   npm run test:verify
 *
 * The shop checks the crates against the note and reports what is wrong;
 * the office reads the report from the delivery screen and clears it.
 * Units are a master rather than a hard-coded list. The selling price
 * page is the day's shelf prices as their own record.
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
  const ctx = await b.newContext({ viewport: { width: 1280, height: 950 } });
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

/* the day as the shop receives it: packed, out for delivery */
const seedDay = () => {
  setAnytime && setAnytime(true);
  const d = DATE;
  DB.indents[d] = { KLP: { status: 'accepted', lines: { '1': 5, '2': 12, '3': 4 },
                           seq: { '1': 1, '2': 2, '3': 3 } } };
  DB.days[d] = { rates: { '1': 80, '2': 27, '3': 34 },
                 packed: { KLP: { '1': 5, '2': 12, '3': 4 } },
                 ship: { KLP: 'out' }, sent: {} };
  save(); render();
};

(async () => {
  const b = await chromium.launch();

  /* ---------- the shop, at the crates ---------- */
  const shop = await device(b);
  await shop.p.selectOption('#gateWho', 'shop');
  await shop.p.waitForTimeout(200);
  await shop.p.fill('#gateName', 'Kilpauk Mgr');
  await shop.p.fill('#gatePhone', '9000000004');
  await shop.p.fill('#gatePass', 'shoppass1');
  await shop.p.click('#gateBtn');
  await shop.p.waitForTimeout(1500);
  await shop.p.evaluate(seedDay);
  await shop.p.evaluate(() => go('mydel'));
  await shop.p.waitForTimeout(400);

  console.log('\nreporting a line');
  check('every line has an Edit button',
        await shop.p.locator('#main tbody button:has-text("Edit")').count(), 3);
  await shop.p.locator('tr:has-text("Potato") button:has-text("Edit")').click();
  await shop.p.waitForTimeout(300);
  check('the editor opens under the line', await shop.p.locator('tr.vedit').count(), 1);
  check('with both choices on it',
        /Product not delivered/.test(await shop.p.locator('tr.vedit').textContent())
        && /different weight/.test(await shop.p.locator('tr.vedit').textContent()), true);
  check('and the note weight shown read-only',
        /note says 12 kg/.test(await shop.p.locator('tr.vedit').textContent()), true);

  await shop.p.locator('tr.vedit button:has-text("Product not delivered")').click();
  await shop.p.waitForTimeout(300);
  check('marked as not delivered',
        /Not delivered/.test(await shop.p.locator('tr:has-text("Potato")').first().textContent()), true);

  await shop.p.locator('tr:has-text("Lemon") button:has-text("Edit")').click();
  await shop.p.waitForTimeout(300);
  await shop.p.fill('tr.vedit input', '4');
  await shop.p.locator('tr.vedit input').dispatchEvent('change');
  await shop.p.waitForTimeout(300);
  check('the mismatch keeps both weights', await shop.p.evaluate(() => {
    const it = dayOf(DATE).verify.KLP.items['1'];
    return it.type + ' ' + it.original + ' ' + it.current;
  }), 'weight 5 4');

  console.log('\nnothing reaches the office until it is sent');
  check('the marks are not sent yet',
        await shop.p.evaluate(() => !!dayOf(DATE).verify.KLP.sent), false);
  received.length = 0;
  await shop.p.click('button:has-text("Send for re-verification")');
  await shop.p.waitForTimeout(1200);
  check('sent, stamped with who checked', await shop.p.evaluate(() => {
    const v = dayOf(DATE).verify.KLP;
    return v.sent && v.by === 'Kilpauk Mgr' && !!v.at;
  }), true);
  const wrote = received.filter(r => r.table === 'delivery_issues' && r.method === 'POST');
  check('and the report went to the server', wrote.length > 0, true);
  check('the shop is told it has gone',
        /Sent for re-verification/.test(await shop.p.locator('#main').textContent()), true);

  /* ---------- the office, on its own screen ---------- */
  const office = await device(b);
  await office.p.evaluate(() => setGateWho('admin'));
  await office.p.fill('#gateEmail', 'owner@velora.example');
  await office.p.fill('#gatePass', 'right');
  await office.p.click('#gateBtn');
  await office.p.waitForTimeout(1500);
  await office.p.evaluate(seedDay);
  await office.p.evaluate(() => { VFSync.pull(DB).then(() => render()); });
  await office.p.waitForTimeout(1200);
  await office.p.evaluate(() => go('ship'));
  await office.p.waitForTimeout(400);

  console.log('\nthe office sees the report');
  const row = office.p.locator('#main tbody tr').filter({ hasText: 'Kilpauk' }).first();
  check('the delivery is marked pending',
        /Pending re-verification/.test(await row.textContent()), true);
  check('in red, because both kinds of problem are on it',
        await row.locator('.pill.p-red').count() > 0, true);
  await row.locator('button:has-text("View")').click();
  await office.p.waitForTimeout(300);
  const view = await office.p.locator('tr.vedit').textContent();
  check('who checked and when', /checked by Kilpauk Mgr/.test(view), true);
  check('the missing product is named',
        /Potato/.test(view) && /Product not delivered/.test(view), true);
  check('the mismatch shows both weights',
        /Weight mismatch/.test(view) && /5 kg/.test(view) && /4 kg/.test(view), true);

  /* one kind of problem only reads in blue */
  await office.p.evaluate(() => {
    delete dayOf(DATE).verify.KLP.items['2'];
    save(); render();
  });
  await office.p.waitForTimeout(300);
  check('one kind of problem reads in blue', await office.p
    .locator('#main tbody tr').filter({ hasText: 'Kilpauk' }).first()
    .locator('.pill.p-blue').count() > 0, true);
  await office.p.evaluate(() => {
    dayOf(DATE).verify.KLP.items['2'] = { type: 'missing', original: 12 };
    save(); render();
  });

  console.log('\nand clears it once the packing is put right');
  received.length = 0;
  office.p.once('dialog', d => d.accept());
  /* the view panel is still open from before */
  await office.p.click('button:has-text("Sorted")');
  await office.p.waitForTimeout(1200);
  check('the report is gone from the screen',
        /Pending re-verification/.test(await office.p.locator('#main').textContent()), false);
  check('and its rows deleted from the server',
        received.some(r => r.table === 'delivery_issues' && r.method === 'DELETE'), true);
  await office.ctx.close();
  await shop.ctx.close();

  /* ---------- units ---------- */
  console.log('\nthe unit master');
  const own = await device(b);
  await own.p.evaluate(() => setGateWho('admin'));
  await own.p.fill('#gateEmail', 'owner@velora.example');
  await own.p.fill('#gatePass', 'right');
  await own.p.click('#gateBtn');
  await own.p.waitForTimeout(1500);
  let said = '';
  own.p.on('dialog', async d => { said = d.message();
    if (d.type() === 'prompt') await d.accept('carton'); else await d.accept(); });
  await own.p.evaluate(() => go('products'));
  await own.p.waitForTimeout(500);

  check('packet is on the list from the start', await own.p.evaluate(() =>
    Array.prototype.slice.call(document.querySelectorAll('#npUnit option'))
      .some(o => o.value === 'packet')), true);

  // a custom unit, made beside the box that wants it
  await own.p.fill('#npCode', '910');
  await own.p.fill('#npPName', 'Egg Tray');
  await own.p.click('.gtools button:has-text("+ New unit")');
  await own.p.waitForTimeout(200);
  await own.p.fill('#unName', 'crate');
  await own.p.click('#uNew button:has-text("Create unit")');
  await own.p.waitForTimeout(400);
  check('the new unit is chosen', await own.p.locator('#npUnit').inputValue(), 'crate');
  check('and the half typed product survived',
        await own.p.locator('#npPName').inputValue(), 'Egg Tray');
  check('unweighed, so no weight is asked for',
        await own.p.locator('#npWt').isVisible(), false);

  received.length = 0;
  await own.p.click('button:has-text("Add product")');
  await own.p.waitForTimeout(800);
  check('the product carries it', await own.p.evaluate(() => (CAT['910']||{}).unit), 'crate');
  check('and the unit went up with the next push',
        await own.p.evaluate(() => VFSync.record(DB) >= 0), true);

  // a weighed unit behaves like box and tray
  await own.p.click('.gtools button:has-text("+ New unit")');
  await own.p.waitForTimeout(200);
  await own.p.fill('#unName', 'sack');
  await own.p.check('#unWeighed');
  await own.p.click('#uNew button:has-text("Create unit")');
  await own.p.waitForTimeout(400);
  check('a weighed unit asks for its kg', await own.p.locator('#npWt').isVisible(), true);
  said = '';
  await own.p.fill('#npCode', '911');
  await own.p.fill('#npPName', 'Onion Sack');
  await own.p.click('button:has-text("Add product")');
  await own.p.waitForTimeout(400);
  check('and refuses without one', /weight in kg/.test(said), true);

  // in use means not deletable
  said = '';
  await own.p.click('.gtools button:has-text("Manage")');
  await own.p.waitForTimeout(200);
  await own.p.locator('#uManage tr').filter({ hasText: 'crate' })
    .locator('button:has-text("Delete")').click();
  await own.p.waitForTimeout(300);
  check('a unit in use cannot be deleted', /cannot be deleted/.test(said), true);
  check('it is still there', await own.p.evaluate(() => !!DB.units.crate), true);

  // rename moves the products with it
  await own.p.locator('#uManage tr').filter({ hasText: 'crate' })
    .locator('button:has-text("Rename")').click();
  await own.p.waitForTimeout(400);
  check('renamed', await own.p.evaluate(() => !!DB.units.carton && !DB.units.crate), true);
  check('the product moved with it', await own.p.evaluate(() => (CAT['910']||{}).unit), 'carton');

  // built-ins keep their names
  said = '';
  check('kg has no rename button', await own.p
    .locator('#uManage tr').filter({ hasText: /^kg/ })
    .locator('button').count(), 0);

  /* ---------- selling price ---------- */
  console.log('\nthe selling price page');
  await own.p.evaluate(seedDay);
  await own.p.evaluate(() => go('sell'));
  await own.p.waitForTimeout(400);
  const page = await own.p.locator('#main').textContent();
  check('it is under Sales in the menu', await own.p.evaluate(() =>
    tabsFor().some(t => t.id === 'sell')), true);
  check('every shop is listed', /Kilpauk/.test(page) && /Hiranandani/.test(page), true);
  check('all shops start folded shut', /Billed \/ kg/.test(page), false);
  check('the day answers live before a bill exists', /not billed yet/.test(page), true);

  // searching with nothing open finds nothing — the search looks inside the open shop
  await own.p.fill('#sellQ', 'lemon');
  await own.p.waitForTimeout(400);
  check('search with no shop open shows no prices',
        /Open a shop first/.test(await own.p.locator('#main').textContent()), true);
  await own.p.fill('#sellQ', '');
  await own.p.waitForTimeout(300);

  // open Kilpauk — its prices and only its prices
  await own.p.locator('h3.acc', { hasText: 'Kilpauk' }).click();
  await own.p.waitForTimeout(400);
  const opened = await own.p.locator('#main').textContent();
  check('billed and selling side by side',
        /Billed \/ kg/.test(opened) && /Selling \/ kg/.test(opened), true);
  check('the billed price is the purchase price',
        /83\.20/.test(opened), true);   /* 80 x 1.04 */
  check('one table only — the open shop\'s',
        await own.p.locator('#main table').count(), 1);

  // open Hiranandani — Kilpauk folds itself shut
  await own.p.locator('h3.acc', { hasText: 'Hiranandani' }).click();
  await own.p.waitForTimeout(400);
  check('only one shop stays open at a time',
        await own.p.evaluate(() => SELLSHOP), 'HRN');
  check('and the newly opened shop has no prices of its own',
        /Nothing for this shop/.test(await own.p.locator('#main').textContent()), true);
  check('still one open card', await own.p.locator('#main .drop').count(), 1);

  // clicking the open shop closes it
  await own.p.locator('h3.acc', { hasText: 'Hiranandani' }).click();
  await own.p.waitForTimeout(400);
  check('clicking the open shop folds it shut',
        await own.p.evaluate(() => SELLSHOP), null);

  // search narrows within the open shop
  await own.p.locator('h3.acc', { hasText: 'Kilpauk' }).click();
  await own.p.waitForTimeout(300);
  await own.p.fill('#sellQ', 'lemon');
  await own.p.waitForTimeout(400);
  const searched = await own.p.locator('#main table').textContent();
  check('search by name', /Lemon/.test(searched) && !/Potato/.test(searched), true);
  await own.p.fill('#sellQ', '2');
  await own.p.waitForTimeout(400);
  check('search by code', /Potato/.test(await own.p.locator('#main').textContent()), true);
  await own.p.fill('#sellQ', '');
  await own.p.waitForTimeout(300);

  // a saved bill freezes the page the way it freezes the bill
  await own.p.evaluate(() => {
    go('inv'); makeInvoice('KLP'); saveInvoice('KLP'); go('sell');
  });
  await own.p.waitForTimeout(500);
  const frozen = await own.p.locator('#main').textContent();
  check('a saved bill answers from its own lines', /from bill VF\/KLP/.test(frozen), true);
  await own.p.evaluate(() => { DB.master.selling.KLP = { '1': 50 }; save(); render(); });
  await own.p.waitForTimeout(300);
  check('and a margin changed later does not rewrite it',
        /from bill VF\/KLP/.test(await own.p.locator('#main').textContent())
        && !/124\.80/.test(await own.p.locator('#main').textContent()), true);
  await own.ctx.close();

  /* ---------- a database that has never been migrated ----------
     The live failure of 2026-08: the app several columns ahead of the
     database, and one unsendable invoice damming the queue so the
     indent behind it read as a sync problem for ever. The push must
     strip what the server does not know, send the rest, and say Saved. */
  console.log('\na database running behind the app');
  opts.behindColumns = {
    indents: ['accepted_at', 'accepted_by_name'],
    indent_lines: ['seq'],
    invoices: ['contact_id', 'vehicle_no', 'driver_name', 'bill_to_name',
               'bill_to_gstin', 'bill_to_address', 'supply_date', 'place_of_supply'],
  };
  const beh = await device(b);
  /* no contact on file, so Save invoice asks — say yes */
  beh.p.on('dialog', d => d.accept());
  await beh.p.evaluate(() => setGateWho('admin'));
  await beh.p.fill('#gateEmail', 'owner@velora.example');
  await beh.p.fill('#gatePass', 'right');
  await beh.p.click('#gateBtn');
  await beh.p.waitForTimeout(1500);
  received.length = 0;
  await beh.p.evaluate(() => {
    setAnytime(true);
    const d = DATE;
    DB.indents[d] = { KLP: { status: 'accepted', lines: { '1': 2 }, seq: { '1': 1 },
                             acceptedAt: new Date().toISOString(), acceptedBy: 'Velora Owner' } };
    DB.days[d] = { rates: { '1': 80 }, packed: { KLP: { '1': 2 } },
                   ship: { KLP: 'received' }, sent: {} };
    save(); go('inv'); makeInvoice('KLP'); saveInvoice('KLP');
  });
  await beh.p.waitForTimeout(2500);

  const gotLines = received.filter(r => r.table.startsWith('indent_lines') && r.method === 'POST'
                                        && !r.refused);
  const gotInv = received.filter(r => r.table.startsWith('invoices') && r.method === 'POST'
                                      && !r.refused);
  check('the indent lines still land, without the new column',
        gotLines.length > 0 && gotLines.every(r => !('seq' in r.rows[0])), true);
  const lastInv = gotInv.length ? gotInv[gotInv.length - 1].rows[0] : null;
  check('the invoice landed at all', gotInv.length > 0, true);
  check('with all eight unknown columns stripped',
        lastInv ? Object.keys(lastInv).filter(k =>
          ['contact_id','vehicle_no','driver_name','bill_to_name','bill_to_gstin',
           'bill_to_address','supply_date','place_of_supply'].indexOf(k) > -1).join(',') : 'none', '');
  check('and its number intact', lastInv ? lastInv.bill_no !== undefined : false, true);
  check('nothing is left stuck in the queue',
        await beh.p.evaluate(() => VFSync.queueLength()), 0);
  check('and the badge says Saved, not Sync problem',
        await beh.p.evaluate(() =>
          document.querySelector('#syncState span:last-child').textContent), 'Saved');
  check('the sync log tells the story',
        await beh.p.evaluate(() => VFSync.log().some(l => /sent/.test(l.kind))), true);

  /* the person who can fix it is told once, calmly, on the screen */
  await beh.p.evaluate(() => render());
  await beh.p.waitForTimeout(300);
  const note = await beh.p.locator('#main .note').first().textContent();
  check('the owner is told an update is waiting',
        /database update is waiting/.test(note), true);
  check('and pointed at the one file to run', /UPDATE\.sql/.test(note), true);
  await beh.p.locator('button:has-text("Not now")').click();
  await beh.p.waitForTimeout(300);
  check('and can put it aside for the day',
        /database update is waiting/.test(await beh.p.locator('#main').textContent()), false);
  opts.behindColumns = null;
  await beh.ctx.close();

  /* ---------- a long history does not swallow the newest day ----------
     The live failure of 2026-08-14: Supabase answers at most 1000 rows
     per request and truncates silently. After a week of trading the
     indent lines passed that mark, the pull came back short, and the
     owner watched the day's indents "disappear" right after updating
     the market rates — the redraw was the moment the short read showed.
     Thirty old days of forty lines each is seeded straight into the
     server here, well past the cap, and the newest day must still come
     through whole. */
  console.log('\na month of history on the server');
  const rest = (path2, bodyRows) => fetch('http://127.0.0.1:8123/rest/v1/' + path2, {
    method: bodyRows ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: bodyRows ? JSON.stringify(bodyRows) : undefined,
  }).then(r => r.json().catch(() => null));
  for (let d = 1; d <= 30; d++) {
    const date = '2026-06-' + String(d).padStart(2, '0');
    await rest('indents', [{ trade_date: date, shop_id: 'KLP', status: 'accepted' }]);
    const hdr = await rest('indents?trade_date=eq.' + date + '&shop_id=eq.KLP&select=id');
    const id = hdr && hdr[0] && hdr[0].id;
    const lines = [];
    for (let i = 1; i <= 40; i++) {
      lines.push({ indent_id: id, product_code: 'P' + String(i).padStart(2, '0'),
                   qty: i, seq: i });
    }
    await rest('indent_lines', lines);
  }

  const far = await device(b);
  await far.p.evaluate(() => setGateWho('admin'));
  await far.p.fill('#gateEmail', 'owner@velora.example');
  await far.p.fill('#gatePass', 'right');
  await far.p.click('#gateBtn');
  await far.p.waitForTimeout(2500);
  check('well past the 1000-row mark, every line arrives',
        await far.p.evaluate(() =>
          Object.keys(DB.indents).filter(d => d.indexOf('2026-06') === 0)
            .reduce((n, d) => n + Object.keys((DB.indents[d].KLP || {}).lines || {}).length, 0)),
        1200);
  check('the newest seeded day is whole',
        await far.p.evaluate(() =>
          Object.keys(DB.indents['2026-06-30'].KLP.lines).length), 40);

  /* the reported flow, exactly: indent in, rates entered, Update rates
     pressed — and the indent must still be standing afterwards */
  console.log('\nupdating the market rate leaves the indents alone');
  await far.p.evaluate(async () => {
    setAnytime(true);
    DB.indents[DATE] = { KLP: { status: 'accepted', lines: { '1': 20, '2': 10, '3': 5 },
                                seq: { '1': 1, '2': 2, '3': 3 } } };
    DB.days[DATE] = { rates: {}, packed: {}, ship: {}, sent: {} };
    save(); go('rates');
    rateDraft('1', '50'); rateDraft('2', '40'); rateDraft('3', '100');
    await applyRates();
  });
  await far.p.waitForTimeout(1200);
  check('the rates took',
        await far.p.evaluate(() => JSON.stringify(dayOf(DATE).rates)),
        '{"1":50,"2":40,"3":100}');
  check('the indent is untouched',
        await far.p.evaluate(() => JSON.stringify(DB.indents[DATE].KLP.lines)),
        '{"1":20,"2":10,"3":5}');
  check('and still accepted',
        await far.p.evaluate(() => DB.indents[DATE].KLP.status), 'accepted');
  check('nothing stuck in the queue',
        await far.p.evaluate(() => VFSync.queueLength()), 0);

  /* the background read that redraws the day: it must bring the same
     indent back, and a flaky moment must leave the screen alone rather
     than redraw it empty */
  await far.p.evaluate(async () => { await VFSync.refreshIndents(DB, DATE); });
  check('a background refresh brings the same lines back',
        await far.p.evaluate(() => JSON.stringify(DB.indents[DATE].KLP.lines)),
        '{"1":20,"2":10,"3":5}');
  opts.failLines = true;
  const held = await far.p.evaluate(async () => {
    const changed = await VFSync.refreshIndents(DB, DATE);
    return JSON.stringify([changed, DB.indents[DATE].KLP.lines]);
  });
  check('a failed lines read leaves the day exactly as it was',
        held, JSON.stringify([false, { 1: 20, 2: 10, 3: 5 }]));
  opts.failLines = false;
  await far.ctx.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
