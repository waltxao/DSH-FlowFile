// 第2轮 ② P0 浏览管理：host 侧接缝。
// 铁律：本文件不写业务文件（图片只读、statfs 只读）；建目录/移动/删除仍只在 ops.js 的执行门里发生。
// buildMenuBatch 把右键菜单动作转成「planned 批次」，绝不执行——交给既有 dry-run→确认→执行→撤销链。
import { statfsSync, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { OPS } from './plan.js'
import { buildMenuPlan } from './browse-core.js'
import { createBatch, addOpItem, addEvent } from './db.js'
import { flattenPlan } from './ops.js'
import { loadSharp } from './sharp-loader.js'
import { qlThumb, dirThumb, readThumbBytes } from './ql-thumb.js'

let ensured = false
/** 菜单计划需要 mkdir 这个新 op；OPS 是 plan.js 的 Set，幂等加入一次。 */
export function ensureOps() {
  if (!ensured) { OPS.add('mkdir'); ensured = true }
  return OPS
}

/** 设备容量条：statfsSync 只读，越界/不存在返回 ok:false。 */
export function capacityOf(path) {
  try {
    if (!path || !isAbsolute(path) || !existsSync(path)) return { ok: false, error: '路径不可用' }
    const s = statfsSync(path)
    const total = Number(s.blocks) * Number(s.bsize)
    const free = Number(s.bavail) * Number(s.bsize)
    if (!(total > 0)) return { ok: false, error: '容量不可读' }
    const used = total - free
    return { ok: true, path, total, free, used, pct: Math.round(used * 100 / total), bsize: Number(s.bsize) }
  } catch (e) { return { ok: false, error: e.message || String(e) } }
}

/** 图片：sharp 按原图长边缩放，输出 data URL。非图片/越界/超大一律 ok:false。 */
async function imageThumb(guard, real, w) {
  const sharp = loadSharp()
  if (!sharp) return { ok: false, error: '缩略图组件不可用', unsupported: true }
  const buf = readFileSync(real)
  if (buf.length > 40 * 1024 * 1024) return { ok: false, error: '文件过大，跳过缩略图' }
  const meta = await sharp(buf).metadata()
  const out = await sharp(buf).rotate().resize({ width: w, height: w, fit: 'inside', withoutEnlargement: true }).png().toBuffer()
  return { ok: true, path: real, width: meta.width || w, height: meta.height || w, dataUrl: 'data:image/png;base64,' + out.toString('base64') }
}

/** 抓 vips 会不会解不出来的“看起来像图片”的文件，交给 QuickLook 再试一次。 */
const FF_RASTER_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.tiff', '.tif', '.heic', '.heif', '.svg']

/**
 * 真实缩略图（本轮 m10399「能否实现文件缩略图」）：
 *   图片 → sharp 进程内解码（97ms 量级）；
 *   视频 / PDF / Office / 文本 / 代码 → macOS QuickLook（qlmanage 子进程，带 6s 硬超时 + 磁盘缓存 + 并发 2）。
 * 两者都失败才返回 ok:false，前端回落到类型图标，不假装有图。
 */
export async function thumbFor(guard, path, width) {
  let real = ''
  try {
    const p = String(path || '')
    if (!isAbsolute(p) || !guard.isAllowed(p)) return { ok: false, error: '路径不在允许范围' }
    real = realpathSync(p)
    if (!guard.isAllowed(real)) return { ok: false, error: 'realpath 逃出允许范围' }
    const w = Math.max(32, Math.min(512, Number(width) || 128))
    // 目录：qlmanage 对目录会挂死（实测 >10s），自己拼 2×2 图片子项
    try {
      if (statSync(real).isDirectory()) {
        const d = await dirThumb(real, w, loadSharp())
        if (d.ok) {
          const bytes = d.data || readThumbBytes(d)
          if (bytes && bytes.length) {
            return { ok: true, path: real, width: w, height: w, source: 'dir-tiles', cached: !!d.cached,
              dataUrl: 'data:image/png;base64,' + Buffer.from(bytes).toString('base64') }
          }
        }
        return d
      }
    } catch (e) { /* 继续按文件处理 */ }
    const lower = real.toLowerCase()
    const ext = lower.slice(lower.lastIndexOf('.'))
    if (FF_RASTER_EXT.indexOf(ext) >= 0) {
      const img = await imageThumb(guard, real, w)
      if (img.ok) return img
      // sharp 解不了的（HEIC/特殊编码/损坏）继续往下走 QuickLook
    }
    const ql = await qlThumb(real, w)
    if (ql.ok) {
      const bytes = readThumbBytes(ql)
      if (bytes && bytes.length) {
        return { ok: true, path: real, width: w, height: w, source: 'quicklook', cached: !!ql.cached,
          dataUrl: 'data:image/png;base64,' + bytes.toString('base64') }
      }
    }
    return ql.ok ? { ok: false, error: '缩略图字节读取失败' } : ql
  } catch (e) { return { ok: false, error: e.message || String(e) } }
}

/**
 * 右键菜单动作 → planned 批次。只写 SQLite（插件自有元数据），不碰业务文件。
 * ctx: { action, path, selection, clipboard, conflict, newName, entries }。
 * 返回 { batchId, plan, items }；非法动作抛 400。
 */
export function buildMenuBatch(db, guard, ctx) {
  ensureOps()
  const c = ctx || {}
  const action = String(c.action || '')
  const built = buildMenuPlan(action, c)
  if (built.kind !== 'plan' || !built.plan || !built.plan.groups || !built.plan.groups.length) {
    const e = new Error('这个菜单动作不产生可执行计划（' + (built.action || action) + '）')
    e.status = 400
    throw e
  }
  const plan = built.plan
  // 加严：所有 src/dst 必须落在白名单内；mkdir 的 dst 必须是当前目录下的新文件夹。
  const dir = String(c.path || '')
  if (!guard.isAllowed(dir)) { const e = new Error('当前目录不在允许范围'); e.status = 403; throw e }
  for (const g of plan.groups) {
    for (const p of g.paths || []) if (!guard.isAllowed(p)) { const e = new Error('源路径不在允许范围：' + p); e.status = 403; throw e }
    if (g.dst && !guard.isAllowed(g.dst)) { const e = new Error('目标路径不在允许范围：' + g.dst); e.status = 403; throw e }
    if (g.op === 'mkdir') {
      const parent = g.dst ? g.dst.slice(0, g.dst.lastIndexOf('/')) : dir
      if (parent !== dir) { const e = new Error('新建文件夹只能落在当前目录'); e.status = 400; throw e }
    }
  }
  const batchId = 'menu-' + randomUUID()
  createBatch(db, batchId, { reply: plan.reply, intent: 'plan', groups: plan.groups, dropped: 0, path: dir, source: 'menu:' + action })
  const flat = flattenPlan(plan)
  for (const it of flat) addOpItem(db, { batch_id: batchId, seq: it.seq, op: it.op, src: it.src, dst: it.dst || null, status: 'planned' })
  const items = flattenPlan(plan, db, batchId)
  addEvent(db, { path: dir, kind: 'seen', detail: 'menu-plan:' + action + ':' + batchId })
  return { batchId, plan: Object.assign({}, plan, { batchId, items, readOnly: false }), items }
}

export function listAllTags(db) {
  return db.prepare('SELECT name,color,source FROM tags ORDER BY sort_order,name').all()
}

export function volumeCapacity(guard, path) {
  if (!guard.isAllowed(path)) return { ok: false, error: '路径不在允许范围' }
  return capacityOf(realpathSync(path))
}
