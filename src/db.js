// FlowFile 数据层：node:sqlite 的 DatabaseSync 封装。
// 库路径默认 ~/.flowfile/index.db；可用 FLOWFILE_DB 环境变量覆盖（测试用临时目录）。
// 本文件只做 SQLite 读写，不碰业务文件 fs；业务文件的写操作全部在 ops.js。
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS files (' +
    ' path TEXT PRIMARY KEY, real_path TEXT NOT NULL, root TEXT NOT NULL,' +
    ' name TEXT NOT NULL, ext TEXT, size INTEGER NOT NULL, mtime_ns TEXT NOT NULL,' +
    ' ctime_ns TEXT, kind TEXT, is_dir INTEGER NOT NULL DEFAULT 0,' +
    ' hash_partial TEXT, hash_full TEXT, hash_state TEXT, phash TEXT, text_fp TEXT,' +
    ' where_from TEXT, content_type TEXT, last_used TEXT, indexed_at INTEGER NOT NULL,' +
    ' missing INTEGER NOT NULL DEFAULT 0 )',
  'CREATE INDEX IF NOT EXISTS idx_files_size ON files(size, hash_partial)',
  'CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash_full)',
  'CREATE INDEX IF NOT EXISTS idx_files_phash ON files(phash)',
  'CREATE INDEX IF NOT EXISTS idx_files_root ON files(root, is_dir)',
  'CREATE TABLE IF NOT EXISTS events (' +
    ' id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, kind TEXT NOT NULL,' +
    ' from_path TEXT, to_path TEXT, size INTEGER, mtime_ns TEXT, hash_full TEXT,' +
    ' detail TEXT, at INTEGER NOT NULL )',
  'CREATE INDEX IF NOT EXISTS idx_events_path ON events(path, at)',
  'CREATE INDEX IF NOT EXISTS idx_events_at ON events(at)',
  'CREATE TABLE IF NOT EXISTS tags (' +
    ' id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, color TEXT,' +
    ' source TEXT NOT NULL, sort_order INTEGER DEFAULT 0 )',
  'CREATE TABLE IF NOT EXISTS file_tags (' +
    ' path TEXT NOT NULL, tag_id INTEGER NOT NULL, source TEXT NOT NULL,' +
    ' synced_at INTEGER NOT NULL, PRIMARY KEY (path, tag_id) )',
  'CREATE TABLE IF NOT EXISTS ops_batches (' +
    ' id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, status TEXT NOT NULL,' +
    ' plan_json TEXT NOT NULL, approved_json TEXT, dry_run_json TEXT,' +
    ' actor TEXT NOT NULL DEFAULT \'user\', note TEXT )',
  'CREATE TABLE IF NOT EXISTS ops_items (' +
    ' id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL, seq INTEGER NOT NULL,' +
    ' op TEXT NOT NULL, src TEXT, dst TEXT, before_hash TEXT, before_size INTEGER,' +
    ' after_hash TEXT, trash_path TEXT, restore_cmd TEXT, status TEXT NOT NULL,' +
    ' error TEXT, at INTEGER )',
  'CREATE INDEX IF NOT EXISTS idx_ops_items_batch ON ops_items(batch_id, seq)',
  'CREATE TABLE IF NOT EXISTS chat_messages (' +
    ' id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT, role TEXT NOT NULL,' +
    ' kind TEXT NOT NULL DEFAULT \'text\', content TEXT NOT NULL, payload TEXT,' +
    ' at INTEGER NOT NULL )',
  'CREATE INDEX IF NOT EXISTS idx_chat_at ON chat_messages(at)',
  // 第 17 轮（m07721 ③）：智能识别结果缓存。key = sha256(path|size|mtime|mode) 前 32 位。
  // 存卡片 + 派生标签的 JSON；命中就不再调模型（本地/云端都省，也避免重复上传）。
  'CREATE TABLE IF NOT EXISTS recognize_cache (' +
    ' cache_key TEXT PRIMARY KEY, path TEXT NOT NULL, mode TEXT NOT NULL,' +
    ' size INTEGER, mtime TEXT, card_json TEXT NOT NULL, tags_json TEXT,' +
    ' at INTEGER NOT NULL )',
  'CREATE INDEX IF NOT EXISTS idx_reco_path ON recognize_cache(path)',
  'CREATE TABLE IF NOT EXISTS scans (' +
    ' id TEXT PRIMARY KEY, root TEXT NOT NULL, state TEXT NOT NULL,' +
    ' done INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,' +
    ' current TEXT, started_at INTEGER, finished_at INTEGER, error TEXT )'
]

