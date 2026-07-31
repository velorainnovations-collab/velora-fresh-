/* End-to-end login and sync against the mock, in a real browser. */
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
  const dir = '/tmp/velora-shots/';
  require('fs').mkdirSync(dir, { recursive: true });

  async function fresh() {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
    const p = await ctx.newPage();
    p.on('pageerror', e => console.log('PAGEERROR:', e.message));
    // Rewrite calls to the real project onto the mock, so the shipped
    // build is tested unmodified — no test hook in production code.
    await p.route('**://*.supabase.co/**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      const r = await fetch('http://127.0.0.1:8123' + u.pathname + u.search, {
        method: req.method(),
        headers: req.headers(),
        body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postData(),
      });
      await route.fulfill({
        status: r.status,
        headers: { 'content-type': 'application/json' },
        body: await r.text(),
      });
    });
    await p.goto('http://127.0.0.1:8092/index.html', { waitUntil: 'networkidle' });
    return { ctx, p };
  }

  console.log('\ngate');
  let { ctx, p } = await fresh();
  check('gate shown when not signed in', await p.locator('#gate').isVisible(), true);
  check('sign out button hidden',        await p.locator('#signOutBtn').isVisible(), false);

  console.log('\nwrong password');
  await p.fill('#gateEmail', 'owner@velora.example');
  await p.fill('#gatePass', 'wrong');
  await p.click('#gateBtn');
  await p.waitForTimeout(700);
  check('error shown',  /Invalid login/.test(await p.locator('#gateErr').textContent()), true);
  check('still gated',  await p.locator('#gate').isVisible(), true);
  await p.screenshot({ path: dir + 'login-error.png' });

  console.log('\nowner signs in');
  await p.fill('#gatePass', 'right');
  await p.click('#gateBtn');
  await p.waitForTimeout(1200);
  check('gate closed',            await p.locator('#gate').isVisible(), false);
  check('role taken from server', await p.evaluate(() => ROLE), 'owner');
  check('role dropdown locked',   await p.locator('#roleSel').isDisabled(), true);
  check('sign out offered',       await p.locator('#signOutBtn').isVisible(), true);
  check('owner sees Margin master',
        (await p.locator('#nav button').allTextContents()).includes('Margin master'), true);
  await p.screenshot({ path: dir + 'login-owner.png' });
  await ctx.close();

  console.log('\nshop signs in');
  ({ ctx, p } = await fresh());
  await p.fill('#gateEmail', 'shop@velora.example');
  await p.fill('#gatePass', 'right');
  await p.click('#gateBtn');
  await p.waitForTimeout(1200);
  check('role is the shop id', await p.evaluate(() => ROLE), 'KLP');
  const tabs = await p.locator('#nav button').allTextContents();
  check('shop cannot see Rates',         tabs.includes('Rates'), false);
  check('shop cannot see Margin master', tabs.includes('Margin master'), false);
  check('shop sees its own indent',      tabs.includes('My indent'), true);
  await p.screenshot({ path: dir + 'login-shop.png' });
  await ctx.close();

  console.log('\nuninvited account');
  ({ ctx, p } = await fresh());
  await p.fill('#gateEmail', 'stranger@velora.example');
  await p.fill('#gatePass', 'right');
  await p.click('#gateBtn');
  await p.waitForTimeout(1200);
  check('told they have no access',
        /no access yet/.test(await p.locator('#gateErr').textContent()), true);
  check('kept out', await p.locator('#gate').isVisible(), true);
  await ctx.close();

  console.log('\nsync writes');
  ({ ctx, p } = await fresh());
  await p.fill('#gateEmail', 'owner@velora.example');
  await p.fill('#gatePass', 'right');
  await p.click('#gateBtn');
  await p.waitForTimeout(1000);
  received.length = 0;
  await p.evaluate(() => {
    setAnytime(true);
    go('rates');
    // an indent so the rate screen has something to price
    const ind = indentOf(VF.DATE, 'KLP');
    ind.lines = { '1': 12 };
    ind.status = 'accepted';
    save();
    setRate('1', 80);
  });
  await p.waitForTimeout(2500);
  const tables = [...new Set(received.map(r => r.table))];
  check('rate reached the server', tables.includes('day_rates'), true);
  const rateOp = received.find(r => r.table === 'day_rates');
  check('rate value correct', rateOp && rateOp.rows[0].rate, 80);
  check('upsert not insert',  rateOp && rateOp.method, 'POST');

  console.log('\nsigning out');
  await p.click('#signOutBtn');
  await p.waitForTimeout(900);
  check('gate returns', await p.locator('#gate').isVisible(), true);
  await ctx.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
