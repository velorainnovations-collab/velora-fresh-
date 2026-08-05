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
const { received, opts } = require('./mock-supabase.js');

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

  /* The whole point of the panel: a vendor group can be made and
     renamed without leaving the product half typed above it. */
  console.log('\na vendor group, made from the product screen');
  ({ ctx, p } = await signIn(b, 'owner@velora.example'));
  let said = '';
  p.on('dialog', async d => { said = d.message(); await d.accept(); });
  await p.evaluate(() => go('products'));
  await p.waitForTimeout(500);
  /* two for the vendor group, two for the unit master */
  check('all four small buttons are there', await p.locator('.gtools button').count(), 4);
  check('panel starts closed', await p.locator('#gNew').isVisible(), false);

  // half a product typed, then the detour
  await p.fill('#npCode', '901');
  await p.fill('#npPName', 'Carrot Ooty');
  await p.fill('#npTamil', 'கேரட்');
  await p.click('.gtools button:has-text("+ New group")');
  await p.waitForTimeout(200);
  check('panel opens', await p.locator('#gNew').isVisible(), true);
  check('the product is still typed in', await p.locator('#npCode').inputValue(), '901');

  received.length = 0;
  await p.fill('#gnName', 'Nilgiris');
  await p.fill('#gnVendor', 'Nilgiris Farms');
  await p.fill('#gnPhone', '919000099999');
  await p.click('#gNew button:has-text("Create group")');
  await p.waitForTimeout(900);
  const madeG = received.find(r => r.table.startsWith('vendor_groups'));
  const madeV = received.find(r => r.table.startsWith('vendors'));
  check('group written', madeG && madeG.rows[0].name, 'Nilgiris');
  check('vendor written', madeV && madeV.rows[0].name, 'Nilgiris Farms');
  check('offered in the dropdown',
    await p.evaluate(() => GROUPNAMES.indexOf('Nilgiris') > -1), true);
  check('and already chosen', await p.locator('#npGroup').inputValue(), 'Nilgiris');
  check('the half typed product came back', await p.locator('#npPName').inputValue(), 'Carrot Ooty');
  check('Tamil name too', await p.locator('#npTamil').inputValue(), 'கேரட்');
  check('panel closed again', await p.locator('#gNew').isVisible(), false);

  // and the product it was made for files under it
  await p.click('button:has-text("Add product")');
  await p.waitForTimeout(800);
  check('product filed under the new group',
    await p.evaluate(() => CODE2GROUP['901']), 'Nilgiris');

  console.log('\nrenaming one from the same screen');
  await p.selectOption('#npGroup', 'Nilgiris');
  await p.click('.gtools button:has-text("Rename")');
  await p.waitForTimeout(200);
  check('rename panel opens', await p.locator('#gRen').isVisible(), true);
  check('shows which group', await p.locator('#gRenOld').textContent(), 'Nilgiris');
  check('starts from the old name', await p.locator('#grName').inputValue(), 'Nilgiris');

  // a name already in use is refused, and nothing moves
  said = '';
  await p.fill('#grName', 'Ooty');
  await p.click('#gRen button:has-text("Rename group")');
  await p.waitForTimeout(500);
  check('duplicate name refused', /already a vendor group/.test(said), true);
  check('nothing moved', await p.evaluate(() => CODE2GROUP['901']), 'Nilgiris');

  received.length = 0;
  await p.click('.gtools button:has-text("Rename")');
  await p.waitForTimeout(200);
  await p.fill('#grName', 'Nilgiri Hills');
  await p.click('#gRen button:has-text("Rename group")');
  await p.waitForTimeout(900);
  check('old name gone', await p.evaluate(() => GROUPNAMES.indexOf('Nilgiris')), -1);
  check('new name there', await p.evaluate(() => GROUPNAMES.indexOf('Nilgiri Hills') > -1), true);
  check('the products came with it', await p.evaluate(() => CODE2GROUP['901']), 'Nilgiri Hills');
  check('the vendor came with it',
    await p.evaluate(() => !!DB.vendors['Nilgiri Hills'] && !DB.vendors['Nilgiris']), true);
  check('renamed group is the one selected', await p.locator('#npGroup').inputValue(), 'Nilgiri Hills');

  // Manual order is where a product waits for a vendor, not a vendor
  said = '';
  await p.selectOption('#npGroup', 'Manual order');
  await p.click('.gtools button:has-text("Rename")');
  await p.waitForTimeout(200);
  await p.fill('#grName', 'Odds and ends');
  await p.click('#gRen button:has-text("Rename group")');
  await p.waitForTimeout(500);
  check('Manual order keeps its name', /is not a vendor/.test(said), true);
  check('still called Manual order',
    await p.evaluate(() => GROUPNAMES.indexOf('Manual order') > -1), true);
  await ctx.close();

  console.log('\nafter a reload, the old name is not still hanging about');
  ({ ctx, p } = await signIn(b, 'owner@velora.example'));
  await p.evaluate(() => go('products'));
  await p.waitForTimeout(800);
  check('renamed group survived', await p.evaluate(() => GROUPNAMES.indexOf('Nilgiri Hills') > -1), true);
  check('old name did not come back', await p.evaluate(() => GROUPNAMES.indexOf('Nilgiris')), -1);
  check('product still under it', await p.evaluate(() => CODE2GROUP['901']), 'Nilgiri Hills');
  check('not offered in the dropdown either',
    /Nilgiris</.test(await p.locator('#npGroup').innerHTML()), false);
  await ctx.close();

  /* A project that has not been given rename_group yet must say so
     rather than renaming here and disagreeing with the server. */
  console.log('\na database without the function says what to run');
  opts.noRenameFn = true;
  ({ ctx, p } = await signIn(b, 'owner@velora.example'));
  said = '';
  p.on('dialog', async d => { said = d.message(); await d.accept(); });
  await p.evaluate(() => go('products'));
  await p.waitForTimeout(600);
  await p.selectOption('#npGroup', 'Nilgiri Hills');
  await p.click('.gtools button:has-text("Rename")');
  await p.waitForTimeout(200);
  await p.fill('#grName', 'Blue Mountain');
  await p.click('#gRen button:has-text("Rename group")');
  await p.waitForTimeout(700);
  check('names the file to run', /02_security\.sql/.test(said), true);
  check('nothing renamed here either',
    await p.evaluate(() => GROUPNAMES.indexOf('Nilgiri Hills') > -1), true);
  opts.noRenameFn = false;
  await ctx.close();

  /* Editing one already on the list, and taking one off it. */
  console.log('\nediting a product already on the list');
  ({ ctx, p } = await signIn(b, 'owner@velora.example'));
  said = '';
  p.on('dialog', async d => { said = d.message(); await d.accept(); });
  await p.evaluate(() => go('products'));
  await p.waitForTimeout(600);
  check('every row has an Edit button',
    await p.locator('table tbody tr td:last-child button:has-text("Edit")').count() > 0, true);

  await p.evaluate(() => editProduct('900'));
  await p.waitForTimeout(400);
  check('the edit form opens', await p.locator('#epPName').count(), 1);
  check('filled in with what is on file', await p.locator('#epPName').inputValue(), 'Cauliflower');
  check('the code is shown but not editable', await p.locator('#epCode').isDisabled(), true);
  check('its group is the one selected', await p.locator('#epGroup').inputValue(), 'Ooty');
  check('the add form is out of the way', await p.locator('#npCode').count(), 0);

  // the group of a product already entered — the thing that was asked for
  received.length = 0;
  await p.fill('#epPName', 'Cauliflower Ooty');
  await p.selectOption('#epGroup', 'Nilgiri Hills');
  await p.click('button:has-text("Save changes")');
  await p.waitForTimeout(900);
  const patched = received.find(r => r.table.startsWith('products') && r.method === 'PATCH');
  const remap = received.find(r => r.table.startsWith('product_groups'));
  check('the change was written', patched && patched.rows.name, 'Cauliflower Ooty');
  check('and the new group with it', remap && remap.rows[0].group_name, 'Nilgiri Hills');
  check('moved on this device too', await p.evaluate(() => CODE2GROUP['900']), 'Nilgiri Hills');
  check('out of the group it was in',
    await p.evaluate(() => (GROUPS['Ooty'] || []).indexOf('900')), -1);
  check('form closed again', await p.locator('#epPName').count(), 0);
  check('the list shows the new name',
    /Cauliflower Ooty/.test(await p.locator('#main').textContent()), true);

  console.log('\na product that is on a trading day cannot be removed');
  await p.evaluate(() => {
    /* the same shape the day board writes: an indent line against it */
    DB.indents['2026-08-01'] = { KLP: { status: 'submitted', lines: { '900': 5 } } };
    editProduct('900');
  });
  await p.waitForTimeout(400);
  said = '';
  await p.click('button:has-text("Delete product")');
  await p.waitForTimeout(500);
  check('refused', /cannot be removed/.test(said), true);
  check('and it says where it is in use', /an indent on 2026-08-01/.test(said), true);
  check('still in the catalogue', await p.evaluate(() => !!CAT['900']), true);

  console.log('\nand one that is not, is');
  await p.evaluate(() => { DB.indents['2026-08-01'] = {}; save(); });
  received.length = 0;
  await p.click('button:has-text("Delete product")');
  await p.waitForTimeout(900);
  check('asked before doing it', /Remove/.test(said), true);
  const killed = received.find(r => r.method === 'DELETE' && r.table === 'products');
  check('the delete was sent', killed && killed.code, '900');
  check('gone from the catalogue', await p.evaluate(() => !!CAT['900']), false);
  check('and off the code list', await p.evaluate(() => CODES.indexOf('900')), -1);
  check('out of its vendor group',
    await p.evaluate(() => (GROUPS['Nilgiri Hills'] || []).indexOf('900')), -1);
  check('no longer on the screen',
    /Cauliflower Ooty/.test(await p.locator('#main').textContent()), false);
  await ctx.close();

  console.log('\nand it stays gone after a reload');
  ({ ctx, p } = await signIn(b, 'owner@velora.example'));
  said = '';
  p.on('dialog', async d => { said = d.message(); await d.accept(); });
  await p.evaluate(() => go('products'));
  await p.waitForTimeout(800);
  check('not read back from the catalogue', await p.evaluate(() => !!CAT['900']), false);

  /* Nothing on this device knows about it, so only the database can
     refuse — and what it says is a constraint name, not an answer. */
  console.log('\na day on another device refuses it, in words');
  await p.evaluate(() => editProduct('1'));
  await p.waitForTimeout(400);
  said = '';
  await p.click('button:has-text("Delete product")');
  await p.waitForTimeout(1000);
  check('says it is on a trading day', /on a trading day already/.test(said), true);
  check('not the constraint name', /fkey/.test(said), false);
  check('still in the catalogue here', await p.evaluate(() => !!CAT['1']), true);
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
