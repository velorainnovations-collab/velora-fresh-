/*
 * Alignment and readability, on every screen.
 *
 *   npm run test:layout
 *
 * Four things, on each screen, at a desk and on a phone, in light and
 * dark: does the page run off the side, does every row have as many
 * cells as its header has columns, is anything sitting past the right
 * edge, and is any text nearly the same colour as what is behind it.
 *
 * All four have happened here. The packing table pushed the whole page
 * sideways on a phone because it had nothing to scroll inside; a group
 * heading was dark green ink on a dark green band once the page went
 * dark; a note kept its light-theme browns. None of them show up in a
 * test that only looks at behaviour.
 */
const { chromium } = require('playwright');
require('./mock-supabase.js');

const OFFICE = ['board','indents','orders','rates','pack','ship','inv','vendors','shops',
                'products','master','people','acct'];
const SHOP = ['myindent','mydel','mybills','products'];

async function open(b, who, width, scheme) {
  const ctx = await b.newContext({ viewport: { width, height: 950 }, colorScheme: scheme,
                                   isMobile: width < 720, hasTouch: width < 720 });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('  PAGEERROR:', e.message));
  await p.route('**://*.supabase.co/**', async route => {
    const q = route.request(); const u = new URL(q.url());
    const r = await fetch('http://127.0.0.1:8123' + u.pathname + u.search, {
      method: q.method(), headers: q.headers(),
      body: ['GET','HEAD'].includes(q.method()) ? undefined : q.postData() });
    await route.fulfill({ status: r.status, headers: {'content-type':'application/json'}, body: await r.text() });
  });
  await p.goto('http://127.0.0.1:8092/index.html', { waitUntil: 'networkidle' });
  if (who === 'shop') {
    await p.selectOption('#gateWho', 'shop'); await p.waitForTimeout(200);
    await p.fill('#gateName', 'Kilpauk Mgr'); await p.fill('#gatePhone', '9000000004');
    await p.fill('#gatePass', 'shoppass1');
  } else {
    await p.evaluate(() => setGateWho('admin'));
    await p.fill('#gateEmail', 'owner@velora.example'); await p.fill('#gatePass', 'right');
  }
  await p.click('#gateBtn'); await p.waitForTimeout(1500);
  // some data so the screens are not all empty
  await p.evaluate(() => {
    setAnytime && setAnytime(true);
    const d = DATE;
    DB.indents[d] = DB.indents[d] || {};
    DB.indents[d]['KLP'] = { status:'submitted', lines: { '1': 12, '11': 5, '2': 30 } };
    DB.days[d] = DB.days[d] || { rates:{}, packed:{}, ship:{}, sent:{} };
    DB.days[d].rates = { '1': 80, '11': 20 };
    DB.days[d].packed = { KLP: { '1': 10, '11': 5 } };
    DB.days[d].ship = { KLP: 'out' };
    save(); render();
  });
  await p.waitForTimeout(400);
  return { ctx, p };
}

const audit = tab => ({
  tab,
  over: (() => {
    const doc = document.documentElement;
    return doc.scrollWidth - doc.clientWidth;
  })(),
  cells: (() => {
    const bad = [];
    document.querySelectorAll('#main table').forEach((t, ti) => {
      const heads = t.querySelectorAll('thead th').length;
      if (!heads) return;
      t.querySelectorAll('tbody tr').forEach((tr, ri) => {
        let n = 0;
        tr.querySelectorAll('td').forEach(td => { n += td.colSpan || 1; });
        if (n !== heads) bad.push('table' + ti + ' row' + ri + ': ' + n + ' vs ' + heads);
      });
    });
    return bad.slice(0, 4);
  })(),
  faint: (() => {
    /* text that is nearly the same colour as what is behind it */
    const out = [];
    const lum = c => { const m = (c.match(/\d+/g) || []).map(Number); return m.length >= 3 ? (m[0]*299 + m[1]*587 + m[2]*114) / 1000 : null; };
    const bgOf = el => { let n = el; while (n && n !== document.body) { const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;   /* a gradient, not a flat colour */
      if (cs.backgroundColor && !/rgba\(0, 0, 0, 0\)/.test(cs.backgroundColor)) return cs.backgroundColor;
      n = n.parentElement; } return getComputedStyle(document.body).backgroundColor; };
    document.querySelectorAll('#main *, header *').forEach(el => {
      if (!el.childNodes.length) return;
      const hasText = Array.prototype.some.call(el.childNodes, n => n.nodeType === 3 && n.textContent.trim());
      if (!hasText) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return;
      const bgc = bgOf(el);
      if (bgc === null) return;            /* sitting on a gradient: not measurable this way */
      const a = lum(cs.color), bl = lum(bgc);
      if (a === null || bl === null) return;
      if (Math.abs(a - bl) < 40) out.push((el.tagName + '.' + (el.className || '')).slice(0, 34)
        + ' [' + el.textContent.trim().slice(0, 22) + ']');
    });
    return out.slice(0, 4);
  })(),
  offscreen: (() => {
    const vw = document.documentElement.clientWidth, out = [];
    document.querySelectorAll('#main > *, header > *').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width && r.right > vw + 1) out.push((el.tagName + '.' + (el.className||'')).slice(0,30));
    });
    return out.slice(0, 3);
  })(),
});

let pass = 0, fail = 0;
function check(label, problems) {
  if (!problems.length) { pass++; return; }
  fail++;
  console.log('  FAIL ' + label);
  problems.forEach(x => console.log('         ' + x));
}

(async () => {
  const b = await chromium.launch();
  for (const [who, tabs] of [['owner', OFFICE], ['shop', SHOP]]) {
    for (const width of [1440, 390]) {
      for (const scheme of ['light', 'dark']) {
        const { ctx, p } = await open(b, who, width, scheme);
        console.log('\n' + who + ' at ' + width + 'px, ' + scheme);
        for (const t of tabs) {
          await p.evaluate(x => go(x), t);
          await p.waitForTimeout(320);
          const r = await p.evaluate(audit, t);
          const problems = [];
          if (r.over > 1) problems.push('page scrolls sideways by ' + r.over + 'px');
          if (r.cells.length) problems.push('cell count: ' + r.cells.join('; '));
          if (r.faint.length) problems.push('faint: ' + r.faint.join('; '));
          if (r.offscreen.length) problems.push('past the edge: ' + r.offscreen.join('; '));
          check([who, width + 'px', scheme, t].join(' / '), problems);
        }
        await ctx.close();
      }
    }
  }
  console.log('\n' + pass + ' screens clean, ' + fail + ' with problems\n');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
