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
  check('under a heading, not loose',
        await p.locator('#mylist tbody tr.vgrp').count() > 0, true);
  check('nothing chosen to begin with',
        await p.locator('#mylist tbody tr[data-has]').count(), 0);
  check('and nothing can be submitted yet',
        await p.locator('button:has-text("Submit indent")').isDisabled(), true);

  console.log('\ntheir own products come first');
  /* a vendor grouping is Velora's business — a shop manager has never
     heard of the vendor a tomato comes from, and finding twenty five
     products inside two hundred and forty one sorted by somebody
     else's bills is the wrong question to ask them */
  check('no vendor names on their screen',
        /Ooty|SUK|Nellai/.test(await p.locator('#mylist tr.vgrp').first().textContent()), false);
  check('with no history, one heading for the lot',
        (await p.locator('#mylist tr.vgrp').allTextContents()).length, 1);
  check('and it says so',
        /All products/.test(await p.locator('#mylist tr.vgrp').first().textContent()), true);
  check('sorted by name, so a name can be found',
        await p.evaluate(() => {
          const names = Array.prototype.slice.call(
            document.querySelectorAll('#mylist tbody tr[data-k] td:nth-child(2)'))
            .map(td => td.childNodes[0].textContent.trim());
          return names.every((n, i) => i === 0 || names[i-1].localeCompare(n) <= 0);
        }), true);

  console.log('\nand what they order most sits at the top');
  await p.evaluate(() => {
    const back = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    DB.indents[back(1)] = { KLP: { status: 'accepted', lines: { '2': 10, '3': 2 } } };
    DB.indents[back(2)] = { KLP: { status: 'accepted', lines: { '2': 8 } } };
    DB.indents[back(3)] = { KLP: { status: 'accepted', lines: { '2': 6 } } };
    save(); render();
  });
  await p.waitForTimeout(400);
  const heads = await p.locator('#mylist tr.vgrp').allTextContents();
  check('a section of their own', /usually order/.test(heads[0] || ''), true);
  check('everything else under it', /Everything else/.test(heads[1] || ''), true);
  check('three days of one product beats one day of another',
        (await p.locator('#mylist tr[data-grp="usual"]').nth(1).textContent()).indexOf('Potato') > -1, true);
  check('and the usual section is short',
        await p.locator('#mylist tr[data-grp="usual"][data-k]').count(), 2);

  console.log('\nwhat they had last time is on the line');
  await p.evaluate(() => {
    const back = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    DB.days[back(1)] = DB.days[back(1)] || { rates:{}, packed:{}, ship:{}, sent:{} };
    DB.days[back(1)].packed = { KLP: { '2': 8 } };   /* what actually arrived */
    save(); render();
  });
  await p.waitForTimeout(400);
  const potato = p.locator('#mylist tbody tr[data-k]', { hasText: 'Potato' }).first();
  const potatoText = (await potato.textContent()).replace(/\s+/g, ' ');
  check('the day is named, not dated, when it was yesterday',
        /yesterday/.test(potatoText), true);
  check('and it is what arrived, not what was asked for',
        /got 8/.test(potatoText), true);
  const cabbage = p.locator('#mylist tbody tr[data-k]', { hasText: 'Cabbage' }).first();
  check('what was only ever asked for says so',
        /asked 2/.test((await cabbage.textContent()).replace(/\s+/g, ' ')), true);
  check('and a product they have never had says nothing',
        /got|asked/.test(await p.locator('#mylist tbody tr[data-k]', { hasText: 'Beetroot' })
                                 .first().textContent()), false);

  console.log('\na sheet can be handed over whole');
  await p.click('#myImport');
  await p.waitForTimeout(300);
  await p.fill('#myImportBox', '23 Country Tomato 5\nPotato, 12\nLemon 3\nrandom thing 4');
  await p.waitForTimeout(500);
  const panel = p.locator('#main table').first();
  check('every line is shown for checking', await panel.locator('tbody tr').count(), 4);
  check('a number after a name is the quantity, not a code',
        /Potato/.test(await panel.locator('tbody tr').nth(1).textContent()), true);
  check('a code in front is still read as a code',
        /Country Tomato/.test(await panel.locator('tbody tr').nth(0).textContent()), true);
  check('what could not be matched is said so, not dropped quietly',
        /not found/.test(await panel.locator('tbody tr').nth(3).textContent()), true);
  check('and the button counts only what will go in',
        /Add 3 to my indent/.test(await p.locator('button:has-text("to my indent")').textContent()), true);
  check('nothing has touched the indent yet',
        await p.evaluate(() => Object.keys(indentOf(DATE, ROLE).lines).length), 0);

  await p.click('button:has-text("to my indent")');
  await p.waitForTimeout(700);
  check('now it has', await p.evaluate(() => JSON.stringify(indentOf(DATE, ROLE).lines)),
        '{"1":3,"2":12,"23":5}');
  check('and it shows what came in, to be looked over',
        await p.locator('#mylist tbody tr[data-k]:visible').count(), 3);
  await p.evaluate(() => { indentOf(DATE, ROLE).lines = {}; MYONLY = false; save(); render(); });
  await p.waitForTimeout(400);

  console.log('\nyesterday again, with one press');
  check('the button names the day it will copy',
        /Same as/.test(await p.locator('#myRepeat').textContent()), true);
  await p.click('#myRepeat');
  await p.waitForTimeout(600);
  check('the quantities came across',
        await p.evaluate(() => indentOf(DATE, ROLE).lines['2']), 10);
  check('all of them', await p.evaluate(() => Object.keys(indentOf(DATE, ROLE).lines).length), 2);
  check('and it shows only what was copied, to be checked',
        await p.locator('#mylist tbody tr[data-k]:visible').count(), 2);
  await p.click('#myOnly');
  await p.waitForTimeout(300);
  /* back to an empty day for the sections below */
  await p.evaluate(() => { indentOf(DATE, ROLE).lines = {}; save(); render(); });
  await p.waitForTimeout(400);

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

  console.log('\nand it reaches the server');
  /* the one that matters: indent_lines is keyed by the id of its header
     row, and the app was sending the day and the shop instead. Every
     push carrying a line was refused, which for a shop is every push
     there is — that was the "Sync problem" they were staring at. */
  await p.waitForTimeout(1200);
  const lines = received.filter(r => r.table === 'indent_lines' && r.method === 'POST');
  check('the line was sent', lines.length > 0, true);
  check('and accepted, not refused for a column that does not exist',
        lines.filter(r => r.refused).length, 0);
  check('keyed by its indent, as the table is',
        lines.length ? Object.keys(lines[lines.length - 1].rows[0]).sort().join(',') : '',
        'indent_id,product_code,qty');
  check('the header went first', received.some(r => r.table === 'indents'), true);
  check('nothing is left waiting', await p.evaluate(() => VFSync.queueLength()), 0);
  check('and the badge says it is saved',
        /Saved/.test(await p.locator('#syncState').textContent()), true);

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
