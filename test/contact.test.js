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
  await p.click('button:has-text("Generate")');
  await p.waitForTimeout(700);
  check('a bill to panel is there', await p.locator('#invContact').count(), 1);
  check('the customer was chosen for us',
    await p.evaluate(() => Object.values(DB.contacts)[0].company),
    await p.evaluate(() => (DB.invoices[DATE].KLP.billTo || {}).name));
  const printed = await p.locator('#inv').textContent();
  check('company name on the bill', /SSR AGRPCOM/.test(printed), true);
  check('billing address on the bill', /No 4, Anna Salai/.test(printed), true);
  check('state and pincode together', /Tamil Nadu - 600002/.test(printed), true);
  check('GST number on the bill', /33AABCU9603R1ZM/.test(printed), true);
  check('our own name at the top',
    /Vellore Freshworks Private Limited/.test(printed), true);
  check('and the city under it', /Chennai/.test(printed), true);

  console.log('\nwhat the sample asked to be left off');
  check('no e-way bill', /e-?way/i.test(printed), false);
  check('no shipping address', /shipp?(ing|ed)/i.test(printed), false);
  check('no receiver split', /receiver/i.test(printed), false);
  check('but the footer is all there',
    /Round Off/.test(printed) && /Net Amount/.test(printed)
      && /Rupees/.test(printed) && /Authorised Signatory/.test(printed), true);

  console.log('\nvehicle and driver');
  await p.fill('#invVehicle', 'TN 01 AB 1234');
  await p.locator('#invVehicle').blur();
  await p.fill('#invDriver', 'Murugan');
  await p.locator('#invDriver').blur();
  await p.waitForTimeout(400);
  await p.evaluate(() => render());
  await p.waitForTimeout(300);
  const withVeh = await p.locator('#inv').textContent();
  check('vehicle number on the bill', /TN 01 AB 1234/.test(withVeh), true);
  check('driver on the bill', /Murugan/.test(withVeh), true);
  check('neither is in the panel only',
    /Vehicle No/.test(withVeh) && /Driver/.test(withVeh), true);

  console.log('\nwhat was sent up with the bill');
  received.length = 0;
  await p.evaluate(() => save());
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
  check('and it can still be picked up again',
    /removed/.test(await p.locator('#invContact').innerHTML()), true);
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
  await p.click('button:has-text("Generate")');
  await p.waitForTimeout(700);
  check('an admin can still pick the customer', await p.locator('#invContact').count(), 1);
  check('and the bill is made out', /SSR AGRPCOM/.test(await p.locator('#inv').textContent()), true);
  await ctx.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
