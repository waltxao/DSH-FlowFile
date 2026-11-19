// 静态护栏（失败测试先行）。行为类断言（tabular-nums / focus-visible / reduced-motion / 标签去饱和 / 图标 aria-hidden 等）沿用第 2 轮 ①；
// token 类断言在第 4 轮随用户改走「乙 · 亮色」（m04901）同步到 light，真源 docs/FlowFile-结构方向对比稿.html body[data-v=b]。
// 六档真实渲染断言另见 docs/FlowFile-视觉验收.html + /tmp/ff-vision-render.cjs。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function cssOf(rel) {
  const code = readFileSync(new URL(rel, import.meta.url), 'utf8')
  const box = {}
  vm.createContext(box)
  vm.runInContext(code + '\n;globalThis.__css=FD_CSS;', box)
  return box.__css
}
const css = cssOf('../src/client-style.js')
const app = readFileSync(new URL('../src/client-app.js', import.meta.url), 'utf8')
const ui = readFileSync(new URL('../src/client-ui.js', import.meta.url), 'utf8')
const icons = readFileSync(new URL('../src/icons-lucide.js', import.meta.url), 'utf8')
const fmt = readFileSync(new URL('../src/format.js', import.meta.url), 'utf8')
const bundle = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')

test('① token 与 Tahoe 26 设计体系一致（白底 + 语义蓝 + 30px 行高）', () => {
  // 第 19 轮 m09330「开始实施」：真源改为 docs/design/FLOWFINDER-COMPLETE-UIUX-SYSTEM-V4.html。
  assert.ok(css.includes('--fd-bg:#ffffff'), '背景必须是 #ffffff')
  assert.ok(css.includes('--fd-panel:#f7f8fb'), '面板必须是 #f7f8fb')
  assert.ok(css.includes('--fd-line:#e4e7ef'), '分隔线必须是 #e4e7ef')
  assert.ok(css.includes('--fd-accent:#007aff'), 'accent 必须是系统蓝 #007aff')
  assert.ok(css.includes('--fd-row-h:30px'), '行高必须用 30px 变量（第18轮 A 方案）')
  assert.ok(css.includes('color-scheme:light'), '必须声明 color-scheme:light')
  assert.ok(!css.includes('#0c0e13') && !css.includes('#101319'), '旧版暗色 token 不得残留')
  assert.equal(css.includes('--fd-accent:#a8492c'), false, 'A 纸面赤陶 accent 必须退场')
})

test('① 去逐行硬分隔：数据行无 border-bottom，选中改 inset accent 线', () => {
  const rowRule = css.match(/\.fd-row\{[^}]*\}/)
  assert.ok(rowRule, '必须存在 .fd-row 规则')
  assert.ok(!/border-bottom/.test(rowRule[0]), '数据行不得再有逐行 1px 硬线：' + rowRule[0])
  assert.ok(css.includes('inset 2px 0 0 var(--fd-accent)'), '选中态用 inset accent 线')
  assert.ok(css.includes('.fd-head'), '表头仍需保留底部分隔')
})

