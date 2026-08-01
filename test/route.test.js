/*
 * The screen survives a refresh.
 *
 *   npm run test:route
 *
 * The current screen lives in the address bar. Refreshing used to drop
 * you back on the first tab, which is maddening halfway through
 * entering a day's rates.
 */
const { chromium } = require('playwright');
require('./mock-supabase.js');

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = String(got) === String(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ->  ' + got + (ok ? '' : '   (expected ' + want + ')'));
  ok ? pass++ : fail++;
}

async function ctxFor(b) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('**://*.supabase.co/**', async route => {
    const req = route.request(); const u = new URL(req.url());
    const r = await fetch('http://127.0.0.1:8123' + u.pathname + u.search, {
      method: req.method(), headers: req.headers(),
      body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postData(),
    });
    await route.fulfill({ status: r.status, headers: { 'content-type': 'application/json' },
                          body: await r.text() });
  });
  return ctx;
}

(async () => {
  const b = await chromium.launch();
  const ctx = await ctxFor(b);
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('PAGEERROR:', e.message));

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

  console.log('\nthe url follows the screen');
  await p.evaluate(() => go('rates'));
  await p.waitForTimeout(300);
  check('hash names the screen', new URL(p.url()).hash, '#rates');

  await p.evaluate(() => go('products'));
  await p.waitForTimeout(300);
  check('hash follows a second move', new URL(p.url()).hash, '#products');

  console.log('\nrefresh stays put');
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  check('still on products after a refresh', await p.evaluate(() => TAB), 'products');
  check('the screen really rendered',
        /Product list/.test(await p.locator('#main h2').textContent()), true);

  console.log('\na deeper screen');
  await p.evaluate(() => go('acct'));
  await p.waitForTimeout(300);
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  check('accounts survives a refresh', await p.evaluate(() => TAB), 'acct');

  console.log('\nthe date rides along');
  await p.evaluate(() => { setDate('2026-07-20'); });
  await p.waitForTimeout(300);
  check('hash carries the date', new URL(p.url()).hash, '#acct/2026-07-20');
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  check('date survives a refresh', await p.evaluate(() => VF.DATE), '2026-07-20');

  console.log('\nback and forward');
  await p.evaluate(() => { setDate(todayISO()); go('rates'); });
  await p.waitForTimeout(300);
  await p.evaluate(() => go('vendors'));
  await p.waitForTimeout(300);
  // replaceState is used for screen changes, so back leaves the app
  // rather than walking a long trail — check the app did not break
  check('still on vendors', await p.evaluate(() => TAB), 'vendors');

  console.log('\nthe menu keeps one group open');
  const openNames = () => p.locator('#side .grp.open>button').allTextContents();
  await p.evaluate(() => go('rates'));
  await p.waitForTimeout(300);
  let open = await openNames();
  check('the screen you are on opens its group', open.length, 1);
  check('and it is the right one', /Purchase/.test(open[0]), true);

  await p.locator('#side .grp>button', { hasText: 'Delivery' }).click();
  await p.waitForTimeout(300);
  open = await openNames();
  check('opening another closes the first', open.length, 1);
  check('the new one is open', /Delivery/.test(open[0]), true);
  check('the screen did not move', await p.evaluate(() => TAB), 'rates');

  await p.locator('#side .grp>button', { hasText: 'Delivery' }).click();
  await p.waitForTimeout(300);
  check('a second press closes it again', (await openNames()).length, 0);

  await p.evaluate(() => go('orders'));
  await p.waitForTimeout(300);
  open = await openNames();
  check('going somewhere opens that group', open.length, 1);
  check('and only that one', /Purchase/.test(open[0]), true);

  console.log('\nrefreshing does not flash the day board first');
  /* whoami is held back on purpose: the gap it opens is the one the
     screen used to fill with the first tab this role can reach. */
  const slow = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await slow.route('**://*.supabase.co/**', async route => {
    const req = route.request(); const u = new URL(req.url());
    if (/app_users/.test(u.pathname)) await new Promise(r => setTimeout(r, 1200));
    const r = await fetch('http://127.0.0.1:8123' + u.pathname + u.search, {
      method: req.method(), headers: req.headers(),
      body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postData(),
    });
    await route.fulfill({ status: r.status, headers: { 'content-type': 'application/json' },
                          body: await r.text() });
  });
  const ps = await slow.newPage();
  await ps.goto('http://127.0.0.1:8092/index.html', { waitUntil: 'networkidle' });
  await ps.evaluate(() => setGateWho('admin'));
  await ps.fill('#gateEmail', 'owner@velora.example');
  await ps.fill('#gatePass', 'right');
  await ps.click('#gateBtn');
  await ps.waitForTimeout(2200);
  await ps.evaluate(() => go('rates'));
  await ps.waitForTimeout(300);

  await ps.reload({ waitUntil: 'domcontentloaded' });
  await ps.waitForTimeout(500);           // whoami still in flight
  const mid = await ps.locator('#main').textContent();
  check('held while the session is checked', /Opening your screen/.test(mid), true);
  check('the day board is not shown on the way', /Day board/.test(mid), false);
  await ps.waitForTimeout(2000);
  check('lands on the screen it was left on', await ps.evaluate(() => TAB), 'rates');
  check('and really drew it', /Market rate|Rates/i.test(
        await ps.locator('#main h2').textContent()), true);
  await slow.close();

  console.log('\na url the role may not have');
  await ctx.close();
  const ctx2 = await ctxFor(b);
  const p2 = await ctx2.newPage();
  await p2.goto('http://127.0.0.1:8092/index.html#master', { waitUntil: 'networkidle' });
  await p2.evaluate(() => setGateWho('admin'));
  await p2.fill('#gateEmail', 'shop@velora.example');
  await p2.fill('#gatePass', 'right');
  await p2.click('#gateBtn');
  await p2.waitForTimeout(1200);
  check('shop asking for master is redirected', await p2.evaluate(() => TAB), 'myindent');
  check('url corrected too', new URL(p2.url()).hash, '#myindent');
  await ctx2.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
