// FlowFile 结构方向对比稿：三方向真实渲染 + DOM 断言 + 逐态截图
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const HTML = 'file://' + path.join(ROOT, 'docs/FlowFile-结构方向对比稿.html');
const OUT = path.join(ROOT, 'docs');
const html = fs.readFileSync(path.join(ROOT, 'docs/FlowFile-结构方向对比稿.html'), 'utf8');

// 1) 内联 JS 语法级校验
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.log('NO_SCRIPT'); process.exit(1); }
try { new Function(m[1]); console.log('INLINE_JS_SYNTAX=OK'); }
catch (e) { console.log('INLINE_JS_SYNTAX=FAIL ' + e.message); process.exit(1); }

// 2) 三方向断言定义
const EXPECT = {
  a: { name: '甲·文件主角', railPart: true, railVol: false, preview: true, tabs: false, chat: false, cmdhint: false, fifthCol: true, rowH: 38 },
  b: { name: '乙·整容', railPart: false, railVol: true, preview: false, tabs: true, chat: true, cmdhint: false, fifthCol: false, rowH: 38 },
  c: { name: '丙·深色专业', railPart: true, railVol: false, preview: false, tabs: false, chat: false, cmdhint: true, fifthCol: true, rowH: 32 },
};
const vis = el => el && el.offsetWidth > 0 && el.offsetHeight > 0 && getComputedStyle(el).display !== 'none';

(async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'] });
  const results = [];
  const pageErrors = [];
  for (const k of ['a', 'b', 'c']) {
    const page = await browser.newPage({ viewport: { width: 1180, height: 840 }, deviceScaleFactor: 2 });
    page.on('pageerror', e => pageErrors.push(k + ': ' + e.message));
    await page.goto(HTML + '?v=' + k, { waitUntil: 'load' });
    await page.waitForTimeout(180);
    const e = EXPECT[k];
    const r = await page.evaluate((arg) => {
      const e = arg.e; const k = arg.k; const vis = eval('(' + arg.visSrc + ')');
      const q = s => document.querySelector(s);
      const thead = q('.thead');
      const row = q('.row');
      const fifth = thead.children[4];
      const checks = {
        railPartShown: vis(q('.rail-part')),
        railVolShown: vis(q('.rail-vol')),
        previewShown: vis(q('.preview')),
        tabsShown: vis(q('.tabs')),
        chatShown: vis(q('.chat')),
        cmdhintShown: vis(q('.cmdhint')),
        fifthColShown: fifth ? getComputedStyle(fifth).display !== 'none' : false,
        rowH: row ? Math.round(row.getBoundingClientRect().height) : -1,
        winW: Math.round(q('.win').getBoundingClientRect().width),
        winH: Math.round(q('.win').getBoundingClientRect().height),
        bodyTheme: document.body.getAttribute('data-v'),
        rows: document.querySelectorAll('.row').length,
        dirIcons: document.querySelectorAll('.fic.dir').length,
      };
      checks.failed = [];
      if (checks.railPartShown !== e.railPart) checks.failed.push('railPart');
      if (checks.railVolShown !== e.railVol) checks.failed.push('railVol');
      if (checks.previewShown !== e.preview) checks.failed.push('preview');
      if (checks.tabsShown !== e.tabs) checks.failed.push('tabs');
      if (checks.chatShown !== e.chat) checks.failed.push('chat');
      if (checks.cmdhintShown !== e.cmdhint) checks.failed.push('cmdhint');
      if (checks.fifthColShown !== e.fifthCol) checks.failed.push('fifthCol');
      if (checks.rowH !== e.rowH) checks.failed.push('rowH=' + checks.rowH);
      if (checks.bodyTheme !== k) checks.failed.push('bodyTheme');
      if (checks.winW !== 1120 || checks.winH !== 720) checks.failed.push('winSize');
      return checks;
    }, { e: e, visSrc: vis.toString(), k: k });
    // 每方向截 .win 元素（真实 1120x720 @2x）
    const win = page.locator('.win');
    const png = path.join(OUT, '结构方向-' + k + '.png');
    await win.screenshot({ path: png });
    r.png = png;
    r.bytes = fs.statSync(png).size;
    r.name = e.name;
    results.push(r);
    await page.close();
  }
  await browser.close();
  console.log('PAGEERRORS=' + JSON.stringify(pageErrors));
  for (const r of results) {
    console.log(JSON.stringify({ v: r.bodyTheme, name: r.name, failed: r.failed, railPart: r.railPartShown, railVol: r.railVolShown, preview: r.previewShown, tabs: r.tabsShown, chat: r.chatShown, cmdhint: r.cmdhintShown, fifthCol: r.fifthColShown, rowH: r.rowH, winW: r.winW, winH: r.winH, rows: r.rows, dirIcons: r.dirIcons, bytes: r.bytes }));
  }
  const allPass = results.every(r => r.failed.length === 0) && pageErrors.length === 0;
  console.log('THREE_WAY_VERDICT=' + (allPass ? 'PASS' : 'FAIL'));
})();
