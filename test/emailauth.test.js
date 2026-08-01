/*
 * Signing in by emailed code, and resetting a forgotten password.
 *
 *   npm run test:emailauth
 *
 * Owner, admin and head office have real email addresses, so Supabase
 * sends the code and the reset link itself. Shop staff do not — their
 * login comes from their phone and the owner resets it on WhatsApp.
 */
const { chromium } = require('playwright');
const { received } = require('./mock-supabase.js');

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = String(got) === String(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ->  ' + got + (ok ? '' : '   (expected ' + want + ')'));
  ok ? pass++ : fail++;
}

async function fresh(b, url) {
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
  await p.goto(url || 'http://127.0.0.1:8092/index.html', { waitUntil: 'networkidle' });
  /* Everyone below signs in with an email, and the gate opens on the
     Shop tab. Pick Office first, as a person at a desk would. Skipped on
     the reset-password screen, which has no tabs. */
  await p.evaluate(() => {
    if (typeof setGateWho === 'function' && GATE_MODE !== 'set') setGateWho('office');
  });
  await p.waitForTimeout(300);
  return { ctx, p };
}

(async () => {
  const b = await chromium.launch();

  console.log('\nwhat the gate offers');
  let { ctx, p } = await fresh(b);
  const links = await p.locator('#gateLinks').textContent();
  check('a code option', /Email me a code/.test(links), true);
  check('a forgot option', /Forgot password/.test(links), true);
  check('a create option', /Create your account/.test(links), true);

  console.log('\nsigning in with a code');
  received.length = 0;
  await p.click('a:has-text("Email me a code instead")');
  await p.waitForTimeout(200);
  check('password field hidden', await p.locator('#gatePassWrap').isVisible(), false);
  check('button asks to send', (await p.locator('#gateBtn').textContent()).trim(), 'Email me a code');

  await p.fill('#gateEmail', 'owner@velora.example');
  await p.click('#gateBtn');
  await p.waitForTimeout(800);
  check('a code was requested',
        !!received.find(r => r.table === 'auth:otp'), true);
  check('code box appears', await p.locator('#gateCodeWrap').isVisible(), true);
  check('told where it went',
        /Code sent to owner@velora.example/.test(await p.locator('#gateErr').textContent()), true);

  await p.fill('#gateCode', '000000');
  await p.click('#gateBtn');
  await p.waitForTimeout(800);
  check('a wrong code is refused', await p.locator('#gate').isVisible(), true);
  check('and says so',
        /expired|invalid/i.test(await p.locator('#gateErr').textContent()), true);

  await p.fill('#gateCode', '654321');
  await p.click('#gateBtn');
  await p.waitForTimeout(1400);
  check('the right code gets in', await p.locator('#gate').isVisible(), false);
  check('as the right person', await p.evaluate(() => ROLE), 'owner');
  await ctx.close();

  console.log('\nforgetting a password');
  ({ ctx, p } = await fresh(b));
  received.length = 0;
  await p.click('a:has-text("Forgot password")');
  await p.waitForTimeout(200);
  await p.fill('#gateEmail', 'owner@velora.example');
  await p.click('#gateBtn');
  await p.waitForTimeout(800);
  check('a reset was requested',
        !!received.find(r => r.table === 'auth:recover'), true);
  check('back on the password form',
        (await p.locator('#gateBtn').textContent()).trim(), 'Sign in');
  check('told to check email',
        /reset link is on its way/.test(await p.locator('#gateErr').textContent()), true);

  console.log('\nan address that does not exist says the same thing');
  received.length = 0;
  await p.click('a:has-text("Forgot password")');
  await p.waitForTimeout(200);
  await p.fill('#gateEmail', 'nobody@velora.example');
  await p.click('#gateBtn');
  await p.waitForTimeout(800);
  check('same wording, so accounts cannot be probed',
        /reset link is on its way/.test(await p.locator('#gateErr').textContent()), true);
  await ctx.close();

  console.log('\nfollowing the reset link');
  ({ ctx, p } = await fresh(b,
    'http://127.0.0.1:8092/index.html#access_token=tok-aaaa0000-0000-0000-0000-00000000000a'
    + '&refresh_token=r&type=recovery'));
  await p.waitForTimeout(900);
  check('asked for a new password',
        /Choose a new password/.test(await p.locator('#gateHint').textContent()), true);
  check('email box hidden — we know who it is',
        await p.locator('#gateEmail').isVisible(), false);
  check('the token is stripped from the address bar',
        /access_token/.test(p.url()), false);

  received.length = 0;
  await p.fill('#gatePass', 'short');
  await p.click('#gateBtn');
  await p.waitForTimeout(400);
  check('a short one is refused before sending',
        /at least 8/.test(await p.locator('#gateErr').textContent()), true);
  check('nothing sent', received.filter(r => r.table === 'auth:setpassword').length, 0);

  await p.fill('#gatePass', 'abrandnewone');
  await p.click('#gateBtn');
  await p.waitForTimeout(900);
  const setP = received.find(r => r.table === 'auth:setpassword');
  check('the new password was saved', !!setP, true);
  check('told to sign in with it',
        /Password saved/.test(await p.locator('#gateErr').textContent()), true);

  await p.fill('#gateEmail', 'owner@velora.example');
  await p.fill('#gatePass', 'abrandnewone');
  await p.click('#gateBtn');
  await p.waitForTimeout(1400);
  check('the new password works', await p.locator('#gate').isVisible(), false);
  await ctx.close();

  console.log('\ncreating an account that sets its own first password');
  ({ ctx, p } = await fresh(b));
  let said = '';
  p.on('dialog', d => { said = d.message(); d.accept(); });
  await p.fill('#gateEmail', 'owner@velora.example');
  await p.fill('#gatePass', 'abrandnewone');   // set by the reset above
  await p.click('#gateBtn');
  await p.waitForTimeout(1200);
  /* an owner may read every row, so this is the row that matters */
  check('signed in as our own row, not the first one back',
        await p.evaluate(() => ME && ME.id), 'aaaa0000-0000-0000-0000-00000000000a');
  await p.evaluate(() => go('people'));
  await p.waitForTimeout(700);

  received.length = 0;
  await p.fill('#npName', 'New Manager');
  await p.fill('#npEmail', 'newmgr@velora.example');
  await p.selectOption('#npRole', 'admin');
  await p.fill('#npPass', '');
  await p.click('button:has-text("Add")');
  await p.waitForTimeout(1100);
  const made = received.find(r => r.table === 'fn:create-user');
  check('the account is created, not just pencilled in', !!made, true);
  check('by invitation', made && made.rows.action, 'invite');
  check('with no password of ours', made && (made.rows.password || ''), '');
  check('the link comes back to this app',
        made && /index\.html$/.test(made.rows.redirect_to || ''), true);
  check('no invite row instead',
        received.filter(r => r.table === 'rpc:invite_person').length, 0);
  check('the owner is told an email went out', /emailed a link/.test(said), true);
  await ctx.close();

  console.log('\nfollowing the invite link');
  ({ ctx, p } = await fresh(b,
    'http://127.0.0.1:8092/index.html#access_token=tok-aaaa0000-0000-0000-0000-00000000000a'
    + '&refresh_token=r&type=invite'));
  await p.waitForTimeout(900);
  check('welcomed and asked for a password',
        /Choose the password/.test(await p.locator('#gateHint').textContent()), true);
  check('button says save',
        (await p.locator('#gateBtn').textContent()).trim(), 'Save password');
  received.length = 0;
  await p.fill('#gatePass', 'theirownone');
  await p.click('#gateBtn');
  await p.waitForTimeout(900);
  check('their password is saved',
        !!received.find(r => r.table === 'auth:setpassword'), true);
  await ctx.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