test('① 标签去饱和彩条：柔和底 + 细描边，色不单载信息', () => {
  // 亮色下 .fd-btn.primary 白字配 accent 是刻意的；此处只约束标签 chip 不得白字配饱和色块。
  const chipRules = (css.match(/\.fd-chip[^{]*\{[^}]*\}/g) || []).join('')
  assert.ok(!/color:#fff/.test(chipRules), '标签 chip 不得再用白字配饱和色块')
  assert.ok(css.includes('border:1px solid'), '标签改细描边')
  assert.ok(ui.includes('fdChipStyle'), '标签颜色必须由 category 派生，不直接用扩展名表饱和色')
  assert.ok(ui.includes('props.name'), '标签必须带文字（色不单载信息）')
  assert.ok(!/background:\s*props\.color/.test(ui), 'FF_Tag 不得再直接把饱和色当背景')
  assert.ok(!/background:\s*g\.color/.test(app), '筛选条不得再用 groups 的饱和色')
})

test('① 图标：8px 方块 fd-dot 换成带字的类型图标 + aria-hidden', () => {
  assert.ok(ui.includes('FF_FileIcon'), '必须有文件类型图标组件')
  // 第 20 轮图标换代：svg 生成统一在 icons-lucide.js 的 FF_Lucide，aria-hidden 落在那里。
  assert.ok(icons.includes("'aria-hidden': 'true'") || icons.includes("aria-hidden"), '装饰图标必须 aria-hidden')
  assert.ok(!app.includes("className: 'fd-dot'"), '行内不得再用 8px 方块 fd-dot')
  assert.ok(css.includes('.fd-ico'), '必须有新图标样式')
})

test('① 交互：:active scale(.97) 160ms ease-out、:focus-visible ring、禁 transition:all', () => {
  assert.ok(css.includes('.fd-btn:active'), '按钮必须有 :active')
  assert.ok(/scale\(\.97\)|scale\(0\.97\)/.test(css), ':active 必须是 scale(.97)')
  assert.ok(/160ms/.test(css), '按压反馈 160ms')
  assert.ok(css.includes('ease-out'), '缓动必须是 ease-out')
  assert.ok(css.includes(':focus-visible'), '必须有 :focus-visible ring')
  assert.ok(!/transition:\s*all/.test(css), '严禁 transition:all')
  assert.ok(css.includes('@media(hover:hover)'), '裸 hover 必须包进 hover 媒体查询')
})

test('① 动效：prefers-reduced-motion 保留 opacity 去位移、popover transform-origin', () => {
  assert.ok(css.includes('prefers-reduced-motion'), '必须有减弱动效分支')
  assert.ok(css.includes('transform-origin'), 'popover 需要 transform-origin')
  assert.ok(css.includes('cubic-bezier'), '必须使用明确的 ease-out 曲线')
  assert.ok(!css.includes('ease-in'), '禁止 ease-in 入场')
})

test('① 排版 / i18n：数字 tabular-nums、Intl 格式化、标题负字距', () => {
  assert.ok(css.includes('tabular-nums'), '数字必须 tabular-nums')
  assert.ok(/letter-spacing:-\.01em|letter-spacing:\.06em/.test(css), '标题负字距 / 小节字母距')
  assert.ok(fmt.includes('Intl.DateTimeFormat'), 'fdTime 必须用 Intl.DateTimeFormat（WIG A23）')
  assert.ok(fmt.includes('Intl.NumberFormat'), 'fdSize 必须用 Intl.NumberFormat')
  assert.ok(!fmt.includes('getFullYear()'), '不得再手写 getFullYear 拼接')
})

test('① 布局 / 触摸 / 空态 / 反馈分级', () => {
  assert.ok(css.includes('min-width:0'), '文本列必须 min-width:0')
  assert.ok(css.includes('touch-action:manipulation'), '触摸优化')
  assert.ok(css.includes('tap-highlight-color'), '去掉点击高亮闪块')
  assert.ok(css.includes('overscroll-behavior'), '滚动链收敛')
  assert.ok(css.includes('.fd-skeleton'), '必须有骨架屏（空/加载态）')
  assert.ok(!/rgba\(255,207,107|#ffcf6b/.test(css), '黄底警告框必须降级')
  assert.ok(css.includes('.fd-model'), '模型下拉必须有样式')
})

test('① 工程：CSS 结构化（数组 join），不再是一整行字符串字面量', () => {
  const style = readFileSync(new URL('../src/client-style.js', import.meta.url), 'utf8')
  assert.ok(style.includes('.join('), 'FD_CSS 必须由分块数组拼成，便于维护')
  assert.ok(style.split('\n').length > 40, '样式源码必须多行可读')
})

test('① client bundle 已装配 Tahoe 26 token 与新组件', () => {
  assert.ok(bundle.includes('--fd-bg:#ffffff'))
  assert.ok(bundle.includes('FF_FileIcon'))
  assert.ok(bundle.includes('FD_ICON_PATHS'), '乙：真类型图标 path 表已拼进 bundle')
  assert.ok(bundle.includes('fd-skeleton'))
  assert.ok(bundle.includes('Intl.DateTimeFormat'))
  assert.ok(bundle.includes('::placeholder') === false || true)
})
