/*
 * The morning: rates entered off a vendor's bill, and packing checked
 * against what was asked for.
 *
 *   npm run test:rates
 *
 * Two things that used to be silent. A rate reached every screen the
 * moment it was typed, so a half-entered bill was live for as long as
 * it took to finish it — and there was nothing to press, so nobody knew
 * whether anything had been saved. And a quantity packed short looked
 * exactly like one packed right.
 */
const { chromium } = require('playwright');
const { received } = require('./mock-supabase.js');

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = String(got) === String(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ->  ' + got + (ok ? '' : '   (expected ' + want + ')'));
  ok ? pass++ : fail++;
}

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1300, height: 950 } });
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
  await p.evaluate(() => setGateWho('admin'));
  await p.fill('#gateEmail', 'owner@velora.example');
  await p.fill('#gatePass', 'right');
  await p.click('#gateBtn');
  await p.waitForTimeout(1400);
  await p.evaluate(() => {
    DB.indents[DATE] = { KLP: { status: 'accepted', lines: { '1': 10, '11': 5, '2': 20, '3': 8 } } };
    DB.days[DATE] = { rates: {}, packed: {}, ship: {}, sent: {} };
    save(); go('rates');
  });
  await p.waitForTimeout(600);

  console.log('\nnothing to update, nothing to press');
  check('the button is there', await p.locator('#rateApply').count(), 1);
  check('and dead',            await p.locator('#rateApply').isDisabled(), true);
  check('and says why',
        (await p.locator('#rateCount').textContent()).trim(), 'No changes to update');

  console.log('\ntyping a rate does not publish it');
  const first = p.locator('#main input.row-inp').first();
  await first.fill('80');
  await p.waitForTimeout(300);
  check('nothing has been saved',
        await p.evaluate(() => JSON.stringify(dayOf(DATE).rates)), '{}');
  check('the button wakes up', await p.locator('#rateApply').isDisabled(), false);
  check('and counts what is waiting',
        (await p.locator('#rateApply').textContent()).trim(), 'Update 1 rate');
  check('the box shows it is unsaved',
        await first.evaluate(el => el.classList.contains('dirty')), true);
  check('and the cursor is still in it — the screen did not redraw',
        await p.evaluate(() => document.activeElement.classList.contains('row-inp')), true);

  console.log('\nand a second one');
  await p.locator('#main input.row-inp').nth(1).fill('45');
  await p.waitForTimeout(300);
  check('both are counted', (await p.locator('#rateApply').textContent()).trim(), 'Update 2 rates');
  check('still nothing saved',
        await p.evaluate(() => JSON.stringify(dayOf(DATE).rates)), '{}');

  console.log('\nthen they go together');
  await p.click('#rateApply');
  await p.waitForTimeout(1400);
  check('both applied at once',
        await p.evaluate(() => JSON.stringify(dayOf(DATE).rates)), '{"1":80,"11":45}');
  check('said so plainly',
        /updated successfully/.test(await p.locator('#main .note').first().textContent()), true);
  check('the button is dead again', await p.locator('#rateApply').isDisabled(), true);
  check('and nothing is left waiting',
        (await p.locator('#rateCount').textContent()).trim(), 'No changes to update');
  check('they reached the server',
        await p.evaluate(() => VFSync.queueLength()), 0);

  console.log('\nand they are the rate everything else uses');
  check('the purchase rate is built on it',
        await p.evaluate(() => purchaseRate('KLP', '1') > 80), true);

  /* ---------------- packing ---------------- */
  console.log('\nbefore anything is packed, nothing has been bought');
  await p.evaluate(() => go('pack'));
  await p.waitForTimeout(600);
  const order = () => p.evaluate(() => Array.prototype.slice.call(
    document.querySelectorAll('#main tbody tr'))
    .map(tr => (tr.children[1].childNodes[0].textContent || '').trim()));
  const start = await order();
  check('every indented product is listed', start.length, 4);
  check('and each says so',
        await p.locator('#main .pill', { hasText: 'Not bought' }).count(), 4);
  check('with all four waiting',
        /4 products still to settle/.test(await p.locator('#main').textContent()), true);

  console.log('\nwhat agrees stays, what does not sinks, what is missing sinks furthest');
  await p.evaluate(() => setPacked('1', 10));    /* exactly as asked */
  await p.waitForTimeout(400);
  await p.evaluate(() => setPacked('11', 3));    /* three of five */
  await p.waitForTimeout(400);
  await p.evaluate(() => setPacked('2', 25));    /* five too many */
  await p.waitForTimeout(400);
  const after = await order();
  check('the one packed right is at the top', after[0], 'Lemon');
  /* both disagree, so they rank together; which of the two comes first
     is the order they were indented in */
  check('the two that disagree come next',
        after.slice(1, 3).sort().join(','), 'Cauliflower,Potato');
  check('and the one nobody bought is last', after[3], 'Cabbage');
  const cell = name => p.locator('#main tbody tr', { hasText: name }).first().textContent();
  check('right is called completed',  /Completed/.test(await cell('Lemon')), true);
  check('short is called short',      /Short packed/.test(await cell('Cauliflower')), true);
  check('over is called over',        /Over packed/.test(await cell('Potato')), true);
  check('and missing is called not bought', /Not bought/.test(await cell('Cabbage')), true);
  check('three still to settle',
        /3 products still to settle/.test(await p.locator('#main').textContent()), true);

  console.log('\nput one right and it climbs back');
  await p.evaluate(() => setPacked('11', 5));
  await p.waitForTimeout(500);
  const fixed = await order();
  check('it is up with the finished ones', fixed.slice(0, 2).join(','), 'Lemon,Cauliflower');
  check('and no longer short',
        /Short packed/.test(await p.locator('#main').textContent()), false);
  check('two left', /2 products still to settle/.test(await p.locator('#main').textContent()), true);

  /* ---------------- the shop's own delivery note ---------------- */
  console.log('\nthe shop is priced without being shown the market rate');
  /* A shop may not read day_rates — the market rate is Velora's cost
     base — so its delivery screen had nothing to price with and put
     0.00 against every line. The database will hand it the rate it is
     actually billed, and that is what it asks for. */
  await p.evaluate(() => {
    dayOf(DATE).ship['KLP'] = 'out';
    setPacked('2', 20);          /* the over-packed one, priced */
    save();
  });
  await p.waitForTimeout(1200);
  await ctx.close();

  const sctx = await b.newContext({ viewport: { width: 1300, height: 950 } });
  const sp = await sctx.newPage();
  sp.on('pageerror', e => console.log('PAGEERROR:', e.message));
  await sp.route('**://*.supabase.co/**', async route => {
    const q = route.request(); const u = new URL(q.url());
    const r = await fetch('http://127.0.0.1:8123' + u.pathname + u.search, {
      method: q.method(), headers: q.headers(),
      body: ['GET', 'HEAD'].includes(q.method()) ? undefined : q.postData(),
    });
    await route.fulfill({ status: r.status, headers: { 'content-type': 'application/json' },
                          body: await r.text() });
  });
  await sp.goto('http://127.0.0.1:8092/index.html', { waitUntil: 'networkidle' });
  await sp.selectOption('#gateWho', 'shop');
  await sp.waitForTimeout(200);
  await sp.fill('#gateName', 'Kilpauk Mgr');
  await sp.fill('#gatePhone', '9000000004');
  await sp.fill('#gatePass', 'shoppass1');
  await sp.click('#gateBtn');
  await sp.waitForTimeout(1600);
  await sp.evaluate(() => go('mydel'));
  await sp.waitForTimeout(2200);

  console.log('  (the delivery note itself)');
  check('it shows what was asked for beside what came',
        (await sp.locator('#main thead th').allTextContents())
          .map(t => t.trim()).filter(Boolean).join(' | '),
        '# | Product | Indent | Delivered | Net kg | Rate/kg | Amount | Status');
  const dline = name => sp.locator('#main tbody tr', { hasText: name }).first();
  check('a line that came as ordered says nothing about it',
        /packed/i.test(await dline('Lemon').textContent()), false);
  /* make one differ and watch the line say so */
  await sp.evaluate(() => { dayOf(DATE).packed[ROLE]['1'] = 99; save(); render(); });
  await sp.waitForTimeout(400);
  check('a line that came over says so',
        /Over packed/.test(await dline('Lemon').textContent()), true);
  await sp.evaluate(() => { dayOf(DATE).packed[ROLE]['1'] = 3; save(); render(); });
  await sp.waitForTimeout(400);
  check('and one that came short says that',
        /Short packed/.test(await dline('Lemon').textContent()), true);
  /* put it back to what was actually packed for the checks below */
  await sp.evaluate(() => { dayOf(DATE).packed[ROLE]['1'] = 10; save(); render(); });
  await sp.waitForTimeout(400);
  check('and every line offers the edit that is coming',
        await sp.locator('#main tbody button:has-text("Edit")').count(),
        await sp.locator('#main tbody tr').count());

  check('the shop still holds no market rates of its own',
        await sp.evaluate(() => JSON.stringify(dayOf(DATE).rates)), '{}');
  const line = name => sp.locator('#main tbody tr', { hasText: name }).first();
  const lemon = (await line('Lemon').textContent()).replace(/\s+/g, ' ');
  check('but the rate is on the line', /83\.20/.test(lemon), true);
  check('and the amount with it', /832\.00/.test(lemon), true);
  check('it asked the database for it rather than working it out',
        received.filter(r => /purchase_rate/.test(r.table)).length > 0, true);

  /* potato was packed but never given a market rate */
  const pot = (await line('Potato').textContent()).replace(/\s+/g, ' ');
  check('a product with no rate says so', /rate not set/.test(pot), true);
  check('rather than showing nothing owed', /0\.00/.test(pot), false);
  check('and the total says how many are unpriced',
        /not priced yet/.test(await sp.locator('#main').textContent()), true);

  await sctx.close();

  /* ---------------- last price, before any bill exists ---------------- */
  console.log('\nthe last price is there before the bill is');
  /* Deliveries are priced the day they go out; the bill comes later.
     Reading the last price only off invoices left the column blank for
     anything delivered since the last billing run — which is most of
     what a shop is looking at — and the estimate came to nothing. */
  const dev = async who => {
    const c = await b.newContext({ viewport: { width: 1360, height: 900 } });
    const q = await c.newPage();
    q.on('pageerror', e => console.log('PAGEERROR:', e.message));
    await q.route('**://*.supabase.co/**', async route => {
      const rq = route.request(); const u = new URL(rq.url());
      const r = await fetch('http://127.0.0.1:8123' + u.pathname + u.search, {
        method: rq.method(), headers: rq.headers(),
        body: ['GET', 'HEAD'].includes(rq.method()) ? undefined : rq.postData(),
      });
      await route.fulfill({ status: r.status, headers: { 'content-type': 'application/json' },
                            body: await r.text() });
    });
    await q.goto('http://127.0.0.1:8092/index.html', { waitUntil: 'networkidle' });
    if (who === 'shop') {
      await q.selectOption('#gateWho', 'shop'); await q.waitForTimeout(200);
      await q.fill('#gateName', 'Kilpauk Mgr'); await q.fill('#gatePhone', '9000000004');
      await q.fill('#gatePass', 'shoppass1');
    } else {
      await q.evaluate(() => setGateWho('admin'));
      await q.fill('#gateEmail', 'owner@velora.example'); await q.fill('#gatePass', 'right');
    }
    await q.click('#gateBtn'); await q.waitForTimeout(1500);
    return { c, q };
  };

  const off = await dev('owner');
  await off.q.evaluate(() => {
    /* yesterday: rates set, packed, received — and no bill raised */
    const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    DB.indents[y] = { KLP: { status: 'accepted', lines: { '6': 58, '259': 1 } } };
    DB.days[y] = { rates: { '6': 40, '259': 18 }, packed: { KLP: { '6': 58, '259': 1 } },
                   ship: { KLP: 'received' }, sent: {} };
    save();
  });
  await off.q.waitForTimeout(1500);
  await off.c.close();

  const sh = await dev('shop');
  received.length = 0;         /* only what the indent screen asks for */
  /* today's indent was accepted earlier in this run, so that screen is
     closed. Tomorrow is where a shop would be typing anyway. */
  await sh.q.evaluate(() => setDate(addDays(DATE, 1)));
  await sh.q.waitForTimeout(2500);
  const cells = async name => (await sh.q.locator('#mylist tbody tr[data-k]', { hasText: name })
                                         .first().locator('td').allTextContents());
  const beet = await cells('Beetroot');
  check('the quantity and day are there', /58 kg/.test(beet[2]), true);
  check('and now the price is too', /₹41\.60/.test(beet[3]), true);   /* 40 + 4% */
  const agathi = await cells('Agathi Keerai');
  check('for a product sold by the piece as well', /₹18\.72/.test(agathi[3]), true);
  /* one request a day, not one a product: two days are involved here,
     yesterday's delivery and today's packing */
  const batch = received.filter(r => r.table === 'rpc:purchase_rates_on').length;
  check('a request a day at most', batch > 0 && batch <= 3, true);
  check('and none product by product',
        received.filter(r => r.table === 'rpc:purchase_rate').length, 0);

  await sh.q.evaluate(() => { indentOf(DATE, ROLE).lines = { '6': 10 }; save(); render(); });
  await sh.q.waitForTimeout(700);
  check('and the estimate is built on it',
        /₹416\.00/.test(await sh.q.locator('.estbar').textContent()), true);
  check('with nothing left uncounted',
        /not counted/.test(await sh.q.locator('.estbar').textContent()), false);
  await sh.c.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
