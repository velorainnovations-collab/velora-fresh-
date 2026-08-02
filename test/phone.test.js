/*
 * The app on a phone.
 *
 *   npm run test:phone
 *
 * Seven controls will not sit on one line at 390px. The header used to
 * wrap to four rows, and the drawer — which hangs off the header's
 * height — started halfway down the screen with its first menu items
 * hidden behind it. On a phone the header keeps the menu button and the
 * business name; everything else moves into the drawer.
 */
const { chromium } = require('playwright');
require('./mock-supabase.js');

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = String(got) === String(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ->  ' + got + (ok ? '' : '   (expected ' + want + ')'));
  ok ? pass++ : fail++;
}

const PHONE = { width: 390, height: 844 };
const DESK  = { width: 1440, height: 900 };

async function signedIn(b, viewport) {
  const ctx = await b.newContext({ viewport, isMobile: viewport.width < 720, hasTouch: viewport.width < 720 });
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
  await p.evaluate(() => setGateWho('admin'));
  await p.fill('#gateEmail', 'owner@velora.example');
  await p.fill('#gatePass', 'right');
  await p.click('#gateBtn');
  await p.waitForTimeout(1400);
  return { ctx, p };
}

const box = (p, sel) => p.evaluate(s => {
  const r = document.querySelector(s).getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height, w: r.width };
}, sel);

(async () => {
  const b = await chromium.launch();

  console.log('\nthe header on a phone');
  let { ctx, p } = await signedIn(b, PHONE);
  const head = await box(p, 'header');
  check('one row, not four', head.h < 60, true);
  check('the menu button is there', await p.locator('#burger').isVisible(), true);
  check('and the name of the business', await p.locator('.brand').isVisible(), true);
  check('the date is not in the bar', await p.locator('header > #dateSel').count(), 0);
  check('nor the sign out button',    await p.locator('header > #signOutBtn').count(), 0);

  console.log('\nthe drawer has them instead');
  check('light or dark is not in the bar on a phone',
        await p.locator('#themeBtn').isVisible(), false);
  const side = await box(p, '#side');
  check('the drawer starts exactly under the header', Math.round(side.top), Math.round(head.bottom));

  await p.evaluate(() => toggleSide(true));
  await p.waitForTimeout(350);
  check('who is signed in, at the top', await p.locator('#sideWho #whoami').isVisible(), true);
  check('the date beside it',           await p.locator('#sideWho #dateSel').isVisible(), true);
  const nm = await box(p, '#sideWho #whoami');
  const dt = await box(p, '#sideWho #dateSel');
  const mid = r => Math.round((r.top + r.bottom) / 2);
  check('on the one line, not stacked', mid(nm), mid(dt));
  check('the date is to the right of the name', dt.left > nm.left, true);
  /* the switch that overrules the 6–9 pm window is hidden while no hours
     are enforced at all — there is nothing for it to overrule */
  check('no window switch while there is no window',
        await p.locator('#sideTop #anyBox').isVisible(), false);
  check('the sync mark is in the drawer',
        await p.locator('#sideTop #syncState').count(), 1);

  console.log('\nand the way out is at the bottom');
  const so = await box(p, '#sideFoot #signOutBtn');
  const menu = await box(p, '#sideNav');
  check('sign out is below the whole menu', so.top >= menu.bottom - 1, true);
  check('the clock is with it', await p.locator('#sideFoot #clock').isVisible(), true);

  console.log('\nnothing in the menu is hidden behind the header');
  const first = await box(p, '#sideNav .grp:first-child button');
  check('the first item is below the header', first.top >= head.bottom, true);
  check('and it really is the first screen',
        (await p.locator('#sideNav .grp:first-child button').textContent()).trim(), 'Day board');

  console.log('\nno screen runs off the side of the phone');
  /* every screen, not a sample: one table without something to scroll
     it took the whole page with it, and that is what a shop sees */
  await p.evaluate(() => toggleSide(false));
  const SCREENS = ['board','indents','rates','pack','ship','inv','orders','vendors',
                   'acct','master','products','shops','people'];
  for (const t of SCREENS) {
    await p.evaluate(s => go(s), t);
    await p.waitForTimeout(320);
    const r = await p.evaluate(() => ({
      over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      loose: Array.prototype.slice.call(document.querySelectorAll('#main table'))
               .filter(el => !(el.parentNode.className || '').match(/twrap/)).length,
    }));
    check(t + ' fits the width', r.over <= 1, true);
    check(t + ' has every table inside something that scrolls', r.loose, 0);
  }

  await p.evaluate(() => go('products'));
  await p.waitForTimeout(500);
  check('a wide table scrolls inside its own card instead',
        await p.evaluate(() => {
          const w = document.querySelector('#main .twrap');
          return !!w && w.scrollWidth > w.clientWidth;
        }), true);
  check('and the first column stays put while it does',
        await p.evaluate(() => getComputedStyle(
          document.querySelector('#main .twrap td:first-child')).position), 'sticky');
  check('a soft edge says there is more to the right',
        await p.locator('#main .tscroll.more').count() > 0, true);
  await p.evaluate(() => {
    const w = document.querySelector('#main .twrap');
    w.scrollLeft = w.scrollWidth;
    w.dispatchEvent(new Event('scroll'));
  });
  await p.waitForTimeout(250);
  check('and it goes at the end of the run',
        await p.locator('#main .tscroll.more').count(), 0);

  console.log('\na form on a phone stacks its button and the line under it');
  await p.evaluate(() => go('acct'));
  await p.waitForTimeout(600);
  const btn  = await box(p, '#main .addform .act .btn');
  const hint = await box(p, '#main .addform .act .hintline');
  check('the button takes the width', btn.w > 250, true);
  check('the line sits under it, not beside it', hint.top >= btn.bottom - 1, true);
  await ctx.close();

  console.log('\non a desk they are back in the bar');
  ({ ctx, p } = await signedIn(b, DESK));
  check('nothing was left in the drawer',
        await p.locator('#sideWho > *, #sideTop > #anyBox, #sideFoot > *').count(), 0);
  check('light or dark is back',    await p.locator('header > #themeBtn').isVisible(), true);
  check('the date is in the bar',    await p.locator('header > #dateSel').count(), 1);
  check('the sign out button too',   await p.locator('header > #signOutBtn').count(), 1);
  check('and in the order they were written',
        await p.evaluate(() => Array.prototype.slice.call(document.querySelector('header').children)
                                .map(el => el.id).filter(Boolean).join(',')),
        'burger,roleSel,whoami,dateSel,wipeDay,anyBox,themeBtn,syncState,signOutBtn,clock');

  console.log('\nand they follow the width as it changes');
  await p.setViewportSize(PHONE);
  await p.waitForTimeout(400);
  check('narrowed: the drawer takes them',
        await p.locator('#sideWho > #dateSel, #sideFoot > #signOutBtn').count(), 2);
  await p.setViewportSize(DESK);
  await p.waitForTimeout(400);
  check('widened: the bar takes them back',
        await p.locator('#sideWho > *, #sideFoot > *').count(), 0);
  check('the screen still works',
        await p.evaluate(() => { go('rates'); return TAB; }), 'rates');
  await ctx.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
