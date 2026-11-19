// 第 20 轮图标换代（m10238「图标能不能用开源图标集，现在自绘的太丑」）。
// 失败测试先行：断言源码内嵌 Lucide 官方节点数据（含出处与许可注释）、
// 且两套图标表都不再是手绘单-string path 数组。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const icons = readFileSync(new URL('../src/icons-lucide.js', import.meta.url), 'utf8')
const ui = readFileSync(new URL('../src/client-ui.js', import.meta.url), 'utf8')
const dist = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')

test('L① 内嵌 Lucide 官方数据并注明版本与许可', () => {
  assert.match(icons, /lucide-react v\d+\.\d+\.\d+/, '要写清 lucide-react 版本')
  assert.match(icons, /ISC License/, '要写明 ISC 许可')
  assert.match(icons, /lucide\.dev/, '要给出处链接')
  assert.ok(icons.includes('FD_LUCIDE_VERSION'), '版本要做成常量')
})

test('L② 官方 path 数据必须逐字节对得上（抽样比对真实 d 值）', () => {
  // folder：Lucide 官方 folder 的 d 以 "M20 20a2 2 0 0 0 2-2V8" 开头，手绘版是 "M3 7a2 2 0 0 1 2-2h4l2 2h8"
  assert.ok(icons.includes('M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9'), 'folder 应为 Lucide 官方 path')
  // search：官方是 "m21 21-4.34-4.34" + circle cx=11 cy=11 r=8
  assert.ok(icons.includes('m21 21-4.34-4.34'), 'search 应为 Lucide 官方 path')
  assert.ok(icons.includes('"cx":"11"') || icons.includes('cx: "11"'), 'search 的 circle 参数来自官方数据')
})

test('L③ 节点格式是 [tag, attrs]，支持 circle/rect 等非 path 元素', () => {
  assert.ok(icons.includes('["circle"') || icons.includes('["rect"'), '要保留官方原始元素类型，不能只留 path')
  assert.ok(icons.includes('function FF_Lucide'), '要有统一渲染器')
  assert.match(icons, /polyline|polygon|"line"/, '渲染器要覆盖 line/polyline/polygon')
})

test('L④ 两套旧手绘表退场，渲染统一走 Lucide', () => {
  assert.equal(ui.includes('var FD_ICON_PATHS'), false, '旧手绘 FD_ICON_PATHS 应移除')
  assert.equal(ui.includes('var FD_UI_PATHS'), false, '旧手绘 FD_UI_PATHS 应移除')
  assert.match(ui, /FD_LUCIDE_FILE|FD_LUCIDE_UI/, 'client-ui 要引用 Lucide 表')
  assert.match(ui, /FF_Lucide/, '图标组件要调 FF_Lucide')
})

test('L⑤ stroke 风格与 Tahoe 一致（1.8 线性、currentColor、圆角端点）', () => {
  assert.match(icons, /strokeWidth/, '要有 strokeWidth')
  assert.match(icons, /currentColor/, '颜色继承 currentColor')
  assert.match(icons, /strokeLinecap:\s*'round'/, '圆角端点')
})

test('L⑥ dist 已重建含 Lucide 数据', () => {
  assert.ok(dist.includes('FD_LUCIDE_FILE'), 'bundle 缺 Lucide 文件图标表')
  assert.ok(dist.includes('M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9'), 'bundle 缺官方 folder path')
  assert.equal(dist.includes('var FD_ICON_PATHS'), false, 'bundle 不应再有旧手绘表')
})
