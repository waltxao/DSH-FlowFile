// 第 13 轮 v4 布局：对话回到底部全宽 dock、顶栏合并成一行、右键「在新标签页中打开」。
// 失败测试先行（m06568 三条意见：①对话框不该在预览窗格 ②界面布局重新设计一套 ③右键要在新标签页中打开）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const app = fs.readFileSync(path.join(root, 'src/client-app.js'), 'utf8')
const browse = fs.readFileSync(path.join(root, 'src/client-browse.js'), 'utf8')
const core = fs.readFileSync(path.join(root, 'src/browse-core.js'), 'utf8')
const css = fs.readFileSync(path.join(root, 'src/client-style.js'), 'utf8')
const dist = fs.readFileSync(path.join(root, 'dist/client.js'), 'utf8')
const tahoe = fs.readFileSync(path.join(root, 'src/client-tahoe.js'), 'utf8')
const ui = fs.readFileSync(path.join(root, 'src/client-tahoe-ui.js'), 'utf8')
const tahoeUi = fs.readFileSync(path.join(root, 'src/client-tahoe-ui.js'), 'utf8')

// 第 20 轮（m09643）：对话形态第三次换代——v4 的全幅底栏 → 第18轮右栏常驻 → 现在的灵动底坞 + AI 抽屉。
// 三轮共同的硬约束只有一条：对话不许塞进预览窗格、不许把文件表挤成半截。
test('① 对话走灵动底坞 + AI 抽屉，不再塞进预览窗格', () => {
  const pane = app.indexOf("className: 'pane focused'")
  const dock = app.indexOf('h(FF_TDock')
  const drawer = app.indexOf('h(FF_TDrawer')
  assert.ok(pane > 0, '缺少文件空间卡 pane')
  assert.ok(dock > pane && drawer > dock, '底坞在卡片内、抽屉在其后')
  assert.equal(app.indexOf('fd-splitter-h'), -1, '右栏内「预览|对话」分隔条应移除')
  assert.ok(tahoe.includes('.fd-root .dock{'), 'CSS 需要 .dock（灵动底坞）')
  assert.ok(tahoe.includes('.dock[data-tier="expanded"]'), 'CSS 需要三档高度（idle/selected/expanded）')
  assert.ok(tahoe.includes('.fd-root .drawer'), 'CSS 需要 .drawer（AI 抽屉）')
})

test('② 顶部只有一条协调栏（前进后退 + 面包屑 + 搜索 + 密度 + AI）', () => {
  assert.ok(tahoe.includes('.fd-root .coord{'), 'CSS 需要 .coord 协调栏')
  assert.equal(css.includes('.fd-top{'), false, '旧 .fd-top 行应移除')
  assert.ok(tahoeUi.includes('function FF_TCoord'), '需要有协调栏组件')
  assert.ok(tahoeUi.includes("className: 'coord'"), '组件根节点用 .coord')
  assert.equal(app.indexOf("className: 'fd-topbar'"), -1, '旧两条顶栏（topbar + subbar）已被单条 coord 取代')
  assert.ok(tahoeUi.indexOf('nav-sq') > 0 && tahoeUi.indexOf('glass-chip') > 0, '导航钮与操作 chip 都在同一条协调栏里')
})

test('③ 右键「在新标签页中打开」：菜单项 + 分发 + 双击传事件', () => {
  assert.ok(core.includes("push('openTab'"), 'menuFor 需要 openTab 项')
  assert.ok(core.includes('在新标签页中打开'), '菜单文案')
  assert.ok(app.includes("id === 'openTab'"), 'onMenuAction 需要分发 openTab')
  assert.ok(browse.includes('props.onOpen(e, ev)'), '行与磁贴双击需要把事件传出去（⌘ 双击新标签页）')
})

test('④ 目录双击原地导航，只有 ⌘ 双击才新开标签（原来每次下钻都新开 tab）', () => {
  const m = app.match(/function openEntry\(e, ev\)[\s\S]*?\n  \}/)
  assert.ok(m, 'openEntry 需要接收事件参数')
  const body = m[0]
  assert.ok(/metaKey|ctrlKey/.test(body), 'openEntry 需要 ⌘/Ctrl 判断')
  assert.ok(/mod \? openTab\(e\.path\) : go\(e\.path\)/.test(body), '有 ⌘ 才 openTab，否则 go 原地导航')
})

test('⑤ 底坞三档：idle/selected 定高，expanded 由内容驱动，展开由用户控制', () => {
  // 46/58 = 内容 44/56 + 2px 边框（border-box），否则玻璃面板会把内部顶出 2px
  assert.ok(tahoe.includes('.dock[data-tier="idle"]{height:46px'), 'idle 档 46px（含 1px 边框×2）')
  assert.ok(tahoe.includes('.dock[data-tier="selected"]{height:58px'), 'selected 档 58px（含 1px 边框×2）')
  // 第 22 轮：expanded 原来写死 128px，而内容实测需 139px+2px 边框 → 属性网格被裁掉 8px。
  // 现在按实测内容定 141px（4 列两行、每项 nowrap，高度恒定），既容纳得下又不破坏三档过渡。
  assert.ok(tahoe.includes('.dock[data-tier="expanded"]{height:141px'), 'expanded 档高度与实测内容一致（139+2）')
  assert.ok(tahoe.includes('.dock-drawer{flex:1 1 auto;min-height:0;overflow:hidden'), 'drawer 在定高容器内裁切，不撑破底坞')
  // 滚动区让位跟随底坞真实档位，否则最后几行会被玻璃面板压住
  assert.ok(tahoe.includes('.pane[data-dock="expanded"] .rows'), '滚动区让位随档位联动（data-dock 由选中+展开共同决定）')
  // 展开必须由用户点把手控制，不能一选中就弹开
  assert.ok(app.includes('dockOpen'), '底坞展开状态')
  assert.ok(app.includes('onDockToggle: setDockOpen'), '展开把手回调')
  assert.ok(ui.includes("var tier = !sel ? 'idle' : (open ? 'expanded' : 'selected')"), '三档由选中 + 展开共同决定')
  assert.ok(app.includes("flowfile.layout"), '布局持久化键')
  assert.ok(app.includes('fdSaveDensity'), '密度偏好持久化')
  assert.ok(app.includes('drawerOpen'), 'AI 抽屉开关状态')
})

test('⑥ 对话气泡读 content（原来读 m.text，DB 字段是 content，气泡全是空）', () => {
  const seg = browse.slice(browse.indexOf('function FF_AiDock'), browse.indexOf('// ---- QuickLook'))
  assert.ok(seg.includes('m.content'), 'FF_AiDock 必须用 m.content 渲染')
  assert.equal(/m\.text\b/.test(seg), false, '不得再读 m.text')
})

test('⑦ 模型下拉回到 dock 头部（FF_Chat 不再使用时不能把选模型入口一起弄丢）', () => {
  assert.ok(app.includes('onModel: chooseModel'), 'dock 头部需要模型下拉回调')
  assert.ok(browse.includes("className: 'fd-model'"), '模型下拉选择器')
  assert.ok(browse.includes('跟随宿主默认'), '保留跟随宿主默认选项')
})

test('⑧ dist 已同步', () => {
  assert.ok(dist.includes('fd-dock'), 'dist 含 fd-dock')
  assert.ok(dist.includes('在新标签页中打开'), 'dist 含新菜单项')
})
