/*
 * The contact master, and the invoice that reads off it.
 *
 *   npm run test:contact
 *
 * The point of the master is that a bill is never typed out by hand
 * twice. So the things worth checking are not that the form saves, but
 * that picking a customer fills the bill in, that the bill keeps its own
 * copy of what it printed, and that a contact edited or removed six
 * weeks later does not quietly rewrite a bill already raised.
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
  await p.evaluate(() => { if (typeof setGateWho === 'function') setGateWho('admin'); });
  await p.fill('#gateEmail', email);
  await p.fill('#gatePass', 'right');
  await p.click('#gateBtn');
  await p.waitForTimeout(1200);
  return { ctx, p };
}

/* a day with something packed for Kilpauk, so a bill can be raised */
async function readyToBill(p) {
  await p.evaluate(() => {
    setAnytime && setAnytime(true);
    const d = DATE;
    DB.indents[d] = { KLP: { status: 'accepted', lines: { '1': 12, '2': 30 } } };
    DB.days[d] = { rates: { '1': 80, '2': 27 }, packed: { KLP: { '1': 12, '2': 30 } },
                   ship: { KLP: 'received' }, sent: {} };
    save(); render();
  });
  await p.waitForTimeout(300);
}

(async () => {
  const b = await chromium.launch();

  console.log('\nwhere it lives');
  let { ctx, p } = await signIn(b, 'owner@velora.example');
  const groups = await p.locator('#side .grp').allTextContents();
  check('under Master', /Master/.test(groups.join(' ')), true);
  await p.evaluate(() => go('contact'));
  await p.waitForTimeout(400);
  check('the screen opens', await p.locator('#main h2').textContent(), 'Contact');
  check('and it is empty to start with',
    /No contacts yet/.test(await p.locator('#main').textContent()), true);

  console.log('\nadding one');
  received.length = 0;
  await p.click('button:has-text("Add a contact")');
  await p.waitForTimeout(300);
  check('the form opens', await p.locator('#ct_company').count(), 1);
  const labels = await p.locator('#main label').allTextContents();
  check('there is no shipping address to fill in',
    labels.some(l => /shipping|shipped/i.test(l)), false);
  check('one billing address, and it is asked for',
    labels.some(l => /Address line 1/i.test(l)), true);

  await p.fill('#ct_company', 'SSR AGRPCOM');
  await p.fill('#ct_person', 'Ravi');
  await p.fill('#ct_gstin', '33aabcu9603r1zm');
  await p.fill('#ct_mobile', '9342011780');
  await p.fill('#ct_addr1', 'No 4, Anna Salai');
  await p.fill('#ct_addr2', 'Chennai');
  await p.fill('#ct_state', 'Tamil Nadu');
  await p.fill('#ct_pincode', '600002');
  await p.fill('#ct_bankName', 'HDFC Bank');
  await p.fill('#ct_acNo', '50100123456');
  await p.fill('#ct_ifsc', 'hdfc0000123');
  await p.selectOption('#ct_shopId', 'KLP');
  await p.click('button:has-text("Add contact")');
  await p.waitForTimeout(900);

  check('on the list now', /SSR AGRPCOM/.test(await p.locator('#main').textContent()), true);
  check('GST number kept in capitals',
    await p.evaluate(() => Object.values(DB.contacts)[0].gstin), '33AABCU9603R1ZM');
  const sentC = received.find(r => r.table === 'contacts');
  const sentB = received.find(r => r.table === 'contact_bank');
  check('written to the server', sentC && sentC.rows[0].company_name, 'SSR AGRPCOM');
  check('with its billing address', sentC && sentC.rows[0].addr1, 'No 4, Anna Salai');
  check('bank details in a table of their own', sentB && sentB.rows[0].bank_name, 'HDFC Bank');
  check('and the contact before the bank row',
    received.indexOf(sentC) < received.indexOf(sentB), true);

  console.log('\nthe invoice reads off it');
  await readyToBill(p);
  await p.evaluate(() => go('inv'));
  await p.waitForTimeout(400);
  await p.click('button:has-text("Create invoice")');
  await p.waitForTimeout(700);

  check('no separate bill to form above the sheet',
    await p.locator('#invContact').count(), 0);
  check('the customer box is on the sheet itself',
    await p.locator('#inv #invCust').count(), 1);
  check('and so is the vehicle box', await p.locator('#inv #invvehicle').count(), 1);
  check('it starts as a draft with no number',
    await p.evaluate(() => DB.invoices[DATE].KLP.no), '');
  check('the customer was chosen for us',
    await p.locator('#invCust').inputValue(), 'SSR AGRPCOM');

  const printed = await p.locator('#inv').textContent();
  check('billing address on the bill', /No 4, Anna Salai/.test(printed), true);
  check('state and pincode together', /Tamil Nadu - 600002/.test(printed), true);
  check('GST number on the bill', /33AABCU9603R1ZM/.test(printed), true);
  check('our own name at the top',
    /Velora Innovations Pvt Ltd/.test(printed), true);
  check('and the city under it', /Chennai/.test(printed), true);
  check('place of supply came from the contact',
    await p.locator('#invplace').inputValue(), 'Tamil Nadu');
  /* the words inside a box must start on the same left edge as the
     printed lines under it, or the block reads as a stagger */
  const stagger = await p.evaluate(() => {
    const inp = document.getElementById('invCust');
    const addr = document.querySelector('.btaddr');
    if (!inp || !addr) return 999;
    const cs = getComputedStyle(inp);
    const textLeft = inp.getBoundingClientRect().left
      + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
    return Math.round(Math.abs(textLeft - addr.getBoundingClientRect().left));
  });
  check('the customer box lines up with the address under it', stagger <= 1, true);
  check('and the sheet shows only the seven columns a bill has',
    await p.evaluate(() =>
      Array.from(document.querySelectorAll('table.ibl thead th')).length), 7);

  console.log('\nwhat the sample asked to be left off');
  check('no e-way bill', /e-?way/i.test(printed), false);
  check('no shipping address', /shipp?(ing|ed)/i.test(printed), false);
  check('no receiver split', /receiver/i.test(printed), false);
  check('no distance', /distance/i.test(printed), false);
  check('no buyer order number', /buyer/i.test(printed), false);
  check('no notes box', /\bnotes\b/i.test(printed), false);
  check('no date of supply box', /Date of Supply/i.test(printed), false);
  check('but the footer is all there',
    /Round Off/.test(printed) && /Net Amount/.test(printed)
      && /Rupees/.test(printed) && /Authorised Signatory/.test(printed), true);

  /* typing into the sheet, and the sheet being what changes */
  console.log('\ntyped straight onto the bill');
  await p.fill('#invvehicle', 'TN 01 AB 1234');
  await p.fill('#invdriver', 'Murugan');
  await p.waitForTimeout(400);
  check('kept without a redraw',
    await p.evaluate(() => DB.invoices[DATE].KLP.vehicle), 'TN 01 AB 1234');
  check('the driver too',
    await p.evaluate(() => DB.invoices[DATE].KLP.driver), 'Murugan');
  check('and it is on the sheet, not in a form beside it',
    await p.locator('#inv #invvehicle').inputValue(), 'TN 01 AB 1234');
  const withVeh = await p.locator('#inv').textContent();
  check('no bank details on the bill', /bank/i.test(withVeh), false);
  check('the amount in words is labelled',
    /Total Amount In Words/i.test(withVeh), true);

  /* searching by part of a name, the way it will actually be used */
  console.log('\nsearching for a customer');
  await p.evaluate(() => {
    const id = 'dddddddd-0000-4000-a000-000000000001';
    DB.contacts[id] = { id: id, active: true, shopId: '', company: 'Kalpa Stores',
                        gstin: '33ZZZZZ0000Z1ZZ', addr1: 'No 9, Poonamallee High Road',
                        state: 'Tamil Nadu', pincode: '600084', bank: {} };
    save(); render();
  });
  await p.waitForTimeout(400);
  const list = await p.locator('#invCustList').innerHTML();
  check('both customers are offered', /SSR AGRPCOM/.test(list) && /Kalpa Stores/.test(list), true);

  await p.fill('#invCust', 'Kalpa');
  await p.locator('#invCust').dispatchEvent('change');
  await p.waitForTimeout(600);
  check('part of a name is enough',
    await p.evaluate(() => (DB.invoices[DATE].KLP.billTo || {}).name), 'Kalpa Stores');
  const swapped = await p.locator('#inv').textContent();
  check('and the whole address swaps with it',
    /Poonamallee High Road/.test(swapped), true);
  check('the old one is gone', /Anna Salai/.test(swapped), false);

  // back to the first, which is the one the rest of this suite is about
  await p.fill('#invCust', 'SSR AGRPCOM');
  await p.locator('#invCust').dispatchEvent('change');
  await p.waitForTimeout(600);
  check('and back again', /No 4, Anna Salai/.test(await p.locator('#inv').textContent()), true);

  console.log('\nsaving it');
  check('nothing to print until it is saved',
    await p.locator('button:has-text("Print")').count(), 0);
  received.length = 0;
  await p.click('button:has-text("Save invoice")');
  await p.waitForTimeout(800);
  check('the number is issued on saving',
    /^VF\/KLP\//.test(await p.evaluate(() => DB.invoices[DATE].KLP.no)), true);
  check('the boxes become plain text', await p.locator('#inv #invCust').count(), 0);
  check('and now it can be printed',
    await p.locator('button:has-text("Print")').count(), 1);
  check('it is in the saved list', await p.evaluate(() => savedInvoices().length) >= 1, true);

  await p.evaluate(() => { INVSHOP = null; render(); });
  await p.waitForTimeout(400);
  const listPage = await p.locator('#main').textContent();
  check('the screen has a saved invoices section', /Saved invoices/.test(listPage), true);
  check('with the bill on it', /VF\/KLP\//.test(listPage), true);

  console.log('\nwhat was sent up with the bill');
  await p.waitForTimeout(900);
  const inv = received.find(r => r.table === 'invoices');
  check('the invoice carries the contact', !!(inv && inv.rows[0].contact_id), true);
  check('the vehicle', inv && inv.rows[0].vehicle_no, 'TN 01 AB 1234');
  check('the driver', inv && inv.rows[0].driver_name, 'Murugan');
  check('and its own copy of the billing name', inv && inv.rows[0].bill_to_name, 'SSR AGRPCOM');
  check('and of the GST number', inv && inv.rows[0].bill_to_gstin, '33AABCU9603R1ZM');

  /* The whole reason the invoice keeps a copy rather than a pointer. */
  console.log('\na contact that moves premises does not rewrite an old bill');
  await p.evaluate(() => {
    const id = Object.keys(DB.contacts)[0];
    DB.contacts[id].addr1 = 'No 91, Mount Road';
    save();
  });
  await p.evaluate(() => { INVSHOP = 'KLP'; go('inv'); });
  await p.waitForTimeout(400);
  const still = await p.locator('#inv').textContent();
  check('the bill still reads the old address', /No 4, Anna Salai/.test(still), true);
  check('and not the new one', /Mount Road/.test(still), false);

  console.log('\nand one removed from the list leaves the bill alone');
  await p.evaluate(() => {
    const id = Object.keys(DB.contacts)[0];
    DB.contacts[id].active = false;
    save();
    INVSHOP = 'KLP'; render();
  });
  await p.waitForTimeout(400);
  check('the bill is unchanged',
    /SSR AGRPCOM/.test(await p.locator('#inv').textContent()), true);
  // and re-opening it for changes keeps the name that was printed,
  // even though the contact is no longer offered on the list
  await p.evaluate(() => { DB.invoices[DATE].KLP.saved = false; save(); render(); });
  await p.waitForTimeout(400);
  check('and it survives being reopened',
    await p.locator('#invCust').inputValue(), 'SSR AGRPCOM');
  await p.evaluate(() => { DB.invoices[DATE].KLP.saved = true; save(); render(); });
  await p.evaluate(() => { const id = Object.keys(DB.contacts)[0];
                           DB.contacts[id].active = true; save(); });
  await p.waitForTimeout(1200);          // let the change reach the server
  await ctx.close();

  console.log('\nafter a reload');
  ({ ctx, p } = await signIn(b, 'owner@velora.example'));
  await p.evaluate(() => go('contact'));
  await p.waitForTimeout(800);
  check('the contact came back', /SSR AGRPCOM/.test(await p.locator('#main').textContent()), true);
  check('with its address', await p.evaluate(() => Object.values(DB.contacts)[0].addr1),
        'No 91, Mount Road');
  check('and its bank details', await p.evaluate(() => (Object.values(DB.contacts)[0].bank||{}).ifsc),
        'HDFC0000123');

  /* Not every customer is registered, so a bill must come out clean
     without one rather than printing an empty GSTIN line. */
  console.log('\na contact with no GST number');
  await p.click('button:has-text("Add a contact")');
  await p.waitForTimeout(300);
  const glabels = await p.locator('#main label').allTextContents();
  check('the form says it is optional',
    glabels.some(l => /GST number\s*optional/i.test(l.replace(/\s+/g, ' '))), true);
  await p.fill('#ct_company', 'Nungambakkam Stores');
  await p.selectOption('#ct_shopId', 'NGB');
  await p.click('button:has-text("Add contact")');
  await p.waitForTimeout(800);
  check('saved without one', await p.evaluate(() =>
    Object.values(DB.contacts).some(c => c.company === 'Nungambakkam Stores' && !c.gstin)), true);

  await p.evaluate(() => {
    setAnytime && setAnytime(true);
    const d = DATE;
    DB.indents[d] = DB.indents[d] || {};
    DB.indents[d].NGB = { status: 'accepted', lines: { '1': 5 } };
    DB.days[d] = DB.days[d] || { rates: {}, packed: {}, ship: {}, sent: {} };
    DB.days[d].rates['1'] = 80;
    DB.days[d].packed.NGB = { '1': 5 };
    DB.days[d].ship.NGB = 'received';
    save(); INVSHOP = null; go('inv');
  });
  await p.waitForTimeout(400);
  await p.click('tr:has-text("Nungambakkam") button:has-text("Create invoice")');
  await p.waitForTimeout(800);
  const ngb = await p.locator('#inv').textContent();
  // a draft holds the name in a box, so it is read as a value not as text
  check('the bill still names the customer',
    await p.locator('#invCust').inputValue(), 'Nungambakkam Stores');
  check('and prints no empty GSTIN line', /GSTIN/.test(ngb), false);
  await ctx.close();

  console.log('\nwho may touch it');
  ({ ctx, p } = await signIn(b, 'admin@velora.example'));
  const atabs = await p.locator('#side button').allTextContents();
  check('an admin has no Contact master', atabs.some(t => /^Contact$/.test(t.trim())), false);
  await p.evaluate(() => go('contact'));
  await p.waitForTimeout(300);
  check('and cannot reach it by hand', await p.locator('#ct_company').count(), 0);

  // but an admin raises bills, so the dropdown has to work for them
  await readyToBill(p);
  await p.evaluate(() => go('inv'));
  await p.waitForTimeout(400);
  await p.click('button:has-text("Create invoice")');
  await p.waitForTimeout(700);
  check('an admin can still pick the customer', await p.locator('#inv #invCust').count(), 1);
  check('and the bill is made out', await p.locator('#invCust').inputValue(), 'SSR AGRPCOM');
  check('and can save it', await p.locator('button:has-text("Save invoice")').count(), 1);
  await ctx.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
