import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, chatHistory, addChat } from '../src/db.js'
import { chatSystem, chatUser, getHistory } from '../src/chat.js'

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ff-chat-'))
  return { dir, db: openDb(join(dir, 'index.db')) }
}

test('chat：system 禁止编造路径与声称已执行', () => {
  const s = chatSystem()
  assert.ok(s.indexOf('禁止编造') > 0)
  assert.ok(s.indexOf('绝对不要执行任何操作') > 0)
})

test('chat：system 要求整理意图必须产出非空 groups 计划（GUI 计划卡片前置）', () => {
  const s = chatSystem()
  assert.ok(s.indexOf('intent 必须是 plan') > 0, '整理指令必须判为 plan')
  assert.ok(s.indexOf('groups 必须非空') > 0, '整理指令必须给出可勾选条目')
  assert.ok(s.indexOf('不要反问') > 0, '不得用「是否确认」代替计划')
  assert.ok(s.indexOf('"op":"move|rename|copy|tag|trash|none"') > 0, '必须给出 groups 字段 schema')
  assert.ok(s.indexOf('"dst"') > 0)
})

test('chat：chatUser 带当前目录与候选清单', () => {
  const u = chatUser('把 PDF 和图片分开', { path: '/tmp/x' }, [{ path: '/tmp/a.pdf', name: 'a.pdf', size: 10, tags: [{ name: '文档' }] }])
  assert.ok(u.indexOf('把 PDF 和图片分开') > 0)
  assert.ok(u.indexOf('/tmp/x') > 0)
  assert.ok(u.indexOf('/tmp/a.pdf') > 0)
})

test('chat：getHistory(limit) 超过上限时保留最新消息，按时间正序返回', () => {
  const { dir, db } = tmpDb()
  try {
    for (let i = 1; i <= 6; i++) addChat(db, i % 2 ? 'user' : 'assistant', 'text', 'msg-' + i, null, null)
    const h = getHistory(db, 3)
    assert.equal(h.length, 3)
    // 最新 3 条是 msg-4/5/6，且仍按正序返回
    assert.deepEqual(h.map(m => m.content), ['msg-4', 'msg-5', 'msg-6'])
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('chat：getHistory 读回已落库消息；刷新不丢', () => {
  const { dir, db } = tmpDb()
  try {
    // 直接经 db 层写两条（等价于 handleChat 落库），验证持久化
    addChat(db, 'user', 'text', '你好', null, null)
    addChat(db, 'assistant', 'text', '我在', null, null)
    const h = getHistory(db, 50)
    assert.equal(h.length, 2)
    assert.equal(h[0].content, '你好')
    assert.equal(h[1].content, '我在')
    assert.equal(chatHistory(db).length, 2)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})
