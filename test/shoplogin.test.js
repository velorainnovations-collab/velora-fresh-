/*
 * The shop way in: name, phone number, password — all three.
 *
 *   npm run test:shoplogin
 *
 * A shop has no email address, so none of the email screens apply to
 * them. The phone finds the account, the password opens it, and the name
 * has to match the one the office saved against it.
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

async function tryShop(p, name, phone, pw) {
  if (await p.inputValue('#gateWho') !== 'shop') {
    await p.selectOption('#gateWho', 'shop');
    await p.waitForTimeout(150);
  }
  await p.fill('#gateName', name);
  await p.fill('#gatePhone', phone);
  await p.fill('#gatePass', pw);
  await p.click('#gateBtn');
  await p.waitForTimeout(1400);
}

(async () => {
  const b = await chromium.launch();

  console.log('\nnothing is assumed until they say who they are');
  let { ctx, p } = await fresh(b);
  check('the picker is on Select', await p.inputValue('#gateWho'), '');
  check('and asks',
        /Choose who is signing in/.test(await p.locator('#gateHint').textContent()), true);
  check('no fields yet',   await p.locator('#gatePass').isVisible(), false);
  check('no button either', await p.locator('#gateBtn').isVisible(), false);

  console.log('\nwhat a shop is asked for');
  await p.selectOption('#gateWho', 'shop');
  await p.waitForTimeout(200);
  check('asks for a name',     await p.locator('#gateName').isVisible(), true);
  check('asks for a phone',    await p.locator('#gatePhone').isVisible(), true);
  check('asks for a password', await p.locator('#gatePass').isVisible(), true);
  check('no email box',        await p.locator('#gateEmail').isVisible(), false);
  check('no code option',      await p.locator('#gateCodeLink').count(), 0);
  check('told who resets it',
        /ask the office/i.test(await p.locator('#gateLinks').textContent()), true);

  console.log('\nall three right');
  await tryShop(p, 'Kilpauk Mgr', '9000000004', 'shoppass1');
  check('gets in', await p.locator('#gate').isVisible(), false);
  check('as their own shop', await p.evaluate(() => ROLE), 'KLP');
  await ctx.close();

  console.log('\nthe name has to match');
  ({ ctx, p } = await fresh(b));
  await tryShop(p, 'Somebody Else', '9000000004', 'shoppass1');
  check('kept out', await p.locator('#gate').isVisible(), true);
  check('and told why',
        /name does not match/.test(await p.locator('#gateErr').textContent()), true);
  check('not left signed in underneath',
        await p.evaluate(() => VFSync.signedIn()), false);

  console.log('\nspelling is not the point');
  await tryShop(p, '  kilpauk   mgr.  ', '9000000004', 'shoppass1');
  check('case and spacing forgiven', await p.locator('#gate').isVisible(), false);
  await ctx.close();

  console.log('\nthe password still has to be right');
  ({ ctx, p } = await fresh(b));
  await tryShop(p, 'Kilpauk Mgr', '9000000004', 'wrongpass');
  check('kept out', await p.locator('#gate').isVisible(), true);
  check('says the phone or password',
        /phone number and password/.test(await p.locator('#gateErr').textContent()), true);

  console.log('\nand a phone nobody has');
  await tryShop(p, 'Kilpauk Mgr', '9999999999', 'shoppass1');
  check('kept out', await p.locator('#gate').isVisible(), true);
  check('same wording either way, so a number cannot be probed',
        /phone number and password/.test(await p.locator('#gateErr').textContent()), true);

  console.log('\nhalf-filled forms are refused before any request');
  received.length = 0;
  await p.selectOption('#gateWho', 'shop');
  await p.waitForTimeout(150);
  await p.fill('#gateName', 'Kilpauk Mgr');
  await p.fill('#gatePhone', '90000');
  await p.fill('#gatePass', 'shoppass1');
  await p.click('#gateBtn');
  await p.waitForTimeout(400);
  check('told the number is short',
        /ten digit/.test(await p.locator('#gateErr').textContent()), true);
  await ctx.close();

  console.log('\na login made under the older shape still opens');
  ({ ctx, p } = await fresh(b));
  await tryShop(p, 'Nungambakkam Mgr', '9000000005', 'oldshape1');
  check('gets in', await p.locator('#gate').isVisible(), false);
  check('as their own shop', await p.evaluate(() => ROLE), 'NGB');
  await ctx.close();

  console.log('\nan office role is asked for different things');
  ({ ctx, p } = await fresh(b));
  await p.selectOption('#gateWho', 'ho');
  await p.waitForTimeout(200);
  check('email box back',   await p.locator('#gateEmail').isVisible(), true);
  check('name box gone',    await p.locator('#gateName').isVisible(), false);
  check('code option back', await p.locator('#gateCodeLink').count(), 1);
  await p.fill('#gateEmail', 'owner@velora.example');
  await p.fill('#gatePass', 'right');
  await p.click('#gateBtn');
  await p.waitForTimeout(1400);
  check('owner still gets in', await p.locator('#gate').isVisible(), false);
  await ctx.close();

  console.log('\nthe choice is remembered');
  ({ ctx, p } = await fresh(b));
  await p.selectOption('#gateWho', 'shop');
  await p.waitForTimeout(200);
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(600);
  check('still on shop after a refresh', await p.inputValue('#gateWho'), 'shop');
  check('so nobody at a shop picks twice',
        await p.locator('#gateName').isVisible(), true);
  await ctx.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
