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
  check('greeted, not questioned twice',
        /Welcome/.test(await p.locator('#gateWelcome').textContent()), true);
  check('no second line under the dropdown',
        (await p.locator('#gateHint').textContent()).trim(), '');
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
  received.length = 0;
  await tryShop(p, 'Kilpauk Mgr', '9000000004', 'shoppass1');
  await p.waitForTimeout(600);
  check('gets in', await p.locator('#gate').isVisible(), false);
  check('as their own shop', await p.evaluate(() => ROLE), 'KLP');

  console.log('\nand sends nothing it is not allowed to send');
  /* The first render happens before anyone has signed in, when the
     baseline is empty, so every default in the local blob looked like
     new work: rates, vendors, margins, settings, every shop's packing.
     Pushed as a shop, the database refused it — correctly — and the
     badge read "Sync problem" for work the shop never did. */
  const sent = received.filter(r => r.method === 'POST' && /^[a-z_]+$/.test(r.table));
  const forbidden = sent.filter(r => ['indents', 'indent_lines', 'shipments'].indexOf(r.table) < 0);
  check('nothing outside a shop’s own three tables',
        forbidden.map(r => r.table).join(',') || 'none', 'none');
  check('the badge is not showing a problem',
        /problem/i.test(await p.locator('#syncState').textContent()), false);
  check('and the queue is empty', await p.evaluate(() => VFSync.queueLength()), 0);
  check('the sync layer knows what a shop may write',
        await p.evaluate(() => [VFSync._mayWrite('indents'), VFSync._mayWrite('day_rates'),
                                VFSync._mayWrite('vendors'), VFSync._mayWrite('settings'),
                                VFSync._mayWrite('shipments')].join(',')),
        'true,false,false,false,true');

  await ctx.close();

  console.log('\nthe indent screen lists everything they can order');
  ({ ctx, p } = await fresh(b));
  await tryShop(p, 'Kilpauk Mgr', '9000000004', 'shoppass1');
  await p.waitForTimeout(400);
  const all = await p.locator('#mylist tbody tr[data-k]').count();
  check('every product is on the list', all > 200, true);
  check('grouped the way the vendors are',
        await p.locator('#mylist tbody tr.vgrp').count() > 1, true);
  check('nothing chosen to begin with',
        await p.locator('#mylist tbody tr[data-has]').count(), 0);
  check('and nothing can be submitted yet',
        await p.locator('button:has-text("Submit indent")').isDisabled(), true);

  console.log('\nthere is no closing time');
  check('the screen says so',
        /no closing time/.test(await p.locator('#main .note').first().textContent()), true);
  check('the window is open whatever the hour',
        await p.evaluate(() => windowState()), 'open');
  check('even with the old setting switched off',
        await p.evaluate(() => { DB.settings.anytime = false; return windowState(); }), 'open');
  check('and the clock says only the time',
        /^\d\d:\d\d$/.test((await p.locator('#clock').textContent()).trim()), true);

  console.log('\nthe search narrows the list rather than adding to it');
  await p.fill('#myq', 'tomato');
  await p.waitForTimeout(250);
  const few = await p.locator('#mylist tbody tr[data-k]:visible').count();
  check('fewer rows shown', few > 0 && few < all, true);
  check('no heading left standing on its own',
        await p.evaluate(() => {
          const rows = Array.prototype.slice.call(
            document.querySelectorAll('#mylist tbody tr'))
            .filter(r => r.style.display !== 'none');
          return rows.some((r, i) => r.className === 'vgrp' &&
                           (!rows[i+1] || rows[i+1].className === 'vgrp'));
        }), false);

  console.log('\na quantity is all it takes');
  const row = p.locator('#mylist tbody tr[data-k]:visible').first();
  const code = await row.locator('td.mono').textContent();
  await row.locator('input').fill('4');
  await row.locator('input').blur();
  await p.waitForTimeout(500);
  check('it is in the indent now',
        await p.evaluate(c => indentOf(DATE, ROLE).lines[c], code.trim()), 4);
  check('the row is marked as chosen',
        await p.locator('#mylist tbody tr[data-has]').count(), 1);
  check('the count says so', /1 item/.test(await p.locator('#main .bar').last().textContent()), true);
  check('what was searched for is still searched for', await p.inputValue('#myq'), 'tomato');
  check('and the list is still narrowed',
        await p.locator('#mylist tbody tr[data-k]:visible').count(), few);

  console.log('\nand clearing the box takes it out again');
  await p.locator('#mylist tbody tr[data-has] input').fill('');
  await p.locator('#mylist tbody tr[data-has] input').blur();
  await p.waitForTimeout(500);
  check('gone from the indent',
        await p.evaluate(() => Object.keys(indentOf(DATE, ROLE).lines).length), 0);

  console.log('\nreviewing what has been chosen');
  await p.fill('#myq', '');
  await p.waitForTimeout(200);
  const one = p.locator('#mylist tbody tr[data-k]').first();
  await one.locator('input').fill('2');
  await one.locator('input').blur();
  await p.waitForTimeout(500);
  await p.click('#myOnly');
  await p.waitForTimeout(300);
  check('only the chosen one is left on screen',
        await p.locator('#mylist tbody tr[data-k]:visible').count(), 1);
  await p.click('#myOnly');
  await p.waitForTimeout(300);
  check('and the whole list comes back',
        await p.locator('#mylist tbody tr[data-k]:visible').count(), all);
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

  console.log('\nevery visit starts with the question');
  ({ ctx, p } = await fresh(b));
  await p.selectOption('#gateWho', 'shop');
  await p.waitForTimeout(200);
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(600);
  /* a shop phone is passed around; yesterday's answer must not decide
     today's, and the card is meant to open on the greeting */
  check('back on Select after a refresh', await p.inputValue('#gateWho'), '');
  check('no fields carried over',  await p.locator('#gateName').isVisible(), false);
  check('greeted again', await p.locator('#gateWelcome').isVisible(), true);
  await ctx.close();

  console.log('\nthe empty card is only the name, a welcome and the question');
  ({ ctx, p } = await fresh(b));
  check('welcomed',  /Welcome/.test(await p.locator('#gateWelcome').textContent()), true);
  check('the dropdown is there', await p.locator('#gateWho').isVisible(), true);
  check('nothing else to fill in',
        await p.locator('#gate input:visible').count(), 0);
  await p.selectOption('#gateWho', 'shop');
  await p.waitForTimeout(200);
  check('the welcome steps aside once answered',
        await p.locator('#gateWelcome').isVisible(), false);
  await ctx.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
