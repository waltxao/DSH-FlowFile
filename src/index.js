// 扫描与索引：后台任务化、增量失效（size+mtime 未变跳过 hash）、可取消、可断点续跑。
// 只读业务文件；唯一写的是 SQLite（经由 db.js），不写任何业务文件。
//
// P1.6 真机复验修复（2026-11-13）：SMB 上同步 readdirSync/lstatSync/readSync/realpathSync
// 会连续冻结 Electron 主进程 —— 实测 92 文件同步遍历期间 setInterval 触发 0 次、POST scan
// 启动请求被挤后 17 秒、并发探针 63% 超时。这里全部改成 node:fs/promises，实测同目录
// 异步遍历期间 setInterval 触发 32 次、最大间隔 52ms。
import { readdir, lstat, realpath } from 'node:fs/promises'
import { join, extname, basename, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { partialHashAsync, fullHashAsync } from './hash.js'
import { collectSignals } from './meta.js'
import { classifyEntry } from './rules.js'
import { getFile, createScan, setScan, getScan } from './db.js'
import { commitSnapshot } from './timeline.js'

const MAX_ENTRIES = 2000          // 单目录列表上限
const MAX_TOTAL_FILES = 20000     // 一次扫描收集的文件总量上限（防大卷把内存/时间吃光）
const DENY_NAMES = new Set(['.credentials.yaml', 'id_rsa', 'id_ed25519', '.env'])

// 让出事件循环：DSH host 半片跑在 Electron 主进程，同步遍历/哈希会卡死整个 GUI。
function yieldNow() { return new Promise(r => setImmediate(r)) }

export class ScanManager {
  constructor(db, guard) {
    this.db = db
    this.guard = guard
    this.active = new Map()  // id -> { aborted, root, current }
  }

  /** 启动一次后台扫描，立即返回 scanId。重复 root 且已在跑 → 409。 */
  start(root, options) {
    const abs = this.guard.assertAllowed(root)
    for (const [id, s] of this.active) if (!s.aborted && s.root === abs) {
      throw Object.assign(new Error('该目录已有扫描在跑'), { status: 409 })
    }
    const id = 'scan-' + randomUUID()
    const opts = options || {}
    createScan(this.db, id, abs)
    const state = { aborted: false, root: abs, current: '' }
    this.active.set(id, state)
    // 关键：用 setImmediate 把 _run 的第一个同步段从「本次 HTTP 请求」里解耦出去，
    // 否则 start() 内 await 之前的同步代码会拖住 POST /scan 的响应。
    setImmediate(() => {
      this._run(id, abs, opts, state).catch(e => {
        try { setScan(this.db, id, { state: 'failed', error: String(e.message || e), finished_at: Math.floor(Date.now() / 1000) }) } catch (_) {}
      })
    })
    return id
  }

  cancel(id) {
    const s = this.active.get(id)
    if (!s) return false
    s.aborted = true
    setScan(this.db, id, { state: 'cancelled', finished_at: Math.floor(Date.now() / 1000) })
    return true
  }

  status(id) {
    const row = getScan(this.db, id)
    if (!row) return null
    const live = this.active.get(id)
    return { id, root: row.root, state: row.state, done: row.done, total: row.total,
      current: row.current || (live ? live.current : ''), startedAt: row.started_at,
      finishedAt: row.finished_at, error: row.error, cancelable: live && !live.aborted }
  }

  // 全异步遍历：readdir / lstat 走 libuv 线程池，每目录末尾让出一次事件循环。
  async _walk(root, onFile, state) {
    const stack = [root]
    let truncated = false
    let total = 0
    let dirCount = 0
    while (stack.length) {
      if (state.aborted) return { truncated: true, total }
      const dir = stack.pop()
      state.current = dir
      let names
      try { names = await readdir(dir, { withFileTypes: true }) } catch (e) { continue }
      let n = 0
      for (const d of names) {
        if (n >= MAX_ENTRIES) { truncated = true; break }
        n += 1
        const name = d.name
        if (name.charAt(0) === '.' || DENY_NAMES.has(name)) continue
        const p = join(dir, name)
        if (!this.guard.isAllowed(p)) continue
        let st
        try { st = await lstat(p) } catch (e) { continue }
        if (st.isSymbolicLink()) continue  // 不跟随软链
        if (st.isDirectory()) stack.push(p)
        else if (st.isFile()) {
          if (total >= MAX_TOTAL_FILES) { truncated = true; break }
          onFile(p, st); total += 1
        }
      }
      dirCount += 1
      if (dirCount % 5 === 0) await yieldNow()   // 让出事件循环
      else await yieldNow()                      // 每目录都让出，SMB 元数据也要喘气
      if (total >= MAX_TOTAL_FILES) break
    }
    return { truncated, total }
  }

  async _run(id, root, opts, state) {
    try {
      setScan(this.db, id, { state: 'running', started_at: Math.floor(Date.now() / 1000) })
      const current = []
      let done = 0
      let truncated = false
      const metaOpts = opts && opts.meta !== false
      const walk = await this._walk(root, (p, st) => { current.push({ p, st }) }, state)
      truncated = walk.truncated
      if (state.aborted) { setScan(this.db, id, { state: 'cancelled', done, finished_at: Math.floor(Date.now() / 1000) }); return }
      setScan(this.db, id, { total: current.length })
      const batch = []
      for (const { p, st } of current) {
        if (state.aborted) break
        state.current = p
        const size = Number(st.size)
        const mtimeNs = String(st.mtimeNs || BigInt(Math.floor(st.mtimeMs || st.mtime.getTime()) * 1e6))
        const prev = getFile(this.db, p)
        const unchanged = prev && String(prev.size) === String(size) && String(prev.mtime_ns) === mtimeNs
        let hash_partial = prev ? prev.hash_partial : null
        let hash_full = prev ? prev.hash_full : null
        let hash_state = prev ? prev.hash_state : null
        let phash = prev ? prev.phash : null
        let text_fp = prev ? prev.text_fp : null
        let where_from = prev ? prev.where_from : null
        let content_type = prev ? prev.content_type : null
        let last_used = prev ? prev.last_used : null
        if (!unchanged) {
          try {
            const ph = await partialHashAsync(p, size)
            hash_partial = ph.hash
            if (ph.state === 'full') { hash_full = ph.hash; hash_state = 'full' }
            else { hash_state = 'partial'; hash_full = null }
          } catch (e) { hash_state = 'error' }
        }
        // 只在 full 态缺失且非超大文件时补 full hash（查重需要）
        if (hash_state !== 'full' && hash_state !== 'skipped_large' && size <= 2 * 1024 * 1024 * 1024) {
          try { const fh = await fullHashAsync(p, size, () => state.aborted); if (fh.state === 'cancelled') return; if (fh.hash) { hash_full = fh.hash; hash_state = 'full' } else hash_state = fh.state }
          catch (e) { /* 保留 partial */ }
        }
        if (!unchanged && metaOpts) {
          try {
            const sig = await collectSignals(p, st)
            phash = sig.phash || phash
            text_fp = sig.text_fp || text_fp
            where_from = sig.where_from || where_from
            content_type = sig.content_type || content_type
            last_used = sig.last_used || last_used
          } catch (e) { /* 元数据失败不阻断 */ }
        }
        const name = basename(p)
        const ext = extname(p).toLowerCase()
        const tags = classifyEntry(name, size, false)
        let real = p
        try { real = await realpath(p) } catch (e) { /* 保留原路径 */ }
        batch.push({
          path: p, real_path: real, root, name, ext, size, mtime_ns: mtimeNs,
          ctime_ns: String(st.ctimeNs || '0'), kind: tags[0] ? tags[0].category : null,
          is_dir: 0, hash_partial, hash_full, hash_state, phash, text_fp,
          where_from, content_type, last_used
        })
        done += 1
        if (done % 5 === 0) { setScan(this.db, id, { done, current: p }); await yieldNow() }
      }
      if (state.aborted) { setScan(this.db, id, { state: 'cancelled', done, finished_at: Math.floor(Date.now() / 1000) }); return }
      commitSnapshot(this.db, root, batch)
      setScan(this.db, id, { state: 'done', done, total: current.length, finished_at: Math.floor(Date.now() / 1000), error: truncated ? '达到单目录 2000 项或总量 20000 文件上限，已截断' : null })
    } finally {
      // 完成/取消/失败都要移出 active，否则同目录永远无法重扫（start() 的 409 守卫）。
      this.active.delete(id)
    }
  }
}

/** 检查一个 /Volumes 卷是否仍在线（SMB 断连探测）。 */
export function volumeOnline(path) {
  if (!String(path).startsWith('/Volumes/')) return true
  try {
    const out = execFileSync('df', ['-k', path], { encoding: 'utf8', timeout: 4000 })
    return out.split(String.fromCharCode(10)).length > 1
  } catch (e) { return false }
}
