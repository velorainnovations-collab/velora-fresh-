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
    if (typeof setGateWho === 'function' && GATE_MODE !== 'set') setGateWho('office');
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

  console.log('\na url the role may not have');
  await ctx.close();
  const ctx2 = await ctxFor(b);
  const p2 = await ctx2.newPage();
  await p2.goto('http://127.0.0.1:8092/index.html#master', { waitUntil: 'networkidle' });
  await p2.evaluate(() => setGateWho('office'));
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
