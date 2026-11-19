// 预设整理方案：一键套用（m07306 第 5 条）。
// 诚实标注：预设全部由规则枚举生成，不经 LLM —— 所以点了立刻有结果、不需要模型、
// 也不会因为模型乱编路径而失败。AI 只在你用自然语言时才介入。
// 执行仍然走 ops.js 的同一条执行门：勾选 → dry-run → 确认 → 可撤销。
import { LARGE_FILE_THRESHOLD, extOf, categoryOfName } from './rules.js'

const DAY = 86400000

// 类型目录名与 rules.js 的分类对齐（不用饱和色，只是文件夹名）。
const TYPE_DIR = {
  image: '图片', video: '视频', audio: '音频', document: '文档',
  spreadsheet: '表格', presentation: '演示', code: '代码', archive: '归档'
}

function mtimeMs(e) {
  if (typeof e.mtime === 'number') return e.mtime
  const t = new Date(e.mtime).getTime()
  return Number.isFinite(t) ? t : 0
}

function groupFiles(entries) {
  return (entries || []).filter(function (e) { return e && !e.isDir && e.path })
}

function plan0(reply, groups) {
  return { reply: reply, intent: 'plan', groups: groups, dropped: 0, readOnly: false, preset: true }
}

function byCategory(entries) {
  const buckets = new Map()
  for (const e of groupFiles(entries)) {
    const fromTags = String((e.tags && e.tags[0] && e.tags[0].category) || '').trim()
    const cat = TYPE_DIR[fromTags] ? fromTags : categoryOfName(e.name || '')
    const key = TYPE_DIR[cat] ? cat : ''
    if (!key) continue
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(e.path)
  }
  return buckets
}

function byYearMonth(entries) {
  const buckets = new Map()
  for (const e of groupFiles(entries)) {
    const t = mtimeMs(e)
    if (!t) continue
    const d = new Date(t)
    const key = d.getFullYear() + '·' + String(d.getMonth() + 1).padStart(2, '0')
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(e.path)
  }
  return buckets
}

function movesFrom(dir, buckets, transform) {
  const out = []
  for (const [key, paths] of buckets) {
    if (!paths.length) continue
    out.push({ label: key, reason: transform.reason(key), op: 'move',
      dst: String(dir).replace(/\/$/, '') + '/' + transform.dir(key), paths: paths })
  }
  return out
}

