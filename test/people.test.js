/*
 * Users screen — end to end in a real browser against the mock.
 *
 *   npm run test:people
 *
 * The screen is only a convenience: every function it calls re-checks
 * is_owner() inside the database (supabase/test_users.sql covers that).
 * What is checked here is that the screen shows the right people, hides
 * itself from the wrong role, and sends the right arguments.
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
  const dir = '/tmp/velora-shots/';
  require('fs').mkdirSync(dir, { recursive: true });

  async function signedInAs(email) {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } });
    const p = await ctx.newPage();
    p.on('pageerror', e => console.log('PAGEERROR:', e.message));
    await p.route('**://*.supabase.co/**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      const r = await fetch('http://127.0.0.1:8123' + u.pathname + u.search, {
        method: req.method(), headers: req.headers(),
        body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postData(),
      });
      await route.fulfill({ status: r.status, headers: { 'content-type': 'application/json' },
                            body: await r.text() });
    });
    await p.goto('http://127.0.0.1:8092/index.html', { waitUntil: 'networkidle' });
    await p.fill('#gateEmail', email);
    await p.fill('#gatePass', 'right');
    await p.click('#gateBtn');
    await p.waitForTimeout(1200);
    return { ctx, p };
  }

  console.log('\nowner');
  let { ctx, p } = await signedInAs('owner@velora.example');

  const groups = await p.locator('#side .grp>button').allTextContents();
  check('Master group present', groups.some(g => /Master/.test(g)), true);

  await p.evaluate(() => go('people'));
  await p.waitForTimeout(900);
  check('screen title', (await p.locator('#main h2').textContent()).trim(), 'Users');
  check('three people listed', await p.locator('#main .card:nth-of-type(2) tbody tr').count(), 3);
  check('one invite listed', await p.locator('#main .card:nth-of-type(3) tbody tr').count(), 1);
  check('own row is not editable',
    await p.locator('#main .pill.p-green', { hasText: 'you' }).count(), 1);
  await p.screenshot({ path: dir + 'people.png', fullPage: true });

  console.log('\nadding a person');
  received.length = 0;
  await p.fill('#npName', 'Test Friend');
  await p.fill('#npPhone', '9876543210');
  await p.selectOption('#npRole', 'admin');
  await p.click('button:has-text("Add")');
  await p.waitForTimeout(900);
  const inv = received.find(r => r.table === 'rpc:invite_person');
  check('invite_person called', !!inv, true);
  check('role sent',  inv && inv.rows.p_role, 'admin');
  check('phone sent', inv && inv.rows.p_phone, '9876543210');
  check('no shop for a manager', inv && inv.rows.p_shop_id, 'null');
  check('list refreshed', await p.locator('#main .card:nth-of-type(3) tbody tr').count(), 2);

  console.log('\ncreating a login with a password');
  received.length = 0;
  await p.fill('#npName', 'Made Manager');
  await p.fill('#npEmail', 'made@velora.example');
  await p.selectOption('#npRole', 'admin');
  await p.click('button[title="Suggest one"]');
  const suggested = await p.inputValue('#npPass');
  check('a password is suggested', suggested.length, 10);
  check('no easily confused characters', /[lIO01]/.test(suggested), false);

  let shown = '';
  p.once('dialog', async d => { shown = d.message(); await d.accept(); });
  await p.click('button:has-text("Add")');
  await p.waitForTimeout(900);
  const made = received.find(r => r.table === 'fn:create-user');
  check('the edge function was called', !!made, true);
  check('password sent', made && made.rows.password, suggested);
  check('role sent', made && made.rows.role, 'admin');
  check('owner is shown the credentials', /made@velora.example/.test(shown), true);
  check('and the password', shown.indexOf(suggested) > -1, true);

  console.log('\na short password never reaches the server');
  received.length = 0;
  let refused = '';
  p.once('dialog', async d => { refused = d.message(); await d.accept(); });
  await p.fill('#npName', 'Too Short');
  await p.fill('#npEmail', 'short2@velora.example');
  await p.fill('#npPass', 'abc');
  await p.click('button:has-text("Add")');
  await p.waitForTimeout(500);
  check('refused locally', /at least 8/.test(refused), true);
  check('nothing sent', received.filter(r => r.table === 'fn:create-user').length, 0);
  await p.fill('#npPass', '');

  console.log('\nshop role requires a shop');
  await p.selectOption('#npRole', 'shop');
  await p.waitForTimeout(200);
  check('shop picker appears', await p.locator('#npShop').isVisible(), true);
  received.length = 0;
  await p.fill('#npName', 'Shop Person');
  await p.fill('#npPhone', '9000011111');
  await p.selectOption('#npShop', 'MBK');
  await p.click('button:has-text("Add")');
  await p.waitForTimeout(900);
  const inv2 = received.find(r => r.table === 'rpc:invite_person');
  check('shop id sent', inv2 && inv2.rows.p_shop_id, 'MBK');
  check('client id sent', inv2 && inv2.rows.p_client_id, 'KPN');

  console.log('\ndeactivating');
  received.length = 0;
  await p.click('button:has-text("Deactivate")');
  await p.waitForTimeout(900);
  const off = received.find(r => r.table === 'rpc:set_person_active');
  check('set_person_active called', !!off, true);
  check('sent active=false', off && off.rows.p_active, 'false');

  console.log('\ncancelling an invite');
  received.length = 0;
  p.once('dialog', d => d.accept());
  await p.click('button:has-text("Cancel")');
  await p.waitForTimeout(900);
  check('cancel_invite called',
    !!received.find(r => r.table === 'rpc:cancel_invite'), true);

  await ctx.close();

  console.log('\nnot the owner');
  ({ ctx, p } = await signedInAs('shop@velora.example'));
  const shopGroups = await p.locator('#side .grp>button').allTextContents();
  check('shop has no Master group', shopGroups.some(g => /Master/.test(g)), false);
  // Asked for directly, the router refuses before the view is reached:
  // render() resets a tab the role has no claim to. vPeople's own
  // "only an owner" guard is the second line, and the database is the
  // third — every function it calls re-checks is_owner().
  await p.evaluate(() => go('people'));
  await p.waitForTimeout(400);
  check('router redirects away from people', await p.evaluate(() => TAB) !== 'people', true);
  check('lands on its own screen', await p.evaluate(() => TAB), 'myindent');
  check('no users table rendered',
    /Add a person/.test(await p.locator('#main').textContent()), false);

  // and the view itself refuses if it is ever reached another way
  check('view guard refuses a shop user',
    await p.evaluate(() => /Only an owner/.test(vPeople())), true);
  await ctx.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
