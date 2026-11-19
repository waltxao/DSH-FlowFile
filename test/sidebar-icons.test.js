import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const src = readFileSync(new URL('../src/client-ui.js', import.meta.url), 'utf8')
const icons = readFileSync(new URL('../src/icons-lucide.js', import.meta.url), 'utf8')
const browse = readFileSync(new URL('../src/client-browse.js', import.meta.url), 'utf8')

// 第 20 轮图标换代（m10238）：图标数据从 FD_ICON_PATHS 迁到 Lucide 表 FD_LUCIDE_FILE。
test('FD_LUCIDE_FILE 含侧栏三键 star/disk/cloud', () => {
  const m = icons.match(/var FD_LUCIDE_FILE = \{[\s\S]*?\n\}/)
  assert.ok(m, 'FD_LUCIDE_FILE block found')
  for (const k of ['star:', 'disk:', 'cloud:']) assert.ok(m[0].includes(k), 'missing ' + k)
})

test('FF_Sidebar 函数体不再用字符占位图标（★ ▣ ☁）', () => {
  const sb = browse.slice(browse.indexOf('function FF_Sidebar'), browse.indexOf('function FF_QuickLook'))
  assert.ok(!sb.includes("'★'"), 'star char remains')
  assert.ok(!sb.includes("'▣'"), 'disk char remains')
  assert.ok(!sb.includes("'☁'"), 'cloud char remains')
})

test('FF_Sidebar 三处用 FF_SideIco svg 组件', () => {
  const n = (browse.match(/FF_SideIco/g) || []).length
  assert.ok(n >= 3, 'FF_SideIco uses: ' + n)
})

// 三键必须是 Lucide 官方数据形态（[tag, attrs] 数组），不是单字符串 path
test('FD_LUCIDE_FILE 三键为官方节点形态', () => {
  const m = icons.match(/var FD_LUCIDE_FILE = \{[\s\S]*?\n\}/)
  const seg = m[0]
  for (const k of ['star:', 'disk:', 'cloud:']) {
    const i = seg.indexOf(k)
    assert.ok(i > 0, 'missing key ' + k)
    const line = seg.slice(i, seg.indexOf('\n', i))
    assert.ok(line.includes('["path"') || line.includes('["rect"') || line.includes('["circle"'), 'key ' + k + ' 不是官方节点数组')
  }
})