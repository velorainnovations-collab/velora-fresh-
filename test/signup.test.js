/*
 * Creating an account.
 *
 *   npm run test:signup
 *
 * The owner records an invite; the person makes their own account. Sign
 * up was missing entirely, so an invited person had no way in — the
 * gate only signed people in.
 *
 * Leaving sign up open is safe, and this checks that: an account with
 * no invite authenticates and then sees nothing at all.
 */
const { chromium } = require('playwright');
const { received } = require('./mock-supabase.js');

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = String(got) === String(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ->  ' + got + (ok ? '' : '   (expected ' + want + ')'));
  ok ? pass++ : fail++;
}

async function fresh(b) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
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
  return { ctx, p };
}

(async () => {
  const b = await chromium.launch();

  console.log('\nthe gate offers both');
  let { ctx, p } = await fresh(b);
  check('starts on sign in', (await p.locator('#gateBtn').textContent()).trim(), 'Sign in');
  check('a way to create an account is offered',
        await p.locator('#gateSwap').isVisible(), true);

  await p.click('#gateSwap');
  await p.waitForTimeout(200);
  check('switches to create', (await p.locator('#gateBtn').textContent()).trim(), 'Create account');
  check('hint changes',
        /Create your account/.test(await p.locator('#gateHint').textContent()), true);
  await p.click('#gateSwap');
  await p.waitForTimeout(200);
  check('switches back', (await p.locator('#gateBtn').textContent()).trim(), 'Sign in');

  console.log('\na short password is refused before it is sent');
  await p.click('#gateSwap');
  await p.waitForTimeout(200);
  received.length = 0;
  await p.fill('#gateEmail', 'short@velora.example');
  await p.fill('#gatePass', 'abc');
  await p.click('#gateBtn');
  await p.waitForTimeout(500);
  check('told to use 8 characters',
        /at least 8/.test(await p.locator('#gateErr').textContent()), true);
  check('nothing sent to the server',
        received.filter(r => r.table === 'auth:signup').length, 0);
  await ctx.close();

  console.log('\nan invited person gets in');
  ({ ctx, p } = await fresh(b));
  await p.click('#gateSwap');
  await p.waitForTimeout(200);
  await p.fill('#gateEmail', 'invited@velora.example');
  await p.fill('#gatePass', 'agoodpassword');
  await p.click('#gateBtn');
  await p.waitForTimeout(1500);
  check('gate closed', await p.locator('#gate').isVisible(), false);
  check('given the invited role', await p.evaluate(() => ROLE), 'admin');
  check('shown as Manager, not admin',
        /Manager/.test(await p.locator('#whoami').textContent()), true);
  await ctx.close();

  console.log('\nan uninvited person gets nothing');
  ({ ctx, p } = await fresh(b));
  await p.click('#gateSwap');
  await p.waitForTimeout(200);
  await p.fill('#gateEmail', 'stranger2@velora.example');
  await p.fill('#gatePass', 'agoodpassword');
  await p.click('#gateBtn');
  await p.waitForTimeout(1500);
  check('kept at the gate', await p.locator('#gate').isVisible(), true);
  check('told to ask the owner',
        /has not given it access/.test(await p.locator('#gateErr').textContent()), true);
  check('signed back out', await p.evaluate(() => VFSync.signedIn()), false);
  await ctx.close();

  console.log('\nan address already registered');
  ({ ctx, p } = await fresh(b));
  await p.click('#gateSwap');
  await p.waitForTimeout(200);
  await p.fill('#gateEmail', 'owner@velora.example');
  await p.fill('#gatePass', 'agoodpassword');
  await p.click('#gateBtn');
  await p.waitForTimeout(1200);
  check('told the account exists',
        /already registered/i.test(await p.locator('#gateErr').textContent()), true);
  await ctx.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
