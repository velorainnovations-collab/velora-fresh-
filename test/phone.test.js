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
  check('all eight moved', await p.locator('#sideTop > *').count(), 8);
  const side = await box(p, '#side');
  check('the drawer starts exactly under the header', Math.round(side.top), Math.round(head.bottom));

  await p.evaluate(() => toggleSide(true));
  await p.waitForTimeout(350);
  check('who is signed in, in the drawer', await p.locator('#sideTop #whoami').isVisible(), true);
  check('the date too',      await p.locator('#sideTop #dateSel').isVisible(), true);
  check('and the way out',   await p.locator('#sideTop #signOutBtn').isVisible(), true);
  const dt = await box(p, '#sideTop #dateSel');
  const so = await box(p, '#sideTop #signOutBtn');
  check('they are one width', Math.round(dt.w), Math.round(so.w));

  console.log('\nnothing in the menu is hidden behind the header');
  const first = await box(p, '#sideNav .grp:first-child button');
  check('the first item is below the header', first.top >= head.bottom, true);
  check('and it really is the first screen',
        (await p.locator('#sideNav .grp:first-child button').textContent()).trim(), 'Day board');

  console.log('\nthe page itself');
  await p.evaluate(() => go('products'));
  await p.waitForTimeout(600);
  const doc = await p.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  check('the page does not scroll sideways', doc.scroll <= doc.client + 1, true);
  check('a wide table scrolls inside its own card',
        await p.evaluate(() => {
          const w = document.querySelector('#main .twrap');
          return !!w && w.scrollWidth > w.clientWidth;
        }), true);
  await ctx.close();

  console.log('\non a desk they are back in the bar');
  ({ ctx, p } = await signedIn(b, DESK));
  check('nothing was left in the drawer', await p.locator('#sideTop > *').count(), 0);
  check('the date is in the bar',    await p.locator('header > #dateSel').count(), 1);
  check('the sign out button too',   await p.locator('header > #signOutBtn').count(), 1);
  check('and in the order they were written',
        await p.evaluate(() => Array.prototype.slice.call(document.querySelector('header').children)
                                .map(el => el.id).filter(Boolean).join(',')),
        'burger,roleSel,whoami,dateSel,anyBox,themeBtn,syncState,signOutBtn,clock');

  console.log('\nand they follow the width as it changes');
  await p.setViewportSize(PHONE);
  await p.waitForTimeout(400);
  check('narrowed: the drawer takes them', await p.locator('#sideTop > *').count(), 8);
  await p.setViewportSize(DESK);
  await p.waitForTimeout(400);
  check('widened: the bar takes them back', await p.locator('#sideTop > *').count(), 0);
  check('the screen still works',
        await p.evaluate(() => { go('rates'); return TAB; }), 'rates');
  await ctx.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
