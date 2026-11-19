import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const app = readFileSync(new URL('../src/client-app.js', import.meta.url), 'utf8')
const browse = readFileSync(new URL('../src/client-browse.js', import.meta.url), 'utf8')
const core = readFileSync(new URL('../src/browse-core.js', import.meta.url), 'utf8')
const style = readFileSync(new URL('../src/client-style.js', import.meta.url), 'utf8')

test('① 布局：fd-body 三段 = fd-rail + fd-center + fd-right', () => {
  assert.ok(style.includes('.fd-right'), 'missing .fd-right')
  assert.ok(style.includes('.fd-tree'), 'missing .fd-tree (左目录树)')
  assert.ok(style.includes('.fd-tabbar'), 'missing .fd-tabbar (多标签条)')
})

test('② 右键菜单：menuFor 有 find-dup / find-sim（对目标生效）', () => {
  assert.ok(core.includes("push('findDup'") || core.includes("'findDup'"), 'missing findDup')
  assert.ok(core.includes("'findSim'"), 'missing findSim')
})

test('③ 旧底部对话抽屉与能力 tab 条移除', () => {
  assert.ok(!app.includes('fd-chat-h'), 'fd-chat-h remains')
  assert.ok(!app.includes('FF_NavTabs'), 'FF_NavTabs remains')
  assert.ok(!app.includes('fd-drawer'), 'fd-drawer remains')
})

// 第 20 轮（m09643）：对话迁到灵动底坞 + AI 抽屉；原意「对话有独立容器、形态由设计稿定」保留。
test('④ AI 对话有独立容器（灵动底坞 + 抽屉），不再散落在面板里', () => {
  assert.ok(style.includes('.fd-dock') || style.includes('.fd-root .dock'), 'missing .dock')
  assert.ok(app.includes('FF_TDrawer'), 'app not using FF_TDrawer')
})

test('⑤ 多标签 tab 栈：tabs 状态机存在于 FD_App', () => {
  assert.ok(app.includes('tabStack') || app.includes('fdTabs'), 'no tab stack state')
  assert.ok(app.includes('closeTab') || app.includes('openTab'), 'no tab open/close')
})

test('⑥ 清理保留为独立功能入口', () => {
  assert.ok(app.includes('loadClean'), 'loadClean removed')
})