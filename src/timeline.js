// 变更时间线：当前快照与上一轮快照 diff → events（只记事件不存内容，Q3）。
import { addEvent, allFiles, upsertFile, markMissingExcept } from './db.js'

function ns(f) { return String(f.mtime_ns || f.mtime || '') }

/** 纯函数：给定旧快照与当前扫描条目，产出事件列表。 */
export function diffSnapshot(prev, current, at) {
  const now = at || Math.floor(Date.now() / 1000)
  const prevByPath = new Map(prev.map(f => [f.path, f]))
  const currByPath = new Map(current.map(f => [f.path, f]))
  const events = []
  const usedPrev = new Set()
  for (const c of current) {
    const p = prevByPath.get(c.path)
    if (!p) {
      const moved = prev.find(x => !usedPrev.has(x.path) && !currByPath.has(x.path) &&
        String(x.size) === String(c.size) && x.hash_full && x.hash_full === c.hash_full)
      if (moved) {
        usedPrev.add(moved.path)
        events.push({ path: c.path, kind: 'moved', from_path: moved.path, to_path: c.path, size: c.size, mtime_ns: c.mtime_ns, hash_full: c.hash_full, at: now })
      } else {
        events.push({ path: c.path, kind: 'created', size: c.size, mtime_ns: c.mtime_ns, hash_full: c.hash_full, at: now })
      }
    } else {
      usedPrev.add(c.path)
      if (ns(p) !== ns(c) || String(p.size) !== String(c.size)) {
        events.push({ path: c.path, kind: 'modified', size: c.size, mtime_ns: c.mtime_ns, hash_full: c.hash_full, at: now })
      } else {
        events.push({ path: c.path, kind: 'seen', size: c.size, mtime_ns: c.mtime_ns, hash_full: c.hash_full, at: now })
      }
    }
  }
  for (const p of prev) {
    if (!usedPrev.has(p.path) && !currByPath.has(p.path)) {
      events.push({ path: p.path, kind: 'deleted', size: p.size, mtime_ns: p.mtime_ns, hash_full: p.hash_full, at: now })
    }
  }
  return events
}

/** 把扫描结果落到 files 表，并把 diff（非 seen）写进 events。 */
export function commitSnapshot(db, root, current, opts) {
  const prev = allFiles(db, root)
  const events = diffSnapshot(prev, current, opts && opts.at)
  for (const f of current) upsertFile(db, f)
  const seen = new Set(current.map(f => f.path))
  markMissingExcept(db, root, seen)
  for (const e of events) if (e.kind !== 'seen') addEvent(db, e)
  return { total: current.length, events: events.filter(e => e.kind !== 'seen') }
}

export function recordOpEvent(db, e) { return addEvent(db, e) }
