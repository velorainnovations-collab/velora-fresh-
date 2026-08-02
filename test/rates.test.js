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
require('./mock-supabase.js');

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

  await ctx.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