export function defaultDbPath() { return join(homedir(), '.flowfile', 'index.db') }

export function openDb(dbPath) {
  const p = dbPath || process.env.FLOWFILE_DB || defaultDbPath()
  const dir = dirname(p)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(p)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA busy_timeout=5000')
  for (const ddl of SCHEMA) db.exec(ddl)
  return db
}

// ---- files 快照 ----
export function upsertFile(db, f) {
  db.prepare('INSERT INTO files (path,real_path,root,name,ext,size,mtime_ns,ctime_ns,kind,is_dir,hash_partial,hash_full,hash_state,phash,text_fp,where_from,content_type,last_used,indexed_at,missing)' +
    ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)' +
    ' ON CONFLICT(path) DO UPDATE SET real_path=excluded.real_path,root=excluded.root,name=excluded.name,' +
    ' ext=excluded.ext,size=excluded.size,mtime_ns=excluded.mtime_ns,ctime_ns=excluded.ctime_ns,' +
    ' kind=excluded.kind,is_dir=excluded.is_dir,hash_partial=excluded.hash_partial,' +
    ' hash_full=excluded.hash_full,hash_state=excluded.hash_state,phash=excluded.phash,' +
    ' text_fp=excluded.text_fp,where_from=excluded.where_from,content_type=excluded.content_type,' +
    ' last_used=excluded.last_used,indexed_at=excluded.indexed_at,missing=0')
    .run(f.path, f.real_path, f.root, f.name, f.ext ?? null, Number(f.size), String(f.mtime_ns),
      f.ctime_ns ? String(f.ctime_ns) : null, f.kind ?? null, f.is_dir ? 1 : 0,
      f.hash_partial ?? null, f.hash_full ?? null, f.hash_state ?? null, f.phash ?? null,
      f.text_fp ?? null, f.where_from ?? null, f.content_type ?? null, f.last_used ?? null,
      Math.floor(Date.now() / 1000))
}

export function getFile(db, path) { return db.prepare('SELECT * FROM files WHERE path=?').get(path) || null }
export function allFiles(db, root) {
  if (root) return db.prepare('SELECT * FROM files WHERE root=? AND missing=0').all(root)
  return db.prepare('SELECT * FROM files WHERE missing=0').all()
}
export function markMissingExcept(db, root, seenPaths) {
  const rows = db.prepare('SELECT path FROM files WHERE root=? AND missing=0').all(root)
  let changed = 0
  const upd = db.prepare('UPDATE files SET missing=1 WHERE path=?')
  for (const r of rows) if (!seenPaths.has(r.path)) { upd.run(r.path); changed += 1 }
  return changed
}

// ---- events ----
export function addEvent(db, e) {
  db.prepare('INSERT INTO events (path,kind,from_path,to_path,size,mtime_ns,hash_full,detail,at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(e.path, e.kind, e.from_path ?? null, e.to_path ?? null, e.size ?? null,
      e.mtime_ns ?? null, e.hash_full ?? null, e.detail ?? null, e.at ?? Math.floor(Date.now() / 1000))
}
export function timelineFor(db, path, limit = 50) {
  return db.prepare('SELECT * FROM events WHERE path=? OR from_path=? OR to_path=? ORDER BY at DESC, id DESC LIMIT ?')
    .all(path, path, path, limit)
}
export function recentEvents(db, limit = 100) {
  // llm_diag 是 src/llm.js 的模型调用诊断事件，只供排障，不进用户可见的变更时间线。
  return db.prepare("SELECT * FROM events WHERE kind != 'llm_diag' ORDER BY at DESC, id DESC LIMIT ?").all(limit)
}