export const PRESETS = [
  {
    id: 'by-type',
    name: '按类型归档',
    desc: '图片 / 文档 / 视频等各归一个子目录，目录不搬',
    run: function (dir, entries) {
      const g = movesFrom(dir, byCategory(entries), {
        dir: function (k) { return TYPE_DIR[k] || k },
        reason: function (k) { return '扩展名归类为「' + (TYPE_DIR[k] || k) + '」' }
      })
      return g.length ? plan0('按类型归档 ' + g.reduce(function (n, x) { return n + x.paths.length }, 0) + ' 个文件到 ' + g.length + ' 个子目录', g) : null
    }
  },
  {
    id: 'by-month',
    name: '按年月归档',
    desc: '按修改时间落到 YYYY·MM 子目录',
    run: function (dir, entries) {
      const g = movesFrom(dir, byYearMonth(entries), {
        dir: function (k) { return k },
        reason: function (k) { return '修改时间落在 ' + k }
      })
      return g.length ? plan0('按年月归档 ' + g.reduce(function (n, x) { return n + x.paths.length }, 0) + ' 个文件', g) : null
    }
  },
  {
    id: 'big-files',
    name: '挑出大文件',
    desc: '大于 100MB 的移到 _大文件，只搬不删',
    run: function (dir, entries) {
      const paths = groupFiles(entries).filter(function (e) { return Number(e.size) > LARGE_FILE_THRESHOLD }).map(function (e) { return e.path })
      if (!paths.length) return null
      return plan0('挑出 ' + paths.length + ' 个大文件（>100MB）', [{
        label: '大文件', reason: '单个文件超过 100MB', op: 'move',
        dst: String(dir).replace(/\/$/, '') + '/_大文件', paths: paths
      }])
    }
  },
  {
    id: 'old-installers',
    name: '清理旧安装包',
    desc: '90 天前的 dmg / pkg / iso / zip 进回收站（可撤销）',
    run: function (dir, entries) {
      const INSTALLER = { dmg: 1, pkg: 1, iso: 1, mpkg: 1, zip: 1, rar: 1, '7z': 1 }
      const cut = Date.now() - 90 * DAY
      const paths = groupFiles(entries).filter(function (e) {
        if (!INSTALLER[extOf(e.name || '')]) return false
        return mtimeMs(e) > 0 && mtimeMs(e) < cut
      }).map(function (e) { return e.path })
      if (!paths.length) return null
      return plan0('90 天前的安装包 ' + paths.length + ' 个，移到回收站', [{
        label: '旧安装包', reason: '安装包且 90 天未修改', op: 'trash',
        dst: '', paths: paths, requiresExplicitTrash: true
      }])
    }
  },
  {
    id: 'empty-names',
    name: '整理重复后缀',
    desc: '把「副本」「copy」「(1)」这类重复文件挑出来看',
    run: function (dir, entries) {
      const RE = /(副本|拷贝|copy|Copy|\s\(\d+\))(\.[^.]+)?$/
      const paths = groupFiles(entries).filter(function (e) { return RE.test(String(e.name || '')) }).map(function (e) { return e.path })
      if (!paths.length) return null
      return plan0('疑似重复命名的文件 ' + paths.length + ' 个，先移到 _待确认，看过后再决定', [{
        label: '疑似重复', reason: '文件名带「副本 / copy / (n)」', op: 'move',
        dst: String(dir).replace(/\/$/, '') + '/_待确认', paths: paths
      }])
    }
  }
]

export function listPresets() {
  return PRESETS.map(function (p) { return { id: p.id, name: p.name, desc: p.desc } })
}

/** 跑一个预设。没有候选时返回 null（前端据此提示「这个目录没有可套用的项」）。 */
export function buildPresetPlan(id, dir, entries) {
  const p = PRESETS.filter(function (x) { return x.id === id })[0]
  if (!p) return null
  if (!dir) return null
  return p.run(String(dir), entries || []) || null
}

/** 真 bug 修复（m07306 第 4 条）：AI 给出 move 到不存在的目录时，
 * ops.dry-run 会把每一项都判成「目标父目录不存在（本版不自动新建文件夹）」并整批 blocked，
 * 用户看到的就是「AI 执行出错」。这里在执行门前补一条 mkdir，让计划自洽。
 * 只在 dst 的父层就等于当前目录（或 dst 的父层已存在）时补，越界目标不补。 */
export function injectMkdirItems(plan, opts) {
  const o = opts || {}
  const dir = String(o.dir || '')
  const existsFn = o.existsFn || function () { return true }
  const allowedFn = o.allowedFn || function () { return true }
  const groups = (plan && plan.groups) || []
  const need = new Map()
  for (const g of groups) {
    if (!g || !g.dst) continue
    if (g.op !== 'move' && g.op !== 'copy') continue
    const dst = String(g.dst)
    if (existsFn(dst)) continue
    if (!allowedFn(dst)) continue
    need.set(dst, true)
  }
  if (!need.size) return Object.assign({}, plan, { groups: groups })
  const pre = []
  for (const dst of need.keys()) {
    const parent = dst.slice(0, dst.lastIndexOf('/')) || '/'
    // 只有当父层就是当前目录（或父层已存在）时才自动补建，避免凭空造两层目录。
    if (parent !== dir && !existsFn(parent)) continue
    pre.push({ label: '新建目标目录', reason: '目标目录还不存在，先建出来', op: 'mkdir', dst: dst, paths: [parent], auto: true })
  }
  return Object.assign({}, plan, { groups: [].concat(pre, groups) })
}
