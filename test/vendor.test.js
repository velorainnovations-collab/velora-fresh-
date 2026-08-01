/*
 * Adding a vendor, and whether the new group is usable afterwards.
 *
 *   npm run test:vendor
 *
 * A vendor is added once; products move between vendors often. So the
 * thing to check is not just that the vendor saves, but that the
 * product list can immediately file a product under it, and that both
 * survive a reload.
 */
const { chromium } = require('playwright');
const { received } = require('./mock-supabase.js');

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = String(got) === String(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ->  ' + got + (ok ? '' : '   (expected ' + want + ')'));
  ok ? pass++ : fail++;
}

async function signIn(b, email) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } });
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
  await p.fill('#gateEmail', email);
  await p.fill('#gatePass', 'right');
  await p.click('#gateBtn');
  await p.waitForTimeout(1200);
  return { ctx, p };
}

(async () => {
  const b = await chromium.launch();

  console.log('\nthe form');
  let { ctx, p } = await signIn(b, 'owner@velora.example');
  await p.evaluate(() => go('vendors'));
  await p.waitForTimeout(500);
  check('add form present', await p.locator('#nvGroup').count(), 1);
  const before = await p.evaluate(() => GROUPNAMES.length);

  console.log('\nvalidation');
  let alerted = '';
  p.on('dialog', async d => { alerted = d.message(); await d.accept(); });
  await p.fill('#nvGroup', 'Ooty');
  await p.click('button:has-text("Add vendor")');
  await p.waitForTimeout(400);
  check('duplicate group refused', /already a vendor group/.test(alerted), true);
  check('nothing added', await p.evaluate(() => GROUPNAMES.length), before);

  console.log('\nadding');
  received.length = 0;
  await p.fill('#nvGroup', 'Coimbatore');
  await p.fill('#nvName', 'Coimbatore Farm Supply');
  await p.fill('#nvPhone', '919000012345');
  await p.click('button:has-text("Add vendor")');
  await p.waitForTimeout(900);

  const grp = received.find(r => r.table.startsWith('vendor_groups'));
  const ven = received.find(r => r.table.startsWith('vendors'));
  check('group written', grp && grp.rows[0].name, 'Coimbatore');
  check('vendor written', ven && ven.rows[0].name, 'Coimbatore Farm Supply');
  check('phone written', ven && ven.rows[0].phone, '919000012345');
  check('group order: group before vendor',
        received.indexOf(grp) < received.indexOf(ven), true);
  check('in the list now',
        /Coimbatore Farm Supply/.test(await p.locator('#main').textContent()), true);

  console.log('\nusable from the product list straight away');
  await p.evaluate(() => go('products'));
  await p.waitForTimeout(500);
  const opts = await p.locator('#npGroup option').allTextContents();
  check('new vendor offered as a group', opts.includes('Coimbatore'), true);

  received.length = 0;
  await p.fill('#npCode', '901');
  await p.fill('#npPName', 'Beans');
  await p.selectOption('#npGroup', 'Coimbatore');
  await p.click('button:has-text("Add product")');
  await p.waitForTimeout(900);
  const map = received.find(r => r.table.startsWith('product_groups'));
  check('product filed under the new vendor', map && map.rows[0].group_name, 'Coimbatore');
  await ctx.close();

  console.log('\nafter a reload');
  ({ ctx, p } = await signIn(b, 'owner@velora.example'));
  await p.evaluate(() => go('vendors'));
  await p.waitForTimeout(700);
  check('vendor group still there', await p.evaluate(() => !!GROUPS['Coimbatore']), true);
  check('vendor record exists', await p.evaluate(() => !!DB.vendors['Coimbatore']), true);
  check('screen renders without error',
        /Vendors/.test(await p.locator('#main h2').textContent()), true);
  check('product still filed under it',
        await p.evaluate(() => CODE2GROUP['901']), 'Coimbatore');
  await ctx.close();

  console.log('\nthe client side cannot add vendors');
  ({ ctx, p } = await signIn(b, 'shop@velora.example'));
  const tabs = await p.locator('#side button').allTextContents();
  check('shop has no Vendors screen', tabs.some(t => /Vendors/.test(t)), false);
  await ctx.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