// ---- tags ----
export function tagsFor(db, path) {
  return db.prepare('SELECT t.name,t.color,t.source FROM file_tags ft JOIN tags t ON t.id=ft.tag_id WHERE ft.path=? ORDER BY t.sort_order,t.name').all(path)
}
export function setTags(db, path, names, source = 'user') {
  const ins = db.prepare('INSERT OR IGNORE INTO tags (name,color,source,sort_order) VALUES (?,?,?,0)')
  const getId = db.prepare('SELECT id FROM tags WHERE name=?')
  const link = db.prepare('INSERT OR IGNORE INTO file_tags (path,tag_id,source,synced_at) VALUES (?,?,?,?)')
  const del = db.prepare('DELETE FROM file_tags WHERE path=? AND source=?')
  const now = Math.floor(Date.now() / 1000)
  db.exec('BEGIN')
  try {
    del.run(path, source)
    for (const n of names) {
      const name = String(n).trim().slice(0, 40)
      if (!name) continue
      ins.run(name, null, source)
      const row = getId.get(name)
      if (row) link.run(path, row.id, source, now)
    }
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
}
export function allTags(db) { return db.prepare('SELECT * FROM tags ORDER BY sort_order,name').all() }

// ---- ops ----
export function createBatch(db, id, planJson) {
  db.prepare('INSERT INTO ops_batches (id,created_at,status,plan_json) VALUES (?,?,?,?)')
    .run(id, Math.floor(Date.now() / 1000), 'planned', JSON.stringify(planJson))
  return getBatch(db, id)
}
export function getBatch(db, id) { return db.prepare('SELECT * FROM ops_batches WHERE id=?').get(id) || null }
export function setBatchStatus(db, id, status, patch) {
  const b = getBatch(db, id)
  if (!b) return null
  db.prepare('UPDATE ops_batches SET status=?, approved_json=COALESCE(?,approved_json), dry_run_json=COALESCE(?,dry_run_json), note=COALESCE(?,note) WHERE id=?')
    .run(status, patch && patch.approved_json !== undefined ? JSON.stringify(patch.approved_json) : null,
      patch && patch.dry_run_json !== undefined ? JSON.stringify(patch.dry_run_json) : null,
      patch && patch.note !== undefined ? patch.note : null, id)
  return getBatch(db, id)
}
export function listBatches(db, limit = 30) { return db.prepare('SELECT * FROM ops_batches ORDER BY created_at DESC LIMIT ?').all(limit) }
export function addOpItem(db, item) {
  const r = db.prepare('INSERT INTO ops_items (batch_id,seq,op,src,dst,before_hash,before_size,after_hash,trash_path,restore_cmd,status,error,at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(item.batch_id, item.seq, item.op, item.src ?? null, item.dst ?? null, item.before_hash ?? null,
      item.before_size ?? null, item.after_hash ?? null, item.trash_path ?? null, item.restore_cmd ?? null,
      item.status, item.error ?? null, item.at ?? Math.floor(Date.now() / 1000))
  return Number(r.lastInsertRowid)
}
export function updateOpItem(db, id, patch) {
  const cur = db.prepare('SELECT * FROM ops_items WHERE id=?').get(id)
  if (!cur) return null
  const fields = ['status', 'error', 'before_hash', 'before_size', 'after_hash', 'trash_path', 'restore_cmd', 'dst']
  const sets = [], vals = []
  for (const f of fields) if (patch[f] !== undefined) { sets.push(f + '=?'); vals.push(patch[f]) }
  if (!sets.length) return cur
  vals.push(id)
  db.prepare('UPDATE ops_items SET ' + sets.join(',') + ' WHERE id=?').run(...vals)
  return db.prepare('SELECT * FROM ops_items WHERE id=?').get(id)
}
export function itemsForBatch(db, batchId) { return db.prepare('SELECT * FROM ops_items WHERE batch_id=? ORDER BY seq').all(batchId) }

// ---- chat ----
export function addChat(db, role, kind, content, payload, batchId) {
  const r = db.prepare('INSERT INTO chat_messages (batch_id,role,kind,content,payload,at) VALUES (?,?,?,?,?,?)')
    .run(batchId ?? null, role, kind, content, payload ? JSON.stringify(payload) : null, Math.floor(Date.now() / 1000))
  return Number(r.lastInsertRowid)
}
export function chatHistory(db, limit = 100) {
  // 取「最新 N 条」再按时间正序返回给 UI：直接 ASC+LIMIT 会在消息数超过 limit 时
  // 丢掉最新消息（返回最旧 N 条），历史计划卡片会随之消失。
  return db.prepare('SELECT * FROM (SELECT * FROM chat_messages ORDER BY at DESC, id DESC LIMIT ?) ORDER BY at ASC, id ASC')
    .all(limit).map(m => ({ ...m, payload: m.payload ? JSON.parse(m.payload) : null }))
}
export function updateChatPayload(db, id, payload) {
  db.prepare('UPDATE chat_messages SET payload=? WHERE id=?').run(payload ? JSON.stringify(payload) : null, id)
}

// ---- scans ----
export function createScan(db, id, root) {
  db.prepare('INSERT INTO scans (id,root,state,done,total,started_at) VALUES (?,?,?,0,0,?)')
    .run(id, root, 'queued', Math.floor(Date.now() / 1000))
}
export function setScan(db, id, patch) {
  const fields = ['state', 'done', 'total', 'current', 'finished_at', 'error']
  const sets = [], vals = []
  for (const f of fields) if (patch[f] !== undefined) { sets.push(f + '=?'); vals.push(patch[f]) }
  if (!sets.length) return
  vals.push(id)
  db.prepare('UPDATE scans SET ' + sets.join(',') + ' WHERE id=?').run(...vals)
}
export function getScan(db, id) { return db.prepare('SELECT * FROM scans WHERE id=?').get(id) || null }

// ---- 第 17 轮（m07721 ③）：识别结果缓存 ----
export function getRecognizeCache(db, key) {
  const row = db.prepare('SELECT * FROM recognize_cache WHERE cache_key=?').get(String(key || ''))
  if (!row) return null
  let card = null, tags = []
  try { card = JSON.parse(row.card_json) } catch (e) { card = null }
  try { tags = JSON.parse(row.tags_json || '[]') } catch (e) { tags = [] }
  return { key: row.cache_key, path: row.path, mode: row.mode, size: row.size, mtime: row.mtime, card, tags, at: row.at }
}

export function putRecognizeCache(db, item) {
  const it = item || {}
  if (!it.key || !it.path) return null
  db.prepare('INSERT OR REPLACE INTO recognize_cache (cache_key,path,mode,size,mtime,card_json,tags_json,at) VALUES (?,?,?,?,?,?,?,?)')
    .run(String(it.key), String(it.path), String(it.mode || 'off'), Number(it.size || 0), String(it.mtime || ''),
      JSON.stringify(it.card || {}), JSON.stringify(it.tags || []), Number(it.at || Math.floor(Date.now() / 1000)))
  return it.key
}

export function pruneRecognizeCache(db, days) {
  const d = Number(days)
  if (!Number.isFinite(d) || d <= 0) return 0
  const cut = Math.floor(Date.now() / 1000) - d * 86400
  const r = db.prepare('DELETE FROM recognize_cache WHERE at < ?').run(cut)
  return Number(r && r.changes ? r.changes : 0)
}
