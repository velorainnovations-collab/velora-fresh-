/*
 * What comes out of the printer.
 *
 *   npm run test:print
 *
 * The invoice looked right on screen and printed with its right hand
 * side off the edge of the sheet: the sidebar is an <aside>, the print
 * stylesheet hid <nav>, and main kept the margin that makes room for it.
 * Nothing that only looks at the screen can see that, so this suite
 * switches the page to print media, sets the viewport to the width of
 * the printable part of an A4 sheet, and measures.
 *
 * 210mm of paper less 12mm of margin each side is 186mm, which at the
 * 96dpi a browser reckons in is 703px.
 */
const { chromium } = require('playwright');
require('./mock-supabase.js');

const A4 = 703;                       // printable width, in CSS pixels

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = String(got) === String(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  ->  ' + got + (ok ? '' : '   (expected ' + want + ')'));
  ok ? pass++ : fail++;
}

async function billFor(b, email) {
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

  await p.evaluate(() => {
    setAnytime && setAnytime(true);
    const d = DATE;
    const id = 'bbbbbbbb-0000-4000-a000-000000000001';
    DB.contacts[id] = { id: id, active: true, shopId: 'KLP',
                        company: 'Kalpaviruksha Pazhamudir Nilayam',
                        person: 'Ravi', gstin: '33AABCU9603R1ZM', mobile: '9342011780',
                        addr1: 'No 4, Anna Salai', addr2: 'Kilpauk', addr3: '',
                        state: 'Tamil Nadu', pincode: '600010', bank: {} };
    /* a long product name and a big number, because that is what drags a
       column out of true */
    DB.indents[d] = { KLP: { status: 'accepted',
                             lines: { '1': 120, '2': 300, '3': 55, '23': 40, '28': 12 } } };
    DB.days[d] = { rates: { '1': 80, '2': 27, '3': 34, '23': 62, '28': 9 },
                   packed: { KLP: { '1': 120, '2': 300, '3': 55, '23': 40, '28': 12 } },
                   ship: { KLP: 'received' }, sent: {} };
    save();
    go('inv'); makeInvoice('KLP');
    setInvField('KLP', 'vehicle', 'TN 01 AB 1234');
    setInvField('KLP', 'driver', 'Murugan');
    setInvField('KLP', 'place', 'Tamil Nadu');
    /* saved, because a saved bill is the one that gets printed and the
       boxes have become plain text by then */
    saveInvoice('KLP');
    render();
  });
  await p.waitForTimeout(400);
  return { ctx, p };
}

/* what the sheet looks like once the browser is told it is printing */
const measure = () => {
  const inv = document.getElementById('inv');
  const r = inv.getBoundingClientRect();
  const heads = Array.from(document.querySelectorAll('table.ibl thead th'))
    .filter(th => getComputedStyle(th).display !== 'none');
  const amountTh = heads.find(th => /Amount/i.test(th.textContent));
  const rows = Array.from(document.querySelectorAll('table.ibl tbody tr'));
  const netRow = rows[rows.length - 1];
  const netCells = Array.from(netRow.querySelectorAll('td'))
    .filter(td => getComputedStyle(td).display !== 'none');
  const side = document.getElementById('side');
  return {
    docOver: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    invLeft: Math.round(r.left),
    invRight: Math.round(r.right),
    sidebarShown: getComputedStyle(side).display !== 'none',
    mainLeft: Math.round(document.querySelector('main').getBoundingClientRect().left),
    headings: heads.map(th => th.textContent.trim()),
    /* the figure on the Net Amount line must finish where the Amount
       column finishes, or it is sitting under the wrong heading */
    amountRight: Math.round(amountTh.getBoundingClientRect().right),
    netFigureRight: Math.round(netCells[netCells.length - 1].getBoundingClientRect().right),
    netFigure: netCells[netCells.length - 1].textContent.trim(),
    /* nothing may stick out past the edge of the sheet */
    past: Array.from(document.querySelectorAll('#inv *'))
      .filter(el => el.getBoundingClientRect().right > r.right + 1)
      .map(el => (el.tagName + '.' + (el.className || '')).slice(0, 30)).slice(0, 3),
    /* a heading wider than the column it sits over is a clipped border
       in the making — S.No. was overrunning its 38px */
    squeezed: heads.filter(th => th.scrollWidth > th.clientWidth + 1)
      .map(th => th.textContent.trim() + ' ' + th.scrollWidth + '>' + th.clientWidth),
    bandEven: (() => {
      const d = document.querySelectorAll('.iband>div');
      return d.length === 2 &&
        Math.abs(d[0].getBoundingClientRect().width - d[1].getBoundingClientRect().width) <= 1;
    })(),

    /* the bank block was removed by request: nothing on the sheet may
       mention one, and the footer is words plus the space to sign */
    hasBank: /bank/i.test((document.getElementById('inv') || {}).textContent || ''),
    /* every label on the sheet is followed by a colon, and they all land
       on the same vertical line inside their own block */
    noColon: Array.from(document.querySelectorAll('.ipair'))
      .filter(r => !r.querySelector('.cln'))
      .map(r => r.textContent.trim().slice(0, 20)),
    colonsAligned: (() => {
      const bad = [];
      ['.imeta', '.iband .rgt'].forEach(sel => {
        const c = Array.from(document.querySelectorAll(sel + ' .ipair .cln'))
          .map(x => Math.round(x.getBoundingClientRect().left));
        if (c.length > 1 && Math.max.apply(null, c) - Math.min.apply(null, c) > 1) bad.push(sel);
      });
      return bad;
    })(),
    signRight: (() => {
      const f = document.querySelector('.ifoot .rgt');
      const inv = document.getElementById('inv');
      if (!f || !inv) return false;
      const fr = f.getBoundingClientRect(), ir = inv.getBoundingClientRect();
      /* bottom right of the sheet: in the right half, at the foot */
      return /Authorised Signatory/.test(f.textContent)
        && fr.left > ir.left + ir.width / 2;
    })(),
  };
};

