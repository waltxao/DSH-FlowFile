// 第 3 轮清理 P0 · 六档真实渲染断言 + 逐档截图（playwright-core + 本机 Chrome headless）。
// 与第 2 轮 /tmp/ff-vision-render.cjs 同口径，新增第 6 tab / 清理面板断言与清理态截图。
// NODE_PATH=/Users/waltxao/.dsh/profiles/desktop/node_modules 必须显式给。
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const html = 'file://' + path.join(ROOT, 'docs/FlowFile-视觉验收.html');
const css = (() => { const box = {}; vm.createContext(box); vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/client-style.js'), 'utf8') + '\n;globalThis.__c=FD_CSS;', box); return box.__c; })();
const bc = fs.readFileSync(path.join(ROOT, 'src/client-browse.js'), 'utf8');
const gridFn = bc.slice(bc.indexOf('function fdGridCSS'), bc.indexOf('function FF_Head'));
const gridCss = (() => { const box = {}; vm.createContext(box); vm.runInContext(gridFn + '\n;globalThis.__g=fdGridCSS([{key:"name",visible:true,width:null},{key:"size",visible:true,width:96},{key:"mtime",visible:true,width:152},{key:"tags",visible:true,width:168}]);', box); return box.__g; })();
const OUT = path.join(ROOT, 'docs');
const CASES = [
  { id: 'default', w: 1440, h: 900, theme: 'default', label: '宿主真实宽 1440×900', expectThirdHidden: false, expectFourthHidden: false },
  { id: 'narrow320', w: 320, h: 720, theme: 'default', label: '极窄 320×720', expectThirdHidden: true, expectFourthHidden: true },
  { id: 'wide2560', w: 2560, h: 1000, theme: 'default', label: '超宽 2560×1000', expectThirdHidden: false, expectFourthHidden: false },
  { id: 'zoom200', w: 720, h: 900, theme: 'default', label: '200% 缩放（等效 720 CSS 视口）', expectThirdHidden: false, expectFourthHidden: true },
  { id: 'dark', w: 1440, h: 900, theme: 'dark', label: '系统深色', expectThirdHidden: false, expectFourthHidden: false },
  { id: 'rtl', w: 1440, h: 900, theme: 'rtl', label: 'RTL 方向', expectThirdHidden: false, expectFourthHidden: false },
];
(async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'] });
  const results = [];
  for (const c of CASES) {
    const page = await browser.newPage({ viewport: { width: c.w, height: c.h }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(html, { waitUntil: 'load' });
    await page.addStyleTag({ content: css });
    await page.addStyleTag({ content: gridCss });
    await page.evaluate(t => window.__setTheme(t), c.theme);
    await page.waitForTimeout(140);
    const a = await page.evaluate(() => window.__assert());
    await page.screenshot({ path: path.join(OUT, '视觉验收-clean-' + c.id + '.png') });
    // 切到清理面板态再截一张（每档都验第 6 tab 不撑破）
    await page.evaluate(() => window.__showClean());
    await page.waitForTimeout(60);
    const ac = await page.evaluate(() => window.__assert());
    await page.screenshot({ path: path.join(OUT, '视觉验收-cleanpanel-' + c.id + '.png') });
    const checks = {
      noHorizontalOverflow: a.tableOverflow.sw <= a.tableOverflow.cw + 1 && a.rootScrollX <= 1,
      namesEllipsis: a.names.length > 0 && a.names.every(n => n.ellipsis === 'ellipsis'),
      numsVisible: a.nums.length >= 4 && a.nums.every(w => w > 0),
      colsMatchBreakpoint: a.hiddenThird === c.expectThirdHidden && a.hiddenFourth === c.expectFourthHidden,
      skeleton39: Math.abs(a.skeletonH - 39) < 2,
      icons: a.icoCount >= 4,
      modelSelect: a.modelSelect,
      directionA: a.rootBg === 'rgb(12, 14, 19)',
      chips: a.chips >= 3,
      navBar: a.navBar,
      addressBar: a.addressBar,
      sortHead: a.sortHead === 4,
      sidebarSections: a.sidebarSections >= 4,
      sidebarItems: a.sidebarItems >= 6,
      capacityBar: a.capacityBar,
      statusBar: a.statusBar && a.statusText.indexOf('4 项') >= 0,
      // 第 3 轮清理新增
      sixTabs: a.tabsCount === 6 && a.cleanTab,
      tabsNoOverflow: a.tabsOverflow <= 1,
      cleanPanelExists: a.cleanPanel && ac.cleanPanel,
      cleanDefaultUnchecked: ac.cleanChecks === 3 && ac.cleanAllUnchecked === true,
      cleanPanelNoOverflow: ac.cleanPanelOverflow <= 1,
      noPageErrors: errors.length === 0,
    };
    const failed = Object.keys(checks).filter(k => !checks[k]);
    results.push({ id: c.id, label: c.label, checks, failed, pageerrors: errors,
      assert: { tabsCount: a.tabsCount, tabsOverflow: a.tabsOverflow, cleanChecks: ac.cleanChecks,
        cleanAllUnchecked: ac.cleanAllUnchecked, cleanPanelOverflow: ac.cleanPanelOverflow,
        rootScrollX: a.rootScrollX, hiddenThird: a.hiddenThird, hiddenFourth: a.hiddenFourth } });
    await page.close();
  }
  await browser.close();
  console.log(JSON.stringify(results, null, 2));
  const allPass = results.every(r => r.failed.length === 0);
  console.log('SIX_VIEW_VERDICT=' + (allPass ? 'PASS' : 'FAIL'));
  console.log('PAGEERRORS=' + JSON.stringify(results.flatMap(r => r.pageerrors)));
  process.exit(allPass ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });