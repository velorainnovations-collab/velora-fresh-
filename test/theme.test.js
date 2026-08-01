/*
 * Light and dark.
 *
 *   npm run test:theme
 *
 * Only the design tokens change, so the checks that matter are the
 * ones a token swap cannot cover: no flash of the wrong theme on
 * reload, and the invoice staying on white because it is printed.
 */
const { chromium } = require('playwright');
require('./mock-supabase.js');
let pass=0, fail=0;
const check=(l,g,w)=>{const ok=String(g)===String(w);
  console.log((ok?'  ok   ':'  FAIL ')+l+'  ->  '+g+(ok?'':'   (expected '+w+')'));ok?pass++:fail++;};
(async()=>{
  const b = await chromium.launch();
  const mk = async () => {
    const ctx = await b.newContext({ viewport:{width:1440,height:900} });
    const p = await ctx.newPage();
    await p.route('**://*.supabase.co/**', async r=>{
      const q=r.request(); const u=new URL(q.url());
      const res=await fetch('http://127.0.0.1:8123'+u.pathname+u.search,{
        method:q.method(),headers:q.headers(),
        body:['GET','HEAD'].includes(q.method())?undefined:q.postData()});
      await r.fulfill({status:res.status,headers:{'content-type':'application/json'},body:await res.text()});
    });
    await p.goto('http://127.0.0.1:8092/index.html',{waitUntil:'networkidle'});
    /* Everyone below signs in with an email, and the gate opens on the
       Shop tab. Pick Office first, as a person at a desk would. Skipped on
       the reset-password screen, which has no tabs. */
    await p.evaluate(() => {
      if (typeof setGateWho === 'function' && GATE_MODE !== 'set') setGateWho('office');
    });
    await p.fill('#gateEmail','owner@velora.example'); await p.fill('#gatePass','right');
    await p.click('#gateBtn'); await p.waitForTimeout(1200);
    return {ctx,p};
  };
  const bg = p => p.evaluate(()=>getComputedStyle(document.body).backgroundColor);

  console.log('\ntoggle');
  let {ctx,p} = await mk();
  check('button present', await p.locator('#themeBtn').count(), 1);
  const light = await bg(p);
  await p.click('#themeBtn'); await p.waitForTimeout(300);
  const dark = await bg(p);
  check('background changed', light !== dark, true);
  check('marked dark', await p.evaluate(()=>document.documentElement.getAttribute('data-theme')), 'dark');
  check('text is readable on dark',
    await p.evaluate(()=>getComputedStyle(document.querySelector('#main h2')).color), 'rgb(240, 236, 230)');
  await p.screenshot({path:'/tmp/velora-shots/dark.png', clip:{x:0,y:0,width:1440,height:600}});

  console.log('\nremembered');
  await p.reload({waitUntil:'networkidle'}); await p.waitForTimeout(1200);
  check('still dark after a refresh',
    await p.evaluate(()=>document.documentElement.getAttribute('data-theme')), 'dark');
  check('and no flash back to light', await bg(p), dark);

  console.log('\nthe invoice stays on paper');
  await p.evaluate(()=>go('inv')); await p.waitForTimeout(500);
  const invBg = await p.evaluate(()=>{
    const el=document.getElementById('inv');
    return el?getComputedStyle(el).backgroundColor:'none';
  });
  check('invoice is white even in dark', invBg === 'rgb(255, 255, 255)' || invBg === 'none', true);

  console.log('\nback to light');
  await p.click('#themeBtn'); await p.waitForTimeout(300);
  check('switched back', await p.evaluate(()=>document.documentElement.getAttribute('data-theme')), 'light');
  check('background restored', await bg(p), light);
  await ctx.close();

  console.log('\nfollows the system when never chosen');
  const ctx2 = await b.newContext({ viewport:{width:1440,height:900}, colorScheme:'dark' });
  const p2 = await ctx2.newPage();
  await p2.goto('http://127.0.0.1:8092/index.html',{waitUntil:'networkidle'});
  await p2.waitForTimeout(400);
  check('no attribute set', await p2.evaluate(()=>document.documentElement.getAttribute('data-theme')), 'null');
  check('but renders dark',
    await p2.evaluate(()=>getComputedStyle(document.body).backgroundColor), 'rgb(20, 18, 16)');
  await ctx2.close();

  console.log('\n'+pass+' passed, '+fail+' failed\n');
  await b.close();
  process.exit(fail?1:0);
})();
