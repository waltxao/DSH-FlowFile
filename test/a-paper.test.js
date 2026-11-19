// 第 19 轮（m09330「开始实施」）：皮肤从 A 纸面（赤陶 #a8492c）迁到 Tahoe 26 语义体系（accent #007aff）。
// 视觉真源改为 /Volumes/Iris-Data/文件管理系统/docs/design/FLOWFINDER-COMPLETE-UIUX-SYSTEM-V4.html。
// 结构契约不变（三栏 / 左树保留 / 底栏胶囊 composer / 30px 行高 / 无逐行硬线），仅 token 更新。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// 取运行时真正拼好的 FD_CSS（不是源码文本）：源码里的注释也含 "transition:all" 字样，
// 用源码文本做断言会把注释误判成违规样式（vision.test.js 同样是走 vm 取 FD_CSS）。
function cssOf(rel) {
  const code = readFileSync(new URL(rel, import.meta.url), 'utf8')
  const box = {}
  vm.createContext(box)
  vm.runInContext(code + ";globalThis.__css=FD_CSS;", box)
  return box.__css
}
const css = cssOf('../src/client-style.js')
const app = readFileSync(new URL('../src/client-app.js', import.meta.url), 'utf8')
const dist = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')

test('A① Tahoe 26 token：白底 / ink 中性阶 / 语义蓝 accent / 发丝线', () => {
  assert.ok(css.includes('--fd-bg:#ffffff'), '背景应为 #ffffff')
  assert.ok(css.includes('--fd-panel:#f7f8fb'), '面板应为 #f7f8fb')
  assert.ok(css.includes('--fd-ink:#14161b'), '主文字应为 #14161b')
  assert.ok(css.includes('--fd-ink2:#6b7284'), '次文字应为 #6b7284')
  assert.ok(css.includes('--fd-line:#e4e7ef'), '分隔线应为 #e4e7ef')
  assert.ok(css.includes('--fd-accent:#007aff'), 'accent 应为系统蓝 #007aff')
  assert.equal(css.includes('--fd-accent:#a8492c'), false, '旧赤陶 accent 必须退场')
})

test('A② 地址栏是紧凑路径标题（sans 13px），不是衬线大字', () => {
  const rule = css.match(/\.fd-addr\{[^}]*\}/)
  assert.ok(rule, '需要 .fd-addr 规则')
  assert.equal(/Songti/.test(rule[0]), false, 'Tahoe：衬线族必须退场')
  assert.ok(/font-size:1[0-4]px/.test(rule[0]), '地址栏字号应落在 10-14px 紧凑档：' + rule[0])
  assert.ok(/border-radius:/.test(rule[0]), '地址栏走圆角 chip，不是无框衬线标题')
})

test('A③ 行高 30px（第18轮 A 方案）+ 文件名 13.5px（层级靠字号，不靠边框）', () => {
  // 第 18 轮 A 方案：用户反馈「字太大内容少」，行高由 44px 压到 30px。
  assert.ok(css.includes('--fd-row-h:30px'), '行高变量应为 30px')
  const name = css.match(/\.fd-name span\{[^}]*\}/)
  assert.ok(name, '需要文件名规则')
  assert.ok(/font-size:12\.5px/.test(name[0]), '文件名应为 12.5px（Tahoe 高密度）：' + name[0])
})

test('A④ 发丝分隔线替代整屏网格：行间用 inset 1px 阴影，不回到 border-bottom', () => {
  const row = css.match(/\.fd-row\{[^}]*\}/)
  assert.ok(row, '需要 .fd-row 规则')
  assert.equal(/border-bottom/.test(row[0]), false, '.fd-row 本体不得有 border-bottom')
  assert.ok(/\.fd-row \+ \.fd-row\{[^}]*inset 0 1px 0/.test(css), '行间应改 inset 1px 发丝线')
})

test('A⑤ 顶栏按钮退成文字动作：无边框无底色，靠留白分组', () => {
  assert.ok(/\.fd-topbar \.fd-btn\{[^}]*border-color:transparent/.test(css), '顶栏按钮边框应透明')
  assert.ok(/\.fd-topbar \.fd-btn\{[^}]*background:transparent/.test(css), '顶栏按钮底色应透明')
  assert.ok(css.includes('.fd-topbar .fd-btn:hover'), '悬停才显形')
})

test('A⑥ 底栏是胶囊 composer', () => {
  const inp = css.match(/\.fd-dock-in input\{[^}]*\}/)
  assert.ok(inp, '需要 dock 输入规则')
  assert.ok(/border-radius:(999px|1[6-9]px|2[0-9]px)/.test(inp[0]), '输入框应为胶囊：' + inp[0])
  assert.ok(css.includes('.fd-dock-send'), '需要圆形发送键样式')
})

test('A⑦ 左侧文件树保留（用户硬约束），且用 A 的纸面语言', () => {
  assert.ok(css.includes('.fd-tree{'), '左树 CSS 必须保留')
  assert.ok(css.includes('--fd-tree-w'), '左树宽度仍走变量（可拖）')
  assert.ok(app.includes('h(FF_Tree'), '主界面必须继续渲染 FF_Tree')
  const tree = css.match(/\.fd-tree\{[^}]*\}/)
  assert.ok(/--fd-panel|--fd-bg/.test(tree[0]), '左树底色走 A token：' + tree[0])
  assert.ok(css.includes('.fd-tree-node.is-on'), '左树选中态保留')
})

test('A⑧ 无逐行硬线的前提下仍守住工程约束', () => {
  assert.equal(/transition:\s*all/.test(css), false, '严禁 transition:all')
  assert.ok(css.includes(':focus-visible'), '焦点环保留')
  assert.ok(css.includes('prefers-reduced-motion'), '减弱动效保留')
  assert.ok(css.includes('tabular-nums'), '数字仍 tabular-nums')
})

test('A⑨ dist 已同步 Tahoe 26', () => {
  assert.ok(dist.includes('--fd-accent:#007aff'), 'dist 含系统蓝 accent')
  assert.ok(dist.includes('--fd-row-h:30px'), 'dist 含 30px 行高（第18轮）')
});
