// 第 20 轮图标换代（m10238）：FF_Icon 不再内联手绘 path，改调 Lucide 渲染器。
// 原意「用开源图标库、不留手绘笔误」保留，判据换成新分层（数据在 icons-lucide.js，组件在 client-ui.js）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const src = readFileSync(new URL('../src/client-ui.js', import.meta.url), 'utf8')
const icons = readFileSync(new URL('../src/icons-lucide.js', import.meta.url), 'utf8')

test('FF_Icon 走 Lucide 官方 folder 数据（开源图标库）', () => {
  const m = src.match(/function FF_Icon[\s\S]*?\n\}/)
  assert.ok(m, 'FF_Icon found')
  assert.ok(m[0].includes('FD_LUCIDE_FILE.folder'), 'FF_Icon 应引用 Lucide folder 数据')
  assert.ok(m[0].includes('FF_Lucide'), 'FF_Icon 应走统一 Lucide 渲染器')
  assert.ok(icons.includes('lucide.dev'), 'missing lucide attribution comment')
  assert.ok(icons.includes('M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9'), 'missing lucide folder path')
})

test('旧手画 path（含笔误 2-2-2H5）已彻底移除', () => {
  assert.equal(src.includes('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1 2-2H5'), false, 'old malformed path remains')
  assert.equal(icons.includes('M3 7a2 2 0 0 1 2-2h4l2 2h8'), false, 'old hand-drawn folder path remains in icons table')
})

test('FF_Icon 保持线性风格与 currentColor', () => {
  const m = src.match(/function FF_Icon[\s\S]*?\n\}/)
  const r = icons.match(/function FF_Lucide[\s\S]*?\n\}/)
  assert.ok(m && r, 'both found')
  assert.ok(r[0].includes('currentColor'), 'Lucide 渲染器默认 currentColor')
  assert.ok(r[0].includes('viewBox'), 'Lucide 渲染器带 viewBox')
  assert.ok(r[0].includes("strokeLinecap: 'round'"), '圆角端点')
})
