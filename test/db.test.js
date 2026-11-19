import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, upsertFile, getFile, allFiles, markMissingExcept, addEvent, timelineFor, recentEvents,
  tagsFor, setTags, createBatch, getBatch, setBatchStatus, addOpItem, updateOpItem, itemsForBatch,
  addChat, chatHistory, updateChatPayload, createScan, setScan, getScan } from '../src/db.js'

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ff-db-'))
  return { dir, db: openDb(join(dir, 'index.db')) }
}

test('db：全部表建成、files 增量 upsert 与 missing 标记', () => {
  const { dir, db } = tmpDb()
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
    for (const t of ['files', 'events', 'tags', 'file_tags', 'ops_batches', 'ops_items', 'chat_messages', 'scans']) assert.ok(tables.includes(t))
    const f = { path: '/tmp/a', real_path: '/tmp/a', root: '/tmp', name: 'a', ext: '', size: 10, mtime_ns: '1', is_dir: 0 }
    upsertFile(db, f)
    assert.equal(getFile(db, '/tmp/a').size, 10)
    upsertFile(db, { ...f, size: 20, mtime_ns: '2' })
    assert.equal(getFile(db, '/tmp/a').size, 20)
    assert.equal(getFile(db, '/tmp/a').mtime_ns, '2')
    const n = markMissingExcept(db, '/tmp', new Set(['/tmp/a']))
    assert.equal(n, 0)
    upsertFile(db, { ...f, path: '/tmp/b', name: 'b' })
    const n2 = markMissingExcept(db, '/tmp', new Set(['/tmp/a']))
    assert.equal(n2, 1)
    assert.equal(allFiles(db, '/tmp').length, 1)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('db：events / tags / ops / chat / scans 读写闭环', () => {
  const { dir, db } = tmpDb()
  try {
    addEvent(db, { path: '/tmp/a', kind: 'moved', from_path: '/tmp/x', to_path: '/tmp/a' })
    assert.equal(timelineFor(db, '/tmp/a').length, 1)
    assert.equal(timelineFor(db, '/tmp/x').length, 1)
    setTags(db, '/tmp/a', ['图片', '重要'], 'user')
    assert.deepEqual(tagsFor(db, '/tmp/a').map(t => t.name), ['图片', '重要'])
    setTags(db, '/tmp/a', ['归档'], 'user')
    assert.deepEqual(tagsFor(db, '/tmp/a').map(t => t.name), ['归档'])
    const b = createBatch(db, 'b1', { groups: [] })
    assert.equal(b.status, 'planned')
    const id = addOpItem(db, { batch_id: 'b1', seq: 1, op: 'move', src: '/tmp/a', status: 'planned' })
    updateOpItem(db, id, { status: 'done', after_hash: 'abc' })
    assert.equal(itemsForBatch(db, 'b1')[0].after_hash, 'abc')
    setBatchStatus(db, 'b1', 'done', { note: 'ok' })
    assert.equal(getBatch(db, 'b1').note, 'ok')
    const mid = addChat(db, 'assistant', 'plan', '计划', { kind: 'plan' }, null)
    updateChatPayload(db, mid, { kind: 'plan', batchId: 'b1' })
    assert.equal(chatHistory(db)[0].payload.batchId, 'b1')
    createScan(db, 's1', '/tmp')
    setScan(db, 's1', { state: 'running', done: 3, total: 10 })
    assert.equal(getScan(db, 's1').done, 3)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('db：llm_diag 诊断事件不进用户可见变更时间线', () => {
  const { dir, db } = tmpDb()
  try {
    addEvent(db, { path: '/tmp/a', kind: 'moved' })
    addEvent(db, { path: 'flowfile://llm/start', kind: 'llm_diag', detail: '{}' })
    addEvent(db, { path: 'flowfile://llm/done', kind: 'llm_diag', detail: '{}' })
    const recent = recentEvents(db, 50)
    assert.ok(recent.length >= 1)
    assert.ok(recent.every(e => e.kind !== 'llm_diag'), 'recentEvents 必须过滤掉 llm_diag')
    assert.equal(recent.filter(e => e.kind === 'moved').length, 1)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})
