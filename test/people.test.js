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
const { received, opts } = require('./mock-supabase.js');

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
    /* Everyone below signs in with an email, and the gate opens on the
       Shop tab. Pick Office first, as a person at a desk would. Skipped on
       the reset-password screen, which has no tabs. */
    await p.evaluate(() => {
      if (typeof setGateWho === 'function' && GATE_MODE !== 'set') setGateWho('admin');
    });
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

  console.log('\nthe form waits for the role');
  check('only the role is asked at first',
        await p.locator('#npName').isVisible(), false);
  check('and no email box either',  await p.locator('#npEmail').isVisible(), false);
  check('nothing to press yet',     await p.locator('#npAddBtn').isVisible(), false);
  check('says what to do',
        /Choose the role first/.test(await p.locator('#npHint').textContent()), true);
  await p.selectOption('#npRole', 'admin');
  await p.waitForTimeout(200);
  check('the rest arrives once answered',
        await p.locator('#npName').isVisible(), true);
  check('and the button with it', await p.locator('#npAddBtn').isVisible(), true);
  check('the role itself is marked required',
        await p.locator('#npRole').locator('xpath=../label/b[@class="req"]').count(), 1);

  console.log('\nadding a person');
  received.length = 0;
  await p.fill('#npName', 'Test Friend');
  await p.fill('#npPhone', '9876543210');
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
  await p.selectOption('#npRole', 'admin');
  await p.waitForTimeout(200);
  await p.fill('#npName', 'Made Manager');
  await p.fill('#npEmail', 'made@velora.example');
  await p.click('button[title="Suggest one"]');
  const suggested = await p.inputValue('#npPass');
  check('a password is suggested', suggested.length, 10);
  check('no easily confused characters', /[lIO01]/.test(suggested), false);

  await p.click('button:has-text("Add")');
  await p.waitForTimeout(1200);
  const made = received.find(r => r.table === 'fn:create-user');
  check('the edge function was called', !!made, true);
  check('password sent', made && made.rows.password, suggested);
  check('role sent', made && made.rows.role, 'admin');

  const panel = await p.locator('#main').textContent();
  check('credentials shown on screen', /Login created for/.test(panel), true);
  check('the login id is shown', /made@velora.example/.test(panel), true);
  check('the password is shown', panel.indexOf(suggested) > -1, true);
  check('a copy button is offered',
        await p.locator('button:has-text("Copy")').count(), 1);
  await p.click('button:has-text("Done")');
  await p.waitForTimeout(400);
  check('panel clears once done',
        /Login created for/.test(await p.locator('#main').textContent()), false);

  console.log('\na shop person with no email');
  received.length = 0;
  await p.selectOption('#npRole', 'shop');
  await p.waitForTimeout(200);
  await p.fill('#npName', 'Kilpauk Evening');
  await p.fill('#npPhone', '98400 55555');
  check('no email box for a shop — they have no address',
        await p.locator('#npEmail').isVisible(), false);
  await p.selectOption('#npShop', 'KLP');
  await p.click('button[title="Suggest one"]');
  const shopPass = await p.inputValue('#npPass');
  await p.click('button:has-text("Add")');
  await p.waitForTimeout(1200);
  const shopMade = received.find(r => r.table === 'fn:create-user');
  check('created without an email being typed', !!shopMade, true);
  check('login id built from the phone alone, so the gate can rebuild it',
        shopMade && shopMade.rows.email, 'p9840055555@shop.velorafresh.in');
  check('the phone is kept too', shopMade && shopMade.rows.phone, '9840055555');
  check('shop id sent', shopMade && shopMade.rows.shop_id, 'KLP');
  const shopPanel = await p.locator('#main').textContent();
  /* the derived id is never shown to a shop — they type name, phone and
     password, so those are what the panel hands over */
  check('the three things they will type are shown',
        /Kilpauk Evening/.test(shopPanel) && /9840055555/.test(shopPanel), true);
  check('the derived id is not put in front of them',
        /shop\.velorafresh\.in/.test(shopPanel), false);
  check('WhatsApp offered, since a phone is on file',
        await p.locator('button:has-text("Send on WhatsApp")').count(), 1);

  await p.evaluate(() => { window.__opened = null; window.open = u => { window.__opened = u; return {}; }; });
  await p.click('button:has-text("Send on WhatsApp")');
  await p.waitForTimeout(300);
  const waUrl = await p.evaluate(() => window.__opened);
  check('sent to their number', /wa\.me\/919840055555/.test(waUrl || ''), true);
  const waText = decodeURIComponent(waUrl || '');
  check('message tells them which tab', waText.indexOf('Shop') > -1, true);
  check('message carries the name',  waText.indexOf('Kilpauk Evening') > -1, true);
  check('message carries the phone', waText.indexOf('9840055555') > -1, true);
  check('message carries the password', waText.indexOf(shopPass) > -1, true);
  await p.click('button:has-text("Done")');
  await p.waitForTimeout(300);
  await p.selectOption('#npRole', 'admin');
  await p.waitForTimeout(200);
  await p.fill('#npPhone', '');

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

  console.log('\nand nobody is added without a name');
  received.length = 0;
  refused = '';
  p.once('dialog', async d => { refused = d.message(); await d.accept(); });
  await p.fill('#npName', '');
  await p.click('button:has-text("Add")');
  await p.waitForTimeout(500);
  check('asked for the name', /name/i.test(refused), true);
  check('nothing sent', received.length, 0);
  await p.fill('#npEmail', '');

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

  console.log('\nresetting a forgotten password');
  received.length = 0;
  p.once('dialog', async d => { await d.accept(); });   // confirm
  await p.click('button:has-text("Reset password")');
  await p.waitForTimeout(1200);
  const reset = received.find(r => r.table === 'fn:create-user' && r.rows.action === 'reset');
  check('reset called', !!reset, true);
  check('a user id was sent', !!(reset && reset.rows.user_id), true);
  check('a fresh password was generated',
        reset && reset.rows.password && reset.rows.password.length, 10);
  check('no confusable characters', /[lIO01]/.test(reset ? reset.rows.password : 'l'), false);
  const rPanel = await p.locator('#main').textContent();
  check('shown as a reset, not a new login', /New password for/.test(rPanel), true);
  check('the new password is on screen',
        rPanel.indexOf(reset.rows.password) > -1, true);
  await p.click('button:has-text("Done")');
  await p.waitForTimeout(400);

  console.log('\ndeleting somebody for good');
  const before = await p.locator('#main .card:nth-of-type(2) tbody tr').count();
  received.length = 0;
  let asked = '';
  p.once('dialog', async d => { asked = d.message(); await d.dismiss(); });
  await p.locator('#main tbody tr', { hasText: 'Kilpauk Mgr' })
         .locator('button:has-text("Delete")').click();
  await p.waitForTimeout(600);
  check('the name is put in front of them', /Kilpauk Mgr/.test(asked), true);
  check('and what it means is spelt out', /cannot sign in again/.test(asked), true);
  check('says what to do instead', /Deactivate/.test(asked), true);
  check('saying no sends nothing', received.length, 0);
  check('and changes nothing',
        await p.locator('#main .card:nth-of-type(2) tbody tr').count(), before);

  received.length = 0;
  p.once('dialog', async d => { await d.accept(); });
  await p.locator('#main tbody tr', { hasText: 'Kilpauk Mgr' })
         .locator('button:has-text("Delete")').click();
  await p.waitForTimeout(1200);
  const gone = received.find(r => r.table === 'fn:create-user' && r.rows.action === 'delete');
  check('the edge function was asked to delete', !!gone, true);
  check('by id', !!(gone && gone.rows.user_id), true);
  check('the list is one shorter',
        await p.locator('#main .card:nth-of-type(2) tbody tr').count(), before - 1);
  check('and that person is off the screen',
        await p.locator('#main tbody tr', { hasText: 'Kilpauk Mgr' }).count(), 0);

  console.log('\nand when the project has an older function than this code');
  /* it does not know the delete action, falls through to the create path
     and asks for an email address — which is no answer to "remove this
     person", and it used to stop the delete outright */
  opts.oldCreateUser = true;
  received.length = 0;
  let told = '';
  p.on('dialog', async d => { told = d.message(); await d.accept(); });
  const left = await p.locator('#main .card:nth-of-type(2) tbody tr').count();
  await p.locator('#main tbody tr', { hasText: 'Day Manager' })
         .locator('button:has-text("Delete")').click();
  await p.waitForTimeout(1400);
  const rowGone = received.find(r => r.method === 'DELETE' && /^app_users/.test(r.table));
  check('the access is removed anyway', !!rowGone, true);
  check('by id', /id=eq\./.test(rowGone ? rowGone.table : ''), true);
  check('and it is gone from the list',
        await p.locator('#main .card:nth-of-type(2) tbody tr').count(), left - 1);
  check('no nonsense about an email address', /email address is required/i.test(told), false);
  check('told the sign-in itself is still there', /still on the server/.test(told), true);
  opts.oldCreateUser = false;
  p.removeAllListeners('dialog');

  /* The address and number come free with the person. Deleting Kilpauk
     Mgr above must release p9000000004@shop.velorafresh.in and the
     phone behind it, or the replacement cannot be hired. */
  console.log('\na deleted login frees its email and phone');
  received.length = 0;
  p.on('dialog', async d => { await d.accept(); });
  await p.selectOption('#npRole', 'shop');
  await p.waitForTimeout(200);
  await p.selectOption('#npShop', 'KLP');
  await p.fill('#npName', 'Replacement Mgr');
  await p.fill('#npPhone', '9000000004');
  await p.fill('#npPass', 'newshoppass1');
  await p.click('button:has-text("Add")');
  await p.waitForTimeout(1200);
  const remade = received.find(r => r.table === 'fn:create-user' && r.rows.action !== 'delete');
  check('the same phone is accepted', !!remade, true);
  check('no already-exists in the answer',
        /already/i.test(await p.locator('#main').textContent()), false);
  check('the new login is on the list',
        await p.locator('#main tbody tr', { hasText: 'Replacement Mgr' }).count() > 0, true);

  /* Day Manager went through the older function above: the access row
     went, the sign-in stayed — an orphan holding the address. Creating
     with that address must heal it, not refuse it. */
  console.log('\nand an address orphaned by the old delete is healed');
  received.length = 0;
  await p.selectOption('#npRole', 'admin');
  await p.waitForTimeout(200);
  await p.fill('#npName', 'Second Manager');
  await p.fill('#npEmail', 'admin@velora.example');
  await p.fill('#npPass', 'anotherpass1');
  await p.click('button:has-text("Add")');
  await p.waitForTimeout(1200);
  check('the orphaned address is reusable',
        /Login created for/.test(await p.locator('#main').textContent()), true);
  check('under the new name',
        await p.locator('#main tbody tr', { hasText: 'Second Manager' }).count() > 0, true);
  p.removeAllListeners('dialog');

  console.log('\nnot your own, though');
  check('no delete button on your own row',
        await p.locator('#main tbody tr', { hasText: 'you' })
               .locator('button:has-text("Delete")').count(), 0);

  console.log('\nthe owner cannot reset their own');
  check('no reset button on your own row',
        await p.locator('#main tbody tr', { hasText: 'you' })
               .locator('button:has-text("Reset password")').count(), 0);

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
