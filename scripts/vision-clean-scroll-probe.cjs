const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const ROOT = '/Volumes/Iris-Data/Download/DSH-F/flowfile';
const html = 'file://' + path.join(ROOT, 'docs/FlowFile-视觉验收.html');
const css = (() => { const b={}; vm.createContext(b); vm.runInContext(fs.readFileSync(path.join(ROOT,'src/client-style.js'),'utf8')+'\n;globalThis.__c=FD_CSS;',b); return b.__c; })();
(async () => {
  const browser = await chromium.launch({ executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true, args:['--no-sandbox'] });
  const page = await browser.newPage({ viewport:{width:320,height:720}, deviceScaleFactor:2 });
  await page.goto(html,{waitUntil:'load'});
  await page.addStyleTag({content:css});
  await page.evaluate(() => window.__showClean());
  await page.waitForTimeout(100);
  const m = await page.evaluate(() => {
    const c = document.getElementById('panel-clean');
    const card = c.querySelector('.fd-card');
    const last = Array.prototype.slice.call(c.querySelectorAll('.fd-check')).pop();
    return { panelClientH: c.clientHeight, panelScrollH: c.scrollHeight, panelOverflowY: getComputedStyle(c).overflowY,
      panelCanScroll: c.scrollHeight > c.clientHeight + 1,
      cardBottom: card.getBoundingClientRect().bottom, lastCheckTop: last.getBoundingClientRect().top,
      lastCheckInDom: !!last, lastCheckText: last.textContent.slice(0,24),
      rootH: document.getElementById('root').clientHeight };
  });
  // 滚到底再看最后一项是否进入视口
  await page.evaluate(() => { const c=document.getElementById('panel-clean'); c.scrollTop=c.scrollHeight; });
  await page.waitForTimeout(60);
  const after = await page.evaluate(() => {
    const c = document.getElementById('panel-clean');
    const last = Array.prototype.slice.call(c.querySelectorAll('.fd-check')).pop();
    const r = last.getBoundingClientRect(), pr = c.getBoundingClientRect();
    return { scrollTop: c.scrollTop, lastVisible: r.top >= pr.top - 1 && r.bottom <= pr.bottom + 1, lastTop: r.top, panelBottom: pr.bottom };
  });
  console.log(JSON.stringify({before:m, afterScroll:after},null,2));
  await browser.close();
})().catch(e=>{console.error(e);process.exit(2)});