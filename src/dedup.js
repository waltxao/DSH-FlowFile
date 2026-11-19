// 文件查重：三级淘汰（size 分桶 → partial hash → full hash），结果按 size 降序。
// 纯函数：输入 files 行，输出重复组；绝不自动删除。
import { partialHashSync, fullHashSync } from './hash.js'

export function bucketBySize(items) {
  const m = new Map()
  for (const f of items) {
    if (f.is_dir || f.missing) continue
    const k = String(f.size)
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(f)
  }
  return [...m.entries()].filter(([k, arr]) => arr.length > 1).map(([k, arr]) => ({ size: Number(k), items: arr }))
}

/** 第三级：对同 size + 同 partial 的候选做全量 hash，只留 count>1 的组。 */
export function finalizeGroups(candidates, opts) {
  const o = opts || {}
  const readPartial = o.partialFn || ((f) => partialHashSync(f.path, Number(f.size)))
  const readFull = o.fullFn || ((f) => fullHashSync(f.path, Number(f.size)))
  const groups = []
  for (const b of candidates) {
    const byPartial = new Map()
    for (const f of b.items) {
      let ph = f.hash_partial
      let state = f.hash_state
      if (!ph || (state !== 'full' && state !== 'partial')) {
        try { const r = readPartial(f); ph = r.hash; state = r.state } catch (e) { continue }
      }
      const k = (state === 'full' ? 'F:' : 'P:') + ph
      if (!byPartial.has(k)) byPartial.set(k, [])
      byPartial.get(k).push({ f, ph, state })
    }
    for (const arr of byPartial.values()) {
      if (arr.length < 2) continue
      const byFull = new Map()
      for (const x of arr) {
        let hf = x.state === 'full' ? x.ph : (x.f.hash_full || null)
        let st = x.state === 'full' ? 'full' : (x.f.hash_state === 'full' && x.f.hash_full ? 'full' : null)
        if (!hf || st !== 'full') {
          try { const r = readFull(x.f); hf = r.hash; st = r.state } catch (e) { hf = null; st = 'error' }
        }
        if (!hf) continue
        if (!byFull.has(hf)) byFull.set(hf, [])
        byFull.get(hf).push({ f: x.f, hash_full: hf, state: st })
      }
      for (const [hash, members] of byFull) {
        if (members.length < 2) continue
        groups.push({ hash, size: b.size, state: members.some(m => m.state !== 'full') ? 'partial_only' : 'full', items: members.map(m => m.f) })
      }
    }
  }
  groups.sort((a, b) => b.size - a.size || b.items.length - a.items.length)
  return groups
}

/** 从数据库读 files 行 → 重复组（带保留建议文案，只是文案不执行）。 */
export function duplicatesFromDb(db, root, opts) {
  const rows = root
    ? db.prepare('SELECT * FROM files WHERE root=? AND missing=0 AND is_dir=0').all(root)
    : db.prepare('SELECT * FROM files WHERE missing=0 AND is_dir=0').all()
  const buckets = bucketBySize(rows)
  const groups = finalizeGroups(buckets, opts)
  return groups.map(g => ({ ...g, keepSuggestion: keepSuggestion(g.items) }))
}

export function keepSuggestion(items) {
  const sorted = [...items].sort((a, b) => {
    const am = String(a.mtime_ns || a.mtime || '')
    const bm = String(b.mtime_ns || b.mtime || '')
    if (am !== bm) return am < bm ? -1 : 1
    if (a.path.length !== b.path.length) return a.path.length - b.path.length
    const asmb = String(a.path).startsWith('/Volumes/') ? 1 : 0
    const bsmb = String(b.path).startsWith('/Volumes/') ? 1 : 0
    return asmb - bsmb
  })
  return { keep: sorted[0]?.path || null, reason: '优先保留最早修改、路径最短、非 SMB 卷的一份（仅建议，不自动执行）' }
}

// SQL 版（索引库已有 hash_full 时走它，避免重复读文件）
export function duplicatesBySql(db, root) {
  const sql = 'SELECT * FROM files WHERE is_dir=0 AND missing=0 AND hash_state="full"' +
    (root ? ' AND root=?' : '') + ' GROUP BY size, hash_full HAVING COUNT(*) > 1'
  const rows = root ? db.prepare(sql).all(root) : db.prepare(sql).all()
  return rows.map(r => ({ hash: r.hash_full, size: r.size, items: [r], state: 'full' }))
}
