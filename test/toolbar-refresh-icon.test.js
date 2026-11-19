import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const ui = readFileSync(new URL('../src/client-ui.js', import.meta.url), 'utf8')
const icons = readFileSync(new URL('../src/icons-lucide.js', import.meta.url), 'utf8')
const browse = readFileSync(new URL('../src/client-browse.js', import.meta.url), 'utf8')

// 第 20 轮图标换代（m10238）：refresh 的官方 path 移到 icons-lucide.js 的 FD_LUCIDE_UI。
test('FF_RefreshIco 走 Lucide 官方 refresh-cw 数据（开源图标库）', () => {
  const m = ui.match(/function FF_RefreshIco[\s\S]*?\n\}/)
  assert.ok(m, 'FF_RefreshIco missing')
  assert.ok(m[0].includes('FD_LUCIDE_UI.refresh'), 'FF_RefreshIco 应引用 Lucide refresh')
  assert.ok(icons.includes('lucide.dev'), 'missing lucide attribution comment')
  assert.ok(icons.includes('M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8'), 'missing refresh-cw path A')
  assert.ok(icons.includes('M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16'), 'missing refresh-cw path B')
})

test('文件区工具栏刷新按钮换用 FF_RefreshIco，保留 title 与 aria-label', () => {
  const m = browse.match(/key: 'refresh'[^\n]*/)
  assert.ok(m, 'refresh button missing in FF_NavBar')
  assert.ok(m[0].includes('FF_RefreshIco'), 'refresh button not using FF_RefreshIco')
  assert.ok(m[0].includes("'aria-label': '刷新'"), 'missing aria-label')
})

test('旧文本「刷新」不再作为按钮正文出现于 FF_NavBar 刷新键', () => {
  const m = browse.match(/key: 'refresh'[^\n]*/)
  assert.ok(m && !/>', *'刷新'\)/.test(m[0]), 'text 刷新 still present as button body')
})