(async () => {
  const b = await chromium.launch();

  for (const [who, email] of [['owner', 'owner@velora.example'],
                              ['admin', 'admin@velora.example']]) {
    console.log('\n' + who + ', on paper');
    const { ctx, p } = await billFor(b, email);
    await p.emulateMedia({ media: 'print' });
    await p.setViewportSize({ width: A4, height: 1000 });
    await p.waitForTimeout(300);
    const m = await p.evaluate(measure);

    check('the sidebar is not printed', m.sidebarShown, false);
    check('and main does not keep its margin', m.mainLeft, 0);
    check('the sheet starts at the left edge', m.invLeft, 0);
    check('and finishes inside the paper', m.invRight <= A4, true);
    check('nothing runs past the edge', m.past.join(', '), '');
    check('the page does not scroll sideways', m.docOver <= 0, true);

    check('the columns are the seven a bill has',
      m.headings.join('|'), 'S.No.|Code|Product|Quantity|Net Kg|Rate / Kg|Amount');
    check('no heading is squeezed out of its column', m.squeezed.join(', '), '');
    check('the two halves of the customer band are equal', m.bandEven, true);
    check('no bank details anywhere on the bill', m.hasBank, false);
    check('every label has its colon', m.noColon.join(', '), '');
    check('and they line up in a column', m.colonsAligned.join(', '), '');
    check('the signature block sits bottom right', m.signRight, true);
    check('the net amount reads right', /^[\d,]+\.\d\d$/.test(m.netFigure), true);
    check('and lines up under Amount', Math.abs(m.amountRight - m.netFigureRight) <= 1, true);

    /* the PDF the browser actually makes */
    const pdf = await p.pdf({ format: 'A4', printBackground: true,
                              margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
    check('a PDF comes out', pdf.length > 1000, true);
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    check('one sheet, not two', pages, 1);
    await ctx.close();
  }

  /* The shelf price is Velora's own working. It used to be an eighth
     column on the sheet, which pushed Amount in from the right edge and
     left the totals floating in the middle of the page. It is beside the
     bill now, and never printed. */
  console.log('\nthe shelf price is beside the bill, not on it');
  const { ctx, p } = await billFor(b, 'owner@velora.example');
  const onScreen = await p.evaluate(() =>
    Array.from(document.querySelectorAll('table.ibl thead th')).map(th => th.textContent.trim()));
  check('the sheet has seven columns on screen too',
    onScreen.join('|'), 'S.No.|Code|Product|Quantity|Net Kg|Rate / Kg|Amount');
  check('and Amount is the last of them', onScreen[onScreen.length - 1], 'Amount');
  check('the owner still gets the shelf prices',
    /Shelf prices/.test(await p.locator('#main').textContent()), true);
  await p.emulateMedia({ media: 'print' });
  await p.waitForTimeout(200);
  check('but they do not print', await p.evaluate(() => {
    const c = Array.from(document.querySelectorAll('.card'))
      .find(x => /Shelf prices/.test(x.textContent));
    return c ? getComputedStyle(c).display : 'none';
  }), 'none');
  await ctx.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
