import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 乙方案（m04901「按 乙方案开工」）落地契约：保持三栏＋底部对话＋6 tab 骨架，
// 只整容 = ①亮色 Finder 式 token ②清掉白底浅字的深色硬编码 ③真类型图标 ④对话默认折叠。
// 装配层必须一行不动，用 characterization 断言锁住。

const css = readFileSync(new URL('../src/client-style.js', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/client-app.js', import.meta.url), 'utf8')
const BUNDLE = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')

function loadIcon() {
  const react = { createElement: (...a) => ({ args: a }), useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useEffect: () => {}, useRef: () => ({ current: null }), useMemo: (f) => f() }
  const window = { __ModuleLoader__: { load(d) { window.__factory = d.factory } } }
  const probe = BUNDLE.replace('return module.exports}});', 'window.__probe={FF_FileIcon:FF_FileIcon};return module.exports}});')
  const req = (n) => { if (n === 'react') return react; throw new Error('unexpected require: ' + n) }
  new Function('window', 'require', probe)(window, req)
  window.__factory(req)
  return window.__probe.FF_FileIcon
}

test('乙①（第 19 轮同步）：仍是亮色体系，token 已迁到 Tahoe 26', () => {
  // 骨架结论（亮色、单一 accent、color-scheme:light）不动；
  // 具体色值改由 docs/design/FLOWFINDER-COMPLETE-UIUX-SYSTEM-V4.html 接管。
  assert.match(css, /color-scheme:light/)
  assert.match(css, /--fd-bg:#ffffff;/)
  assert.match(css, /--fd-panel:#f7f8fb;/)
  assert.match(css, /--fd-ink:#14161b;/)
  assert.match(css, /--fd-accent:#007aff;/)
})

test('乙②：亮色下不留白底浅字/深底补丁的深色硬编码', () => {
  const dark = ['color:#c9cfdd','color:#9aa3b6','color:#8a93a8','color:#5a6275',
    'color:#8fe3b3','color:#e6b48a','color:#a9b4d6','color:#9fb0ff',
    'color:#7ee0a8','color:#ff9a92','color:#7fd6a2',
    'background:#191d27','background:#1c2130','#171c26 50%']
  dark.forEach((d) => assert.ok(css.indexOf(d) < 0, '残留深色硬编码: ' + d))
})

test('乙③：FF_FileIcon 渲染 svg 类型图标（带 path），不是字母方块', () => {
  const Ico = loadIcon()
  const v = Ico({ entry: { isDir: true, tags: [{ name: '文件夹', category: 'folder' }] } })
  assert.ok(v && v.args, '必须返回 vnode')
  assert.equal(v.args[0], 'svg', '顶层必须是 svg')
  assert.ok(v.args.slice(2).some((k) => k && k.args && k.args[0] === 'path'), 'svg 内必须有 path 图形')
})

test('乙④：不同类别渲染不同图标 path（真类型区分，不是同一字母变色）', () => {
  const Ico = loadIcon()
  const dir = Ico({ entry: { isDir: true } })
  const img = Ico({ entry: { isDir: false, tags: [{ name: '图片', category: 'image' }] } })
  const doc = Ico({ entry: { isDir: false, tags: [{ name: '文档', category: 'document' }] } })
  const sig = (v) => v.args.slice(2).map((k) => (k && k.args && k.args[1] ? k.args[1].d : '')).join('|')
  assert.notEqual(sig(dir), sig(img), '文件夹与图片图标必须不同')
  assert.notEqual(sig(img), sig(doc), '图片与文档图标必须不同')
})

test('乙⑤：对话抽屉默认折叠（chatOpen 初始 false）', () => {
  assert.match(app, /var chatOpenState = React\.useState\(false\)/, '默认折叠')
})

test('乙⑥（characterization）：三栏骨架 / main slot / 6 tab 装配不被改动', () => {
  assert.ok(app.indexOf("slots.inject('main'") >= 0, 'main slot 保留')
  assert.ok(app.indexOf('sidebar.panellist') >= 0, '左侧入口保留')
  assert.ok(app.indexOf('var FF_TABS = [') >= 0, 'tab 数组保留')
  assert.ok(css.indexOf('.fd-body{display:flex') >= 0, '三栏容器保留')
  assert.ok(css.indexOf('.fd-rail{') >= 0, '左栏保留')
  assert.ok(css.indexOf('.fd-right{') >= 0, '右栏保留')
  assert.ok(css.indexOf('.fd-chat{') >= 0, '底部对话保留')
})
