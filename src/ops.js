// ★ 执行门：整个插件里唯一允许写业务文件的地方。
// 十步链：AI 只出计划 → 用户逐项勾选 → dry-run → 执行前二次校验 → 串执行+全局锁
//        → 删除一律走 src/trash.js 执行门（native trash -v；SMB 卷无废纸篓时同卷降级）→ EXDEV 不自动降级 → SMB 断连中止 → 每步写 events+ops_items
//        → undo 反序恢复 + 逐字节校验。幂等：batchId 唯一，重复 execute 返回已有结果。
//
// 永不实现：自动定时整理、无人值守批量删除、永久删除开关、AI 自主执行（不经用户确认）。
import { lstatSync, statSync, realpathSync, existsSync, renameSync, copyFileSync, mkdirSync, rmdirSync, writeFileSync } from 'node:fs'
import { join, dirname, basename, isAbsolute, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { fullHashSync, sha256 } from './hash.js'
import { makePlan, validatePlan } from './plan.js'
import { createBatch, getBatch, setBatchStatus, listBatches, addOpItem, updateOpItem, itemsForBatch } from './db.js'
import { addEvent } from './db.js'
import { volumeOnline } from './index.js'
import { cleanStale, cleanScanStamp } from './clean-core.js'
import { trashFile, parseTrashOutput } from './trash.js'
export { parseTrashOutput } from './trash.js'

// 一个 profile 同时只允许一个批次 executing（进程内全局锁）。
let executingBatch = null

function now() { return Math.floor(Date.now() / 1000) }
function err(status, msg) { throw Object.assign(new Error(msg), { status }) }

// 清理批次在 plan_json.clean.scanned 里带扫描锁 (scanned_size, scanned_mtime)。
// 只有存在锁的项才受 stale 门约束；普通批次（聊天/右键菜单）完全不受影响。
function cleanLocks(b) {
  try {
    const plan = b && b.plan_json ? JSON.parse(b.plan_json) : null
    return (plan && plan.clean && plan.clean.scanned) || null
  } catch (e) { return null }
}

/** 把 plan 的 groups 摊平成可逐项勾选的 ops 条目。
 *  id 用数据库真实 ops_items.id；db 为空时（纯函数测试）退化为顺序占位。 */
export function flattenPlan(plan, db, batchId) {
  const items = []
  let seq = 0
  for (const g of plan.groups || []) {
    for (const src of g.paths) {
      items.push({ seq: seq++, id: null, op: g.op || 'none', label: g.label, reason: g.reason,
        src, dst: g.dst || '', requiresExplicitTrash: g.op === 'trash' })
    }
  }
  if (db && batchId) {
    const rows = itemsForBatch(db, batchId)
    for (let i = 0; i < items.length; i++) items[i].id = rows[i] ? Number(rows[i].id) : (i + 1)
  } else {
    for (let i = 0; i < items.length; i++) items[i].id = i + 1
  }
  return items
}

/** 从自然语言生成计划并落 ops_batches（AI 只出计划，状态 planned）。 */
export async function createPlanBatch(ctx, db, message, entries, context, guard) {
  const raw = await makePlan(ctx, message, entries, context)
  if (raw.fallback) return { batchId: null, plan: { ...raw, readOnly: false }, items: [] }
  const plan = validatePlan(raw, entries.map(e => e.path), { guard, roots: guard ? guard.roots : null })
  plan.readOnly = false
  const batchId = 'batch-' + randomUUID()
  createBatch(db, batchId, { reply: plan.reply, intent: plan.intent, groups: plan.groups, dropped: plan.dropped, path: context && context.path })
  for (const it of flattenPlan(plan)) addOpItem(db, { batch_id: batchId, seq: it.seq, op: it.op, src: it.src, dst: it.dst || null, status: 'planned' })
  const items = flattenPlan(plan, db, batchId)
  return { batchId, plan: { ...plan, batchId, items }, items }
}

/** 从已校验的 plan 直接建批次（对话区计划卡片用）。 */
export function createBatchFromPlan(db, plan, context, extra) {
  const flat = flattenPlan(plan)
  if (!flat.length) err(400, '计划里没有可执行项')
  const batchId = 'batch-' + randomUUID()
  const planJson = Object.assign({ reply: plan.reply, intent: plan.intent || 'plan', groups: plan.groups, dropped: plan.dropped || 0, path: context && context.path }, extra || {})
  createBatch(db, batchId, planJson)
  for (const it of flat) addOpItem(db, { batch_id: batchId, seq: it.seq, op: it.op, src: it.src, dst: it.dst || null, status: 'planned' })
  const items = flattenPlan(plan, db, batchId)
  return { batchId, items }
}

function finalDst(item) {
  const src = item.src
  let dst = item.dst
  if (!dst) return null
  if (dst.endsWith(sep) || (existsSync(dst) && statSync(dst).isDirectory())) dst = join(dst, basename(src))
  return resolve(dst)
}

/** 第 3 步 dry-run：每项重新 lstat + realpath 双校验，产出预览；不写任何业务文件。 */
export function dryRun(db, guard, batchId) {
  const b = getBatch(db, batchId)
  if (!b) err(404, '批次不存在')
  if (['executing', 'done', 'rolled_back'].includes(b.status)) err(409, '批次状态不允许 dry-run：' + b.status)
  const rows = itemsForBatch(db, batchId)
  const locks = cleanLocks(b)
  const preview = [], blocked = []
  // 冲突替换批次里「trash 旧文件」在前、「copy/move 写入」在后；执行是串行的。
  // dry-run 必须模拟前序 trash 腾空的目标，否则 copy 项会误判 willOverwrite 被拦（预览与执行不一致）。
  const vacated = new Set()
  for (const r of rows) {
    const item = { id: r.id, seq: r.seq, op: r.op, src: r.src, dst: r.dst, status: 'ready' }
    try {
      if (!r.src || !isAbsolute(r.src)) { item.status = 'skipped'; item.reason = '源路径不合法'; blocked.push(item); continue }
      if (!guard.isAllowed(r.src)) { item.status = 'skipped'; item.reason = '源路径不在允许范围'; blocked.push(item); continue }
      let st
      try { st = lstatSync(r.src) } catch (e) {
        if (r.op !== 'mkdir') { item.status = 'skipped'; item.reason = '源文件已不存在'; blocked.push(item); continue }
        st = null   // mkdir 的 src 是父目录占位，不要求它作为「源文件」参与哈希
      }
      // 清理批次扫描锁：扫描后 size/mtime 变化即硬停止该项，防止删掉用户刚写入的新内容。
      if (locks && locks[r.src]) {
        const chk = cleanStale(locks[r.src], cleanScanStamp(st))
        if (chk.stale) { item.status = 'skipped'; item.reason = chk.reason; blocked.push(item); continue }
      }
      const real = realpathSync(r.src)
      if (!guard.isAllowed(real)) { item.status = 'skipped'; item.reason = 'realpath 逃出允许范围'; blocked.push(item); continue }
      const size = st ? Number(st.size) : 0
      let before_hash = null
      if (r.op !== 'mkdir') { try { before_hash = fullHashSync(r.src, size).hash } catch (e) { /* 大文件或不可读，留空 */ } }
      item.size = size
      item.before_hash = before_hash
      item.real_path = real
      const vol = r.src.startsWith('/Volumes/') ? r.src.split('/').slice(0, 3).join('/') : null
      item.volumeOnline = vol ? volumeOnline(vol) : true
      if (!item.volumeOnline) { item.status = 'skipped'; item.reason = 'SMB 卷已断连'; blocked.push(item); continue }
      const dst = finalDst({ src: r.src, dst: r.dst })
      if (r.op === 'mkdir') {
        const target = resolve(r.dst || '')
        if (!isAbsolute(r.dst || '') || !guard.isAllowed(target)) { item.status = 'skipped'; item.reason = '新建目录目标不合法'; blocked.push(item); continue }
        if (existsSync(target)) { item.status = 'skipped'; item.reason = '目标目录已存在'; blocked.push(item); continue }
        if (!existsSync(dirname(target))) { item.status = 'skipped'; item.reason = '父目录不存在'; blocked.push(item); continue }
        item.dst = target
        item.willOverwrite = false
        item.targetWritable = true
      } else if (['move', 'rename', 'copy'].includes(r.op)) {
        if (!dst) { item.status = 'skipped'; item.reason = '缺少目标路径'; blocked.push(item); continue }
        if (!guard.isAllowed(dst)) { item.status = 'skipped'; item.reason = '目标路径不在允许范围'; blocked.push(item); continue }
        if (dst === r.src) { item.status = 'skipped'; item.reason = '目标与源相同'; blocked.push(item); continue }
        item.dst = dst
        item.willOverwrite = existsSync(dst) && !vacated.has(dst)
        const parent = dirname(dst)
        item.targetWritable = existsSync(parent)
        if (!item.targetWritable) { item.status = 'skipped'; item.reason = '目标父目录不存在（本版不自动新建文件夹）'; blocked.push(item); continue }
        if (item.willOverwrite) { item.status = 'skipped'; item.reason = '目标已存在（本版不覆盖）'; blocked.push(item); continue }
        if (vacated.has(dst)) item.replacesVacated = true   // 该目标由本批前序 trash 腾空，执行时可写
        if (r.op !== 'copy' && dst.split('/').slice(0, 3).join('/') !== r.src.split('/').slice(0, 3).join('/')) {
          item.crossVolume = true
          item.requiresExdevConfirm = true
        }
      }
      if (r.op === 'trash') { item.requiresExplicitTrash = true; if (r.src) vacated.add(r.src) }
      if (r.op === 'tag') item.status = 'skipped', item.reason = '标签操作由 /tags 接口单独处理'
      preview.push(item)
    } catch (e) {
      item.status = 'skipped'; item.reason = '校验异常：' + (e.message || e); blocked.push(item)
    }
  }
  const dry = { items: preview, blocked, at: now() }
  setBatchStatus(db, batchId, 'dry_run', { dry_run_json: dry })
  return { batchId, ...dry }
}

function restoreManifestPath(batchId) { return join(homedir(), '.flowfile', 'RESTORE-MANIFEST-' + batchId + '.json') }

function writeRestoreManifest(batchId, entries) {
  const dir = dirname(restoreManifestPath(batchId))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(restoreManifestPath(batchId), JSON.stringify({ batchId, at: now(), entries }, null, 2), 'utf8')
}

/** 删除执行门的薄包装：真正的落点决策在 src/trash.js（native / SMB 同卷降级）。
 *  trashFile 抛出的任何错误都包成 status 500，保持原「中止、不降级为 rm」语义。 */
function doTrash(src) {
  try {
    return trashFile(src)
  } catch (e) {
    err(500, e && e.message ? e.message : String(e))
  }
}

function hashOf(p, size) { try { return fullHashSync(p, size).hash } catch (e) { return null } }

/** 第 4–9 步：执行。approvedIds 为空表示不执行任何项（必须用户逐项勾选）。 */
export function execute(db, guard, batchId, approvedIds, confirmFlags) {
  const b = getBatch(db, batchId)
  if (!b) err(404, '批次不存在')
  if (b.status === 'done' || b.status === 'rolled_back' || b.status === 'failed') {
    return { batchId, status: b.status, items: itemsForBatch(db, batchId), idempotent: true }
  }
  if (b.status !== 'dry_run') err(409, '请先跑 dry-run，当前状态：' + b.status)
  if (!Array.isArray(approvedIds) || !approvedIds.length) err(400, '没有勾选任何项，拒绝执行')
  if (executingBatch) err(423, '已有批次正在执行：' + executingBatch)
  executingBatch = batchId
  const approved = new Set(approvedIds.map(Number))
  const dry = b.dry_run_json ? JSON.parse(b.dry_run_json) : { items: [] }
  const previewById = new Map((dry.items || []).map(x => [Number(x.id), x]))
  const flags = confirmFlags || {}
  const locks = cleanLocks(b)
  const manifest = []
  let failed = null
  try {
    setBatchStatus(db, batchId, 'executing')
    for (const r of itemsForBatch(db, batchId)) {
      if (!approved.has(Number(r.id))) { updateOpItem(db, r.id, { status: 'skipped', error: '未勾选' }); continue }
      const pv = previewById.get(Number(r.id))
      if (!pv || pv.status !== 'ready') { updateOpItem(db, r.id, { status: 'skipped', error: pv ? pv.reason : '无 dry-run 预览' }); continue }
      // 清理批次 TOCTOU 复检：dry-run 之后、confirmTrash 之前再比一次扫描锁；
      // 变化则只跳过该项（不 break 整批），与 dry-run 的 stale 门口径一致。
      if (locks && locks[r.src]) {
        let st2 = null
        try { st2 = lstatSync(r.src) } catch (e) { st2 = null }
        const chk = cleanStale(locks[r.src], cleanScanStamp(st2))
        if (chk.stale) { updateOpItem(db, r.id, { status: 'skipped', error: chk.reason }); continue }
      }
      // 第 4 步：执行前二次校验（防 TOCTOU）
      try {
        if (r.op !== 'mkdir' && !existsSync(r.src)) err(409, '源文件在执行前已消失')
        if (!guard.isAllowed(realpathSync(r.src))) err(403, '源 realpath 已逃出允许范围')
        const vol = r.src.startsWith('/Volumes/') ? r.src.split('/').slice(0, 3).join('/') : null
        if (vol && !volumeOnline(vol)) err(409, 'SMB 卷在执行前断连，中止整批')
      } catch (e) {
        failed = { item: r, message: e.message }
        updateOpItem(db, r.id, { status: 'failed', error: e.message })
        break  // 第 5 步：失败立即停止后续，不留下半截状态
      }
      const dst = pv.dst || null
      // replacesVacated：本批前序 trash 已腾空该目标（串行执行），此时目标不存在属预期，不算「执行前又出现」。
      const wasVacated = !!pv.replacesVacated
      if (dst && existsSync(dst) && r.op !== 'tag' && !wasVacated) {
        updateOpItem(db, r.id, { status: 'skipped', error: '目标在执行前已出现（不覆盖）' })
        continue
      }
      let trashPath = null, restoreCmd = null, afterHash = null
      try {
        const size = r.op === 'mkdir' ? 0 : Number(pv.size || statSync(r.src).size)
        const beforeHash = r.op === 'mkdir' ? null : (pv.before_hash || hashOf(r.src, size))
        updateOpItem(db, r.id, { before_hash: beforeHash, before_size: size })
        if (r.op === 'move' || r.op === 'rename') {
          if (pv.crossVolume && !flags.confirmExdev) err(409, '跨卷移动需要单独确认（EXDEV 不自动降级）')
          if (pv.crossVolume && flags.confirmExdev) {
            copyFileSync(r.src, dst)
            const a = hashOf(dst, size)
            if (a !== beforeHash) err(500, '跨卷复制后 SHA-256 不一致，中止（源未删除）')
            trashPath = doTrash(r.src)
            restoreCmd = 'mv ' + JSON.stringify(trashPath) + ' ' + JSON.stringify(r.src)
          } else {
            try { renameSync(r.src, dst) }
            catch (e) {
              if (e.code === 'EXDEV') err(409, '跨卷 rename 报 EXDEV，需用户在卡片上单独确认降级方案，不自动执行')
              throw e
            }
            restoreCmd = 'mv ' + JSON.stringify(dst) + ' ' + JSON.stringify(r.src)
          }
          afterHash = hashOf(dst, size)
        } else if (r.op === 'copy') {
          copyFileSync(r.src, dst)
          afterHash = hashOf(dst, size)
          if (afterHash !== beforeHash) err(500, '复制后 SHA-256 不一致，中止')
          restoreCmd = 'trash -v ' + JSON.stringify(dst)
        } else if (r.op === 'trash') {
          if (!flags.confirmTrash) { updateOpItem(db, r.id, { status: 'skipped', error: '删除需二次确认' }); continue }
          trashPath = doTrash(r.src)
          restoreCmd = 'mv ' + JSON.stringify(trashPath) + ' ' + JSON.stringify(r.src)
        } else if (r.op === 'mkdir') {
          const target = dst
          if (!target || existsSync(target)) err(409, '新建目录目标已存在或缺失')
          mkdirSync(target, { recursive: false })
          restoreCmd = 'rmdir ' + JSON.stringify(target)   // 撤销只删空目录，绝不递归删内容
        } else if (r.op === 'tag') {
          updateOpItem(db, r.id, { status: 'skipped', error: '标签操作走 /tags' }); continue
        } else {
          updateOpItem(db, r.id, { status: 'skipped', error: '不支持的操作：' + r.op }); continue
        }
        updateOpItem(db, r.id, { status: 'done', dst, after_hash: afterHash, trash_path: trashPath, restore_cmd: restoreCmd })
        // 第 9 步：每步写 events + ops_items
        addEvent(db, { path: r.src, kind: r.op === 'trash' ? 'deleted' : r.op, from_path: r.src, to_path: dst || trashPath, size, hash_full: afterHash, detail: 'batch:' + batchId, at: now() })
        if (r.op === 'trash' || (pv.crossVolume && flags.confirmExdev)) {
          manifest.push({ src: r.src, size, before_hash: beforeHash, trash_path: trashPath, restore_cmd: restoreCmd })
        }
      } catch (e) {
        failed = { item: r, message: e.message || String(e) }
        updateOpItem(db, r.id, { status: 'failed', error: e.message || String(e) })
        break
      }
    }
    if (manifest.length) writeRestoreManifest(batchId, manifest)
    const status = failed ? 'failed' : 'done'
    setBatchStatus(db, batchId, status, { note: failed ? ('中止于 item ' + failed.item.id + '：' + failed.message) : '全部完成' })
    return { batchId, status, items: itemsForBatch(db, batchId), failed: failed ? failed.message : null }
  } finally {
    executingBatch = null
  }
}

/** 第 10 步 undo：按 ops_items 反序恢复，逐字节校验；undo 本身也要用户确认（由调用方保证）。 */
export function undo(db, guard, batchId) {
  const b = getBatch(db, batchId)
  if (!b) err(404, '批次不存在')
  if (b.status !== 'done' && b.status !== 'failed') err(409, '只有 done/failed 批次可撤销，当前：' + b.status)
  if (executingBatch) err(423, '已有批次正在执行：' + executingBatch)
  executingBatch = batchId
  const results = []
  try {
    const rows = itemsForBatch(db, batchId).filter(r => r.status === 'done').reverse()
    for (const r of rows) {
      try {
        if (r.op === 'trash') {
          if (!r.trash_path || !existsSync(r.trash_path)) err(409, '回收站落点不存在，无法恢复：' + r.trash_path)
          if (existsSync(r.src)) err(409, '原位置已有文件，不覆盖：' + r.src)
          renameSync(r.trash_path, r.src)
          const h = hashOf(r.src, Number(r.before_size || 0))
          if (r.before_hash && h !== r.before_hash) err(500, '恢复后 SHA-256 不一致')
          results.push({ id: r.id, status: 'restored', path: r.src })
        } else if (r.op === 'move' || r.op === 'rename') {
          const dst = r.dst
          if (!dst || !existsSync(dst)) err(409, '移动后的文件已不存在：' + dst)
          if (existsSync(r.src)) err(409, '原位置已有文件，不覆盖：' + r.src)
          renameSync(dst, r.src)
          const h = hashOf(r.src, Number(r.before_size || 0))
          if (r.before_hash && h !== r.before_hash) err(500, '撤销后 SHA-256 不一致')
          results.push({ id: r.id, status: 'restored', path: r.src })
        } else if (r.op === 'copy') {
          if (!r.dst || !existsSync(r.dst)) { results.push({ id: r.id, status: 'skipped', reason: '副本已不存在' }); continue }
          doTrash(r.dst)  // 副本也进回收站，绝不 rm
          results.push({ id: r.id, status: 'restored', path: r.src })
        } else if (r.op === 'mkdir') {
          const d = r.dst
          if (!d || !existsSync(d)) { results.push({ id: r.id, status: 'skipped', reason: '目录已不存在' }); continue }
          rmdirSync(d)   // 只删空目录；非空则抛错并按「部分撤销失败」处理，绝不递归删
          results.push({ id: r.id, status: 'restored', path: d })
        } else {
          results.push({ id: r.id, status: 'skipped', reason: '不支持撤销：' + r.op })
          continue
        }
        addEvent(db, { path: r.src, kind: 'undo', from_path: r.dst || r.trash_path, to_path: r.src, detail: 'batch:' + batchId, at: now() })
      } catch (e) {
        results.push({ id: r.id, status: 'failed', reason: e.message || String(e) })
      }
    }
    const allOk = results.every(x => x.status !== 'failed')
    setBatchStatus(db, batchId, allOk ? 'rolled_back' : 'failed', { note: allOk ? '已全部撤销' : '部分撤销失败' })
    return { batchId, status: allOk ? 'rolled_back' : 'failed', items: results }
  } finally {
    executingBatch = null
  }
}

export function batches(db, limit) { return listBatches(db, limit || 30) }
export function batchDetail(db, id) {
  const b = getBatch(db, id)
  if (!b) return null
  return { ...b, plan: b.plan_json ? JSON.parse(b.plan_json) : null,
    approved: b.approved_json ? JSON.parse(b.approved_json) : null,
    dryRun: b.dry_run_json ? JSON.parse(b.dry_run_json) : null,
    items: itemsForBatch(db, id) }
}
