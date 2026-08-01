/*
 * Adding a product, and — the part that matters — whether it survives
 * a reload.
 *
 *   npm run test:product
 *
 * The 241 products are compiled into index.html. A product added later
 * exists only in the database, so if the app does not read the
 * catalogue back on sign-in it will look like it worked and then
 * silently vanish.
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
    if (typeof setGateWho === 'function' && GATE_MODE !== 'set') setGateWho('office');
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
  await p.evaluate(() => go('products'));
  await p.waitForTimeout(500);
  check('add form present for owner', await p.locator('#npCode').count(), 1);
  check('catalogue starts at 241', await p.evaluate(() => CODES.length), 241);

  console.log('\nvalidation');
  // a code already in use must be refused
  let alerted = '';
  p.on('dialog', async d => { alerted = d.message(); await d.accept(); });
  await p.fill('#npCode', '1');
  await p.fill('#npPName', 'Duplicate');
  await p.click('button:has-text("Add product")');
  await p.waitForTimeout(400);
  check('duplicate code refused', /already used/.test(alerted), true);
  check('nothing added', await p.evaluate(() => CODES.length), 241);

  // a box with no weight cannot be priced, so it must be refused
  alerted = '';
  await p.fill('#npCode', '900');
  await p.fill('#npPName', 'Test Box');
  await p.selectOption('#npUnit', 'box');
  await p.waitForTimeout(200);
  check('weight field appears for a box', await p.locator('#npWt').isVisible(), true);
  await p.click('button:has-text("Add product")');
  await p.waitForTimeout(400);
  check('box without a weight refused', /weight in kg/.test(alerted), true);

  console.log('\nadding');
  received.length = 0;
  await p.fill('#npCode', '900');
  await p.fill('#npPName', 'Cauliflower');
  await p.fill('#npTamil', 'காலிஃபிளவர்');
  await p.selectOption('#npUnit', 'kg');
  await p.selectOption('#npGroup', 'Ooty');
  await p.click('button:has-text("Add product")');
  await p.waitForTimeout(900);

  const wrote = received.find(r => r.table.startsWith('products'));
  const mapped = received.find(r => r.table.startsWith('product_groups'));
  check('product written', !!wrote, true);
  check('name sent', wrote && wrote.rows[0].name, 'Cauliflower');
  check('tamil sent', wrote && wrote.rows[0].tamil, 'காலிஃபிளவர்');
  check('group mapping written', mapped && mapped.rows[0].group_name, 'Ooty');
  check('catalogue now 242', await p.evaluate(() => CODES.length), 242);
  check('appears in the list',
    /Cauliflower/.test(await p.locator('#main').textContent()), true);
  await ctx.close();

  console.log('\nafter a reload — the part that silently breaks');
  ({ ctx, p } = await signIn(b, 'owner@velora.example'));
  await p.evaluate(() => go('products'));
  await p.waitForTimeout(700);
  check('still there after signing in again', await p.evaluate(() => !!CAT['900']), true);
  check('kept its name', await p.evaluate(() => (CAT['900'] || {}).name), 'Cauliflower');
  check('kept its vendor group', await p.evaluate(() => CODE2GROUP['900']), 'Ooty');
  check('listed on the screen',
    /Cauliflower/.test(await p.locator('#main').textContent()), true);
  await ctx.close();

  console.log('\nthe client side cannot add products');
  ({ ctx, p } = await signIn(b, 'shop@velora.example'));
  await p.evaluate(() => go('products'));
  await p.waitForTimeout(500);
  check('no add form for a shop', await p.locator('#npCode').count(), 0);
  check('no vendor group column',
    /Vendor group/.test(await p.locator('#main').textContent()), false);
  await ctx.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
