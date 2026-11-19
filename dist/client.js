window.__ModuleLoader__.load({id:"flowfile",factory:(require)=>{
const module={exports:{}};const exports=module.exports;
var React=require("react");
// FlowFile 第2轮 ② P0 浏览管理：纯逻辑层。
// 本文件是 ESM（供 node --test 导入），build.mjs 会把 "export " 前缀剥掉后拼进 client bundle。
// 约束：不依赖 DOM / React / fs；所有函数输入输出可序列化；写操作只产出「结构化计划」，绝不直接改文件。
// 安全边界（规格 §2.4）：所有破坏性动作都经本层转成 plan → 宿主建批次 → dry-run → 人确认 → 执行 → 可撤销。

// ---- 导航历史栈（≤50） ----
const FF_HISTORY_MAX = 50

function createHistory(initial) {
  return { stack: initial ? [initial] : [], index: initial ? 0 : -1 }
}

function historyPush(hist, path) {
  const h = hist || createHistory()
  if (!path) return h
  const cur = h.index >= 0 ? h.stack[h.index] : null
  if (cur === path) return h                       // 刷新/重复进入不产生历史
  let stack = h.stack.slice(0, h.index + 1)       // 丢弃「前进」分支
  stack.push(path)
  if (stack.length > FF_HISTORY_MAX) stack = stack.slice(stack.length - FF_HISTORY_MAX)
  return { stack, index: stack.length - 1 }
}

function canBack(hist) { return !!hist && hist.index > 0 }
function canForward(hist) { return !!hist && hist.index >= 0 && hist.index < hist.stack.length - 1 }

function historyBack(hist) {
  if (!canBack(hist)) return null
  const index = hist.index - 1
  return { hist: { stack: hist.stack, index }, path: hist.stack[index] }
}

function historyForward(hist) {
  if (!canForward(hist)) return null
  const index = hist.index + 1
  return { hist: { stack: hist.stack, index }, path: hist.stack[index] }
}

// ---- 地址栏 ----
function isSafeAddress(text) {
  const s = String(text || '').trim()
  if (!s || s.charAt(0) !== '/') return false
  const parts = s.split('/')
  for (const p of parts) if (p === '..' || p === '~') return false
  return true
}

function normalizeAddress(text) {
  let s = String(text || '').trim().replace(/\\/g, '/')
  if (!s) return ''
  if (s.charAt(0) !== '/') s = '/' + s
  s = s.replace(/\/+/g, '/').replace(/\/+$/,'')
  return s || '/'
}

// ---- 面包屑（修 onGo('/') 被白名单静默拦下的缺陷）----
function nameOf(p) { return String(p || '').split('/').filter(Boolean).pop() || '/' }
function dirOf(p) { const i = String(p || '').lastIndexOf('/'); return i <= 0 ? '/' : String(p).slice(0, i) }
function joinPath(dir, name) {
  const d = String(dir || '/').replace(/\/+$/, '') || '/'
  return (d === '/' ? '' : d) + '/' + String(name || '').replace(/^\/+/, '')
}

function volumeRootFor(path, volumes) {
  let best = null
  for (const v of volumes || []) {
    const p = typeof v === 'string' ? v : (v && v.path)
    if (!p) continue
    if (path === p || String(path).indexOf(p + '/') === 0) {
      if (!best || p.length > (typeof best === 'string' ? best : best.path).length) best = v
    }
  }
  return best
}

function crumbTrail(path, volumes) {
  const p = String(path || '/')
  const v = volumeRootFor(p, volumes)
  const root = v ? (typeof v === 'string' ? v : v.path) : null
  const rootLabel = v && typeof v !== 'string' && v.name ? v.name : (root ? nameOf(root) : '/')
  const items = [{ label: rootLabel, path: root, enabled: !!root, root: true }]
  if (root && p === root) return items                       // 正在卷根：只显示卷名，不重复拆根路径段
  const start = root && p.indexOf(root + '/') === 0 ? root.length : 0
  const rest = p.slice(start).split('/').filter(Boolean)
  let acc = start ? root : ''
  for (let i = 0; i < rest.length; i++) {
    acc = acc + '/' + rest[i]
    items.push({ label: rest[i], path: acc, enabled: true, root: false, last: i === rest.length - 1 })
  }
  return items
}

// ---- 多选状态机（Set + anchor）----
const FF_SEL_CLEAR = { selected: [], anchor: null }

/** action: {type:'click'|'cmd'|'shift'|'selectAll'|'deselectAll'|'escape', path?, order?:string[]} */
function reduceSelection(state, action) {
  const s = state || FF_SEL_CLEAR
  const cur = Array.isArray(s.selected) ? s.selected : []
  const order = Array.isArray(action.order) ? action.order : []
  const set = new Set(cur)
  switch (action.type) {
    case 'click':
      return { selected: action.path ? [action.path] : [], anchor: action.path || null }
    case 'cmd': {
      if (!action.path) return { selected: cur, anchor: s.anchor }
      if (set.has(action.path)) set.delete(action.path); else set.add(action.path)
      return { selected: Array.from(set), anchor: s.anchor }   // ⌘ 增减不动锚点，⇧ 范围才有稳定起点
    }
    case 'shift': {
      if (!action.path || !order.length) return { selected: cur, anchor: s.anchor }
      const a = order.indexOf(s.anchor != null ? s.anchor : order[0])
      const b = order.indexOf(action.path)
      if (a < 0 || b < 0) return { selected: [action.path], anchor: s.anchor != null ? s.anchor : action.path }
      const lo = Math.min(a, b), hi = Math.max(a, b)
      return { selected: order.slice(lo, hi + 1), anchor: s.anchor != null ? s.anchor : order[lo] }
    }
    case 'selectAll':
      return { selected: order.slice(), anchor: s.anchor }
    case 'deselectAll':
    case 'escape':
      return { selected: [], anchor: null }
    default:
      return { selected: cur, anchor: s.anchor }
  }
}

// ---- 列头排序（三击复原）+ 列显隐/宽持久化 ----
const FF_SORT_KEYS = ['name', 'size', 'mtime', 'tags']

function nextSort(cur, key) {
  if (!FF_SORT_KEYS.includes(key)) return { key: null, dir: null }
  if (!cur || cur.key !== key) return { key, dir: 'asc' }
  if (cur.dir === 'asc') return { key, dir: 'desc' }
  return { key: null, dir: null }              // 第三击复原为服务端自然序
}

function ts(v) {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return v
  const s = String(v)
  if (/^\d+$/.test(s)) return Number(s)
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : 0
}
function firstTag(e) {
  const t = e && e.tags && e.tags[0]
  return t ? String(typeof t === 'string' ? t : (t.name || '')) : ''
}

function sortEntries(entries, sort) {
  const list = Array.isArray(entries) ? entries.slice() : []
  if (!sort || !sort.key || !FF_SORT_KEYS.includes(sort.key)) return list
  const dir = sort.dir === 'desc' ? -1 : 1
  const key = sort.key
  return list.sort(function (a, b) {
    if (!!a.isDir !== !!b.isDir) return a.isDir ? -1 : 1   // 目录恒在前
    if (key === 'name' || key === 'tags') {
      const av = key === 'name' ? String(a.name || '') : firstTag(a)
      const bv = key === 'name' ? String(b.name || '') : firstTag(b)
      return dir * av.localeCompare(bv, 'zh')
    }
    const av = key === 'size' ? (Number(a.size) || 0) : ts(a.mtime)
    const bv = key === 'size' ? (Number(b.size) || 0) : ts(b.mtime)
    if (av === bv) return String(a.name || '').localeCompare(String(b.name || ''), 'zh')
    return dir * (av < bv ? -1 : 1)
  })
}

const FF_COL_KEY = 'flowfile.columns.v1'
function defaultColumns() {
  return [
    { key: 'name', label: '名称', visible: true, width: null },
    { key: 'size', label: '大小', visible: true, width: 96 },
    { key: 'mtime', label: '修改时间', visible: true, width: 152 },
    { key: 'tags', label: '标签', visible: true, width: 168 }
  ]
}
function loadColumns(storage, fallback) {
  const base = (fallback || defaultColumns()).map(c => Object.assign({}, c))
  try {
    const raw = storage && storage.getItem(FF_COL_KEY)
    if (!raw) return base
    const saved = JSON.parse(raw)
    if (!Array.isArray(saved)) return base
    return base.map(function (c) {
      const s = saved.find(x => x && x.key === c.key)
      if (!s) return c
      return Object.assign({}, c, { visible: s.visible !== false, width: (s.width === null || Number(s.width) >= 60) ? (s.width === null ? null : Number(s.width)) : c.width })
    })
  } catch (e) { return base }
}
function saveColumns(storage, cols) {
  try { storage && storage.setItem(FF_COL_KEY, JSON.stringify((cols || []).map(c => ({ key: c.key, visible: c.visible, width: c.width })))) } catch (e) {}
  return cols
}
function toggleColumn(cols, key) {
  if (key === 'name') return cols            // 名称列不允许隐藏
  return cols.map(c => c.key === key ? Object.assign({}, c, { visible: !c.visible }) : c)
}
function setColumnWidth(cols, key, w) {
  const width = (w === null || w === 'auto') ? null : Math.max(60, Math.min(600, Number(w) || 0))
  return cols.map(c => c.key === key ? Object.assign({}, c, { width }) : c)
}
function columnGrid(cols) {
  return (cols || []).filter(c => c.visible).map(c => c.width == null ? 'minmax(0,1fr)' : (c.width + 'px')).join(' ')
}

// 第 24 轮（m11235 诉求 5）：视图从二态扩成三态 list | grid | columns（Finder 式级联分栏）。
// 旧键 flowfile.view.v1 里只可能存 'grid' / 'list'，读到时按同一套白名单收敛，不会因新值报错。
const FF_VIEW_KEY = 'flowfile.view.v1'
const FF_VIEW_MODES = ['list', 'grid', 'columns']
function loadViewMode(storage) {
  try {
    const v = storage && storage.getItem(FF_VIEW_KEY)
    return FF_VIEW_MODES.indexOf(v) >= 0 ? v : 'list'
  } catch (e) { return 'list' }
}
function saveViewMode(storage, mode) {
  const v = FF_VIEW_MODES.indexOf(mode) >= 0 ? mode : 'list'
  try { storage && storage.setItem(FF_VIEW_KEY, v) } catch (e) {}
  return v
}
function nextViewMode(mode) {
  const i = FF_VIEW_MODES.indexOf(mode)
  return FF_VIEW_MODES[(i < 0 ? 0 : i + 1) % FF_VIEW_MODES.length]
}

// ---- 检查器手动隐藏（诉求 3）：与「窗口太窄自动让位」是两码事，手动态要能压过断点 ----
const FF_INSP_KEY = 'flowfile.insp.v1'
function loadInspOpen(storage) {
  try {
    const v = storage && storage.getItem(FF_INSP_KEY)
    return v === 'closed' ? false : true
  } catch (e) { return true }
}
function saveInspOpen(storage, open) {
  try { storage && storage.setItem(FF_INSP_KEY, open ? 'open' : 'closed') } catch (e) {}
  return !!open
}

// ---- 收藏（localStorage）----
const FF_FAV_KEY = 'flowfile.favorites.v1'
function loadFavorites(storage) {
  try {
    const raw = storage && storage.getItem(FF_FAV_KEY)
    const a = raw ? JSON.parse(raw) : []
    return Array.isArray(a) ? a.filter(x => x && x.path).slice(0, 24) : []
  } catch (e) { return [] }
}
function toggleFavorite(storage, list, item) {
  const cur = Array.isArray(list) ? list : []
  const i = cur.findIndex(x => x && x.path === (item && item.path))
  const out = i >= 0 ? cur.filter((_, j) => j !== i) : cur.concat([{ path: item.path, name: item.name || nameOf(item.path) }]).slice(-24)
  try { storage && storage.setItem(FF_FAV_KEY, JSON.stringify(out)) } catch (e) {}
  return out
}

// ---- 状态栏 / 六态 ----
const FF_STATE_HINTS = {
  loading: { label: '加载中', hint: '正在读取目录，稍候…', tone: 'info' },
  error: { label: '出错', hint: '点「刷新」重试，或回到上级目录。', tone: 'error' },
  offline: { label: '卷不可用', hint: 'SMB 卷可能已断连，重新挂载后点「刷新」。', tone: 'warning' },
  partial: { label: '部分失败', hint: '目录项已截断，缩小范围或扫描后查看。', tone: 'warning' },
  readonly: { label: '只读', hint: '当前目录不可写，整理动作不会执行。', tone: 'warning' },
  empty: { label: '空', hint: '这个目录是空的，或隐藏项已被跳过。', tone: 'info' },
  ready: { label: '就绪', hint: '', tone: 'ok' }
}

function stateOf(ctx) {
  const c = ctx || {}
  if (c.loading) return 'loading'
  if (c.error) return 'error'
  if (c.offline) return 'offline'
  if (c.partial) return 'partial'
  if (c.readOnly) return 'readonly'
  if (!c.listing || !c.shownCount) return 'empty'
  return 'ready'
}

function statusFor(ctx) {
  const c = ctx || {}
  const st = stateOf(c)
  const meta = FF_STATE_HINTS[st]
  const text = (c.shownCount || 0) + ' 项' + (c.selectedCount ? ' · 已选 ' + c.selectedCount : '') + (c.totalCount && c.totalCount !== c.shownCount ? ' / 共 ' + c.totalCount : '')
  return { text, state: st, label: meta.label, hint: c.hint || meta.hint, tone: meta.tone }
}

// ---- 快捷键模型 ----
function matchHotkey(e) {
  const x = e || {}
  const k = x.key || ''
  const mod = !!(x.metaKey || x.ctrlKey)
  const tag = String(x.targetTag || '').toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || x.isContentEditable) return null
  if (mod && (k === 'a' || k === 'A')) return x.shiftKey ? 'deselectAll' : 'selectAll'
  if (mod && (k === 'c' || k === 'C')) return 'copy'
  if (mod && (k === 'x' || k === 'X')) return 'cut'
  if (mod && (k === 'v' || k === 'V')) return 'paste'
  if (mod && k === '[') return 'back'
  if (mod && k === ']') return 'forward'
  if (mod && k === 'ArrowUp') return 'up'
  if (mod && (k === 'Backspace' || k === 'Delete')) return 'trash'
  // 第 24 轮：⌥⌘I 切换检查器（macOS Finder 的「显示/隐藏检查器」同键位）；
  // ⌘1/⌘2/⌘3 切三档视图（列表 / 网格 / 分栏）。
  if (mod && x.altKey && (k === 'i' || k === 'I')) return 'inspector'
  // 第 25 轮：界面里搜索框挂着 ⌘K 提示、AI 助手按钮 title 写「⌘K 也可」，
  // 但快捷键表里根本没有 k —— 这是界面在撒谎。两个都补上，且分清：
  // ⌘K = 聚焦搜索框（提示就贴在搜索框里），⌘⇧K = 打开 AI 助手。
  if (mod && x.shiftKey && (k === 'k' || k === 'K')) return 'ai'
  if (mod && (k === 'k' || k === 'K')) return 'search'
  if (mod && k === '1') return 'viewList'
  if (mod && k === '2') return 'viewGrid'
  if (mod && k === '3') return 'viewColumns'
  if (k === 'Escape') return 'escape'
  if (k === ' ' || k === 'Spacebar') return 'quicklook'
  if (k === 'F2') return 'rename'
  if (k === 'Enter') return 'open'
  if (!mod && (k === 'Backspace' || k === 'Delete')) return 'trash'
  return null
}

// ---- 右键动态菜单 ----
/** ctx: {isBlank, target, selectedCount, clipCount, readOnly} */
function menuFor(ctx) {
  const c = ctx || {}
  const n = c.selectedCount || 0
  const ro = !!c.readOnly
  const items = []
  const push = function (id, label, enabled, danger) { items.push({ id, label, enabled: enabled !== false, danger: !!danger }) }
  const sep = function () { items.push({ sep: true }) }
  if (c.isBlank || !c.target) {
    push('newFolder', '新建文件夹', !ro)
    push('paste', '粘贴' + (c.clipCount ? '（' + c.clipCount + ' 项）' : ''), !!c.clipCount && !ro)
    sep()
    push('selectAll', '全选', true)
    push('refresh', '刷新', true)
  } else {
    push('open', '打开', true)
    // 第 13 轮（m06568 ③）：需要「在新标签页中打开」——原来目录双击每次都新开 tab，
    // 右键反而没有这个动作。现在双击原地导航，新标签页变成显式菜单项 + ⌘ 双击。
    push('openTab', '在新标签页中打开', true)
    sep()
    push('copy', '复制' + (n > 1 ? ' ' + n + ' 项' : ''), true)
    push('cut', '剪切' + (n > 1 ? ' ' + n + ' 项' : ''), !ro)
    push('paste', '粘贴' + (c.clipCount ? '（' + c.clipCount + ' 项）' : ''), !!c.clipCount && !ro)
    push('copyPath', '拷贝路径', true)
    sep()
    push('rename', '重命名', n === 1 && !ro)
    push('tag', '加标签…', !ro)
    sep()
    push('findDup', '查找重复', true)
    push('findSim', '查找相似', true)
    sep()
    push('trash', '移到废纸篓', !ro, true)
    sep()
    push('selectAll', '全选', true)
  }
  return items
}

// ---- 标签：7 色（色点 + 名称，不单靠色）----
const FF_TAG_COLORS = [
  { id: 'gray', name: '灰', hex: '#8E8E93' },
  { id: 'red', name: '红', hex: '#FF453A' },
  { id: 'orange', name: '橙', hex: '#FF9F0A' },
  { id: 'yellow', name: '黄', hex: '#FFD60A' },
  { id: 'green', name: '绿', hex: '#30D158' },
  { id: 'blue', name: '蓝', hex: '#0A84FF' },
  { id: 'purple', name: '紫', hex: '#BF5AF2' }
]
function isTagColor(hex) { return FF_TAG_COLORS.some(c => c.hex === hex || c.id === hex) }
function tagAssign(current, name, on) {
  const cur = Array.isArray(current) ? current.slice() : []
  const i = cur.indexOf(name)
  if (on && i < 0) cur.push(name)
  if (!on && i >= 0) cur.splice(i, 1)
  return cur
}

// ---- 冲突三选 ----
function uniqueDst(dst, taken) {
  const s = new Set(taken || [])
  if (!s.has(dst)) return dst
  const slash = dst.lastIndexOf('/')
  const dir = dst.slice(0, slash + 1), base = dst.slice(slash + 1)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  let n = 2, cand
  do { cand = dir + stem + ' ' + n + ext; n += 1 } while (s.has(cand) && n < 1000)
  return cand
}

/** choice: 'keep' | 'replace' | 'skip' */
function resolveConflicts(items, existingPaths, choice) {
  const taken = new Set(existingPaths || [])
  const conflicts = items.filter(it => taken.has(it.dst)).map(it => it.dst)
  const out = [], trashTargets = []
  for (const it of items) {
    if (!taken.has(it.dst)) { out.push({ src: it.src, dst: it.dst }); taken.add(it.dst); continue }
    if (choice === 'skip') continue
    if (choice === 'replace') { out.push({ src: it.src, dst: it.dst }); trashTargets.push(it.dst); continue }
    const nd = uniqueDst(it.dst, taken)
    taken.add(nd)
    out.push({ src: it.src, dst: nd })
  }
  return { items: out, conflicts, trashTargets }
}

function conflictsFor(clipboard, dir, entries) {
  const paths = (clipboard && clipboard.paths) || []
  const exist = new Set((entries || []).map(e => e.path))
  const out = []
  for (const src of paths) { const dst = joinPath(dir, nameOf(src)); if (exist.has(dst)) out.push(dst) }
  return out
}

// ---- 菜单动作 → 结构化计划（不执行）----
function planOf(reply, groups) {
  return { reply, intent: 'plan', groups, dropped: 0, readOnly: false }
}

/** 返回 {kind:'plan', plan} 或 {kind:'client', action}。ctx: {path, entries, selection, clipboard, conflict, newName} */
function buildMenuPlan(action, ctx) {
  const c = ctx || {}
  const dir = String(c.path || '/')
  const sel = (c.selection || []).slice()
  const clip = c.clipboard || { mode: 'copy', paths: [] }
  const conflict = c.conflict || 'keep'
  const entries = c.entries || []

  if (action === 'newFolder') {
    const dst = joinPath(dir, c.newName || '新建文件夹')
    return { kind: 'plan', plan: planOf('新建文件夹', [
      { op: 'mkdir', label: '新建文件夹', dst, paths: [dir], reason: '在当前目录新建文件夹' }
    ]) }
  }
  if (action === 'rename') {
    if (sel.length !== 1) return { kind: 'client', action: 'needOne' }
    const src = sel[0]
    const dst = joinPath(dirOf(src), c.newName || nameOf(src))
    if (dst === src) return { kind: 'client', action: 'noop' }
    return { kind: 'plan', plan: planOf('重命名 1 项', [
      { op: 'rename', label: '重命名', dst, paths: [src], reason: '重命名文件' }
    ]) }
  }
  if (action === 'trash') {
    if (!sel.length) return { kind: 'client', action: 'needOne' }
    return { kind: 'plan', plan: planOf('把 ' + sel.length + ' 项移到废纸篓（可撤销）', [
      { op: 'trash', label: '移到废纸篓', dst: '', paths: sel, reason: '用户从右键菜单移到废纸篓', requiresExplicitTrash: true }
    ]) }
  }
  if (action === 'paste') {
    const srcs = clip.paths || []
    if (!srcs.length) return { kind: 'client', action: 'noop' }
    const op = clip.mode === 'cut' ? 'move' : 'copy'
    const items0 = srcs.map(src => ({ src, dst: joinPath(dir, nameOf(src)) }))
    const res = resolveConflicts(items0, entries.map(e => e.path), conflict)
    const groups = []
    if (res.trashTargets.length) groups.push({
      op: 'trash', label: '替换前先移走旧文件', dst: '', paths: res.trashTargets,
      reason: '冲突选择「替换」：旧文件先进回收站，可撤销', requiresExplicitTrash: true
    })
    for (const it of res.items) {
      const natural = joinPath(dir, nameOf(it.src))
      const gdst = it.dst === natural ? dir : it.dst   // 自然目标传父目录，改名目标传全路径
      groups.push({ op, label: op === 'move' ? '移动到此处' : '复制到此处', dst: gdst, paths: [it.src], reason: '从剪贴板粘贴' })
    }
    if (!groups.length) return { kind: 'client', action: 'allSkipped' }
    return { kind: 'plan', plan: planOf('粘贴 ' + res.items.length + ' 项', groups) }
  }
  return { kind: 'client', action }
}

// ---- 网格缩略图 ----
// 本轮（m10399「能否实现文件缩略图」）：缩略图不再只有 7 种图片格式。
// 图片走 sharp，视频/PDF/Office/文本走 macOS QuickLook（见 src/ql-thumb.js），因此前端一律放行「非目录」，
// 真的取不到时后端回 ok:false，前端回落类型图标——不假装有图，也不再有「明明能出图却不去取」的死区。
const FF_THUMB_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.tiff', '.tif', '.heic', '.heif', '.svg']
// 明确不试的后缀（会拖慢 UI 且几乎没有可用预览）
const FF_THUMB_SKIP_EXT = ['.iso', '.dmg', '.img', '.vmdk', '.pkg', '.mpkg', '.toast', '.sparsebundle', '.part', '.tmp']
function canThumb(entry) {
  if (!entry || entry.isDir) return false
  const ext = String(entry.ext || nameOf(entry.path).replace(/^.*\./, '.') || '').toLowerCase()
  return FF_THUMB_SKIP_EXT.indexOf(ext) < 0
}
// 目录缩略图（2×2 图片子项拼图）：与文件缩略图分开判据——
// 目录可能一张图都没有，出不来就回落文件夹图标，属于正常情况不是缺陷。
// 深度 0 就取的顶层层级也放开：只要有 >0 个子项就值得试一次（超过 3 个才拼）。
function canDirThumb(entry) {
  if (!entry || !entry.isDir) return false
  // 已知的重目录类型（.app 包 / 版本库 / 缓存）不值得递归探测
  const name = String(entry.name || nameOf(entry.path) || '')
  if (/\.(app|bundle|framework|photoslibrary|lrdata|sparsebundle)$/i.test(name)) return false
  return true
}
function isRasterImage(entry) {
  if (!entry || entry.isDir) return false
  const ext = String(entry.ext || nameOf(entry.path).replace(/^.*\./, '.') || '').toLowerCase()
  return FF_THUMB_EXT.indexOf(ext) >= 0
}
function partitionVolumes(volumes) {
  const local = [], smb = []
  for (const v of volumes || []) (v && v.isSmb ? smb : local).push(v)
  return { local, smb }
}

// ---- 第 15 轮（m07306 ①）：低分辨率自适应 ----
// 真机实测的病灶：1920 下中栏 1078px 很好，但 1024x768 下 root 只有 744px，
// 左树 210 + 右栏 340 固定吃掉 550，中栏只剩 182px —— 文件表被挤成一条缝，
// 这就是「低分辨率下没法看」。所以尺寸必须按可用宽度收敛，而不是只让用户手拖。
// 参数是「可用宽度」（.fd-root 的 clientWidth），不是视口宽度：宿主左侧导航会吃掉 280px。
const FF_LAYOUT_BREAKS = { wide: 1360, mid: 1080, narrow: 860, tiny: 700, rightHide: 1080 }

function clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

/** 把用户设的布局按当前可用宽高收敛。返回 {treeW, rightW, dockH, rightHidden, compact}。 */
function fitLayout(layout, availW, availH) {
  const base = layout || {}
  const w = Number(availW) || 1440
  const h = Number(availH) || 900
  let treeW = Number(base.treeW) || 210
  let rightW = Number(base.rightW) || 340
  let dockH = Number(base.dockH) || 300
  let rightHidden = false
  let compact = false
  if (w < FF_LAYOUT_BREAKS.tiny) { treeW = 128; rightHidden = true; compact = true }
  else if (w < FF_LAYOUT_BREAKS.narrow) { treeW = Math.min(treeW, 150); rightHidden = true; compact = true }
  else if (w < FF_LAYOUT_BREAKS.mid) { treeW = Math.min(treeW, 176); rightW = Math.min(rightW, 276); rightHidden = true }
  else if (w < FF_LAYOUT_BREAKS.wide) { treeW = Math.min(treeW, 190); rightW = Math.min(rightW, 290) }
  // 左树不得超过可用宽度的 30%（否则中栏永远没法看）
  treeW = clampNum(treeW, 96, Math.max(120, Math.round(w * 0.30)))
  // dock 高度按视口比例收敛：矮屏不能留 300px 死高度，否则文件表只剩几行。
  const ratio = h < 700 ? 0.30 : (h < 820 ? 0.32 : (h < 980 ? 0.38 : 0.45))
  dockH = Math.min(dockH, Math.max(120, Math.min(Math.round(h * ratio), h - 260)))
  return { treeW: treeW, rightW: rightW, dockH: dockH, rightHidden: rightHidden, compact: compact }
}

// ---- 第 15 轮（m07306 ②）：左树 / 右栏可折叠 ----
const FF_FOLD_KEY = 'flowfile.fold.v1'
function loadUiFold(storage) {
  const def = { tree: true, right: true }
  try {
    const raw = storage && storage.getItem(FF_FOLD_KEY)
    if (!raw) return def
    const o = JSON.parse(raw)
    return { tree: o.tree !== false, right: o.right !== false }
  } catch (e) { return def }
}
function saveUiFold(storage, fold) {
  const v = { tree: !(fold && fold.tree === false), right: !(fold && fold.right === false) }
  try { if (storage && storage.setItem) storage.setItem(FF_FOLD_KEY, JSON.stringify(v)) } catch (e) { /* 隐私模式忽略 */ }
  return v
}

// FlowFile 清理 P0 · 纯逻辑核心（零依赖、零模板字符串）
// 同一份源码：node --test 直接 import；scripts/build.mjs 剥 export 前缀后拼进 client bundle。
// 依据 flowfile/docs/FlowFile-第3轮规格-清理-定稿.md §4：借鉴 Mole「怎么删」，不照搬「清什么」。

const FF_CLEAN_LARGE = 100 * 1024 * 1024;
const FF_CLEAN_UNUSED_DAYS = 180;
const FF_CLEAN_RECENT_DAYS = 7;
const FF_CLEAN_INSTALLER_DAYS = 30;
const FF_CLEAN_MAX = 400;
const FF_CLEAN_INSTALLER_EXT = ['.dmg', '.pkg', '.zip', '.iso'];
const FF_CLEAN_CATEGORY_LABEL = { large: '大文件', unused: '久未使用', installer: '旧安装包', duplicate: '重复副本' };
var FF_CLEAN_PRIORITY = ['duplicate', 'installer', 'large', 'unused'];
var FF_CLEAN_DAY_MS = 86400000;

function cleanBase(p) {
  var s = String(p || '');
  var i = s.lastIndexOf('/');
  return i < 0 ? s : s.slice(i + 1);
}

function cleanExt(p) {
  var b = cleanBase(p).toLowerCase();
  var i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i);
}

function cleanNsToMs(v) {
  var s = String(v == null ? '' : v);
  if (!s || !/^\d+$/.test(s)) return 0;
  var n;
  try { n = BigInt(s); } catch (e) { return 0; }
  if (n > 1000000000000000n) n = n / 1000000n;
  return Number(n);
}

function cleanIsRecent(mtimeNs, nowMs, days) {
  var ms = cleanNsToMs(mtimeNs);
  if (!ms) return false;
  return (nowMs - ms) < days * FF_CLEAN_DAY_MS;
}

function cleanLargeReason(row, threshold) {
  var size = Number((row && row.size) || 0);
  var t = threshold == null ? FF_CLEAN_LARGE : threshold;
  if (size > t) return '大文件（超过 ' + Math.round(t / 1048576) + ' MB）';
  return null;
}

function cleanUnusedReason(row, nowMs, days) {
  var d = days == null ? FF_CLEAN_UNUSED_DAYS : days;
  var ms = cleanNsToMs(row && row.mtime_ns) || cleanNsToMs(row && row.ctime_ns);
  if (!ms) return null;
  if (nowMs - ms > d * FF_CLEAN_DAY_MS) return '久未使用（超过 ' + d + ' 天未修改）';
  return null;
}

function cleanInstallerReason(row, home, nowMs, days) {
  var d = days == null ? FF_CLEAN_INSTALLER_DAYS : days;
  var p = String((row && row.path) || '');
  var h = String(home || '').replace(/\/$/, '');
  if (p.indexOf(h + '/Downloads/') !== 0) return null;
  var ext = cleanExt(p);
  if (FF_CLEAN_INSTALLER_EXT.indexOf(ext) < 0) return null;
  var ms = cleanNsToMs(row && row.mtime_ns);
  if (ms && (nowMs - ms) < d * FF_CLEAN_DAY_MS) return null;
  return '旧安装包（Downloads 中超过 ' + d + ' 天的 ' + ext + '）';
}

function cleanProtect(p, home) {
  p = String(p || '');
  var h = String(home || '').replace(/\/$/, '');
  if (p.indexOf('/Volumes') === 0 || p.indexOf('//') === 0) {
    return { protected: true, reason: '/Volumes 与 SMB 网络卷一律排除（本轮不碰）' };
  }
  if (!h || (p !== h && p.indexOf(h + '/') !== 0)) {
    return { protected: true, reason: '不在用户目录（homedir）白名单内' };
  }
  var rel = p.indexOf(h + '/') === 0 ? p.slice(h.length + 1) : '';
  var segs = rel ? rel.split('/') : [];
  var nameLower = cleanBase(p).toLowerCase();
  var ext = cleanExt(p);
  var i, j;

  var credSegs = ['.ssh', '.gnupg', '.aws', '.kube'];
  for (i = 0; i < segs.length; i++) {
    if (credSegs.indexOf(segs[i].toLowerCase()) >= 0) {
      return { protected: true, reason: '凭据/密钥目录，删除后可能无法恢复登录与加密能力，一律保护' };
    }
  }
  var credNames = ['.credentials.yaml', 'id_rsa', 'id_ed25519', '.env'];
  if (credNames.indexOf(nameLower) >= 0 || ['.pem', '.key', '.p12'].indexOf(ext) >= 0) {
    return { protected: true, reason: '凭据/密钥文件，删除后可能无法恢复，一律保护' };
  }

  var modelPrefixes = ['.ollama/models/', '.lmstudio/models/', '.cache/huggingface/', '.cache/torch/', '.cache/whisper/', '.cache/tensorflow/', '.cache/wandb/'];
  for (i = 0; i < modelPrefixes.length; i++) {
    if (rel.indexOf(modelPrefixes[i]) === 0) {
      return { protected: true, reason: '模型权重/下载物，长得像缓存但重装成本高，一律保护' };
    }
  }
  if (rel.indexOf('.cache/pypoetry/virtualenvs/') === 0) {
    return { protected: true, reason: '在用 Python 解释器（virtualenvs），一律保护' };
  }
  var lockNames = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'cargo.lock'];
  if (lockNames.indexOf(nameLower) >= 0) {
    return { protected: true, reason: '项目源码/锁文件，不属于清理候选，一律保护' };
  }
  var memPrefixes = ['.dsh/', '.claude/skills/', '.codex/', '.config/flowfile/'];
  for (i = 0; i < memPrefixes.length; i++) {
    if (rel.indexOf(memPrefixes[i]) === 0) {
      return { protected: true, reason: '记忆/计划/技能/配置数据，一律保护' };
    }
  }
  if (rel.indexOf('.flowfile/') === 0) {
    return { protected: true, reason: 'FlowFile 自身数据（回收站清单/索引），一律保护' };
  }
  for (i = 0; i < segs.length - 1; i++) {
    if (segs[i].charAt(0) === '.' && segs[i].length > 1) {
      return { protected: true, reason: '隐藏点目录，默认不枚举、不列入' };
    }
  }
  return null;
}

function cleanAllowedRoot(p, home) {
  p = String(p || '');
  var h = String(home || '').replace(/\/$/, '');
  if (p.indexOf('/Volumes') === 0 || p.indexOf('//') === 0) return false;
  return !!h && (p === h || p.indexOf(h + '/') === 0);
}

function makeCandidate(row, cats, reasons, opts) {
  var cat = 'unused';
  for (var m = 0; m < FF_CLEAN_PRIORITY.length; m++) {
    if (cats.indexOf(FF_CLEAN_PRIORITY[m]) >= 0) { cat = FF_CLEAN_PRIORITY[m]; break; }
  }
  var risk = (cat === 'duplicate' || cat === 'installer') ? 'low' : 'medium';
  var size = Number(row.size || 0);
  var mtimeNs = String(row.mtime_ns || '0');
  return {
    path: String(row.path || ''),
    name: String(row.name || cleanBase(row.path)),
    ext: cleanExt(row.path),
    size: size,
    mtime_ns: mtimeNs,
    category: cat,
    categories: cats.slice(),
    reasons: reasons.slice(),
    reason: reasons.join('；'),
    risk: risk,
    scanned_size: size,
    scanned_mtime: mtimeNs
  };
}

function cleanCandidateFromRow(row, opts) {
  opts = opts || {};
  var home = opts.home || '';
  var nowMs = opts.nowMs || Date.now();
  if (!row || row.is_dir || row.missing) return null;
  var p = String(row.path || '');
  if (cleanProtect(p, home)) return null;
  if (!cleanAllowedRoot(p, home)) return null;
  if (cleanIsRecent(row.mtime_ns, nowMs, FF_CLEAN_RECENT_DAYS)) return null;
  var cats = [], reasons = [];
  var lr = cleanLargeReason(row, FF_CLEAN_LARGE);
  if (lr) { cats.push('large'); reasons.push(lr); }
  var ur = cleanUnusedReason(row, nowMs, FF_CLEAN_UNUSED_DAYS);
  if (ur) { cats.push('unused'); reasons.push(ur); }
  var ir = cleanInstallerReason(row, home, nowMs, FF_CLEAN_INSTALLER_DAYS);
  if (ir) { cats.push('installer'); reasons.push(ir); }
  if (!cats.length) return null;
  return makeCandidate(row, cats, reasons, opts);
}

function cleanCandidatesFromRows(rows, opts) {
  var out = [];
  for (var i = 0; i < (rows || []).length; i++) {
    var c = cleanCandidateFromRow(rows[i], opts);
    if (c) out.push(c);
  }
  var merged = cleanMergeCandidates(out);
  merged.sort(function (a, b) { return b.size - a.size; });
  if (merged.length > FF_CLEAN_MAX) merged = merged.slice(0, FF_CLEAN_MAX);
  return merged;
}

function cleanKeepOf(group) {
  if (!group || !group.length) return '';
  var arr = group.slice();
  arr.sort(function (a, b) {
    var am = BigInt(String(a.mtime_ns || '0'));
    var bm = BigInt(String(b.mtime_ns || '0'));
    if (am !== bm) return am < bm ? -1 : 1;
    var al = String(a.path || '').length, bl = String(b.path || '').length;
    if (al !== bl) return al - bl;
    var as = String(a.path || '').indexOf('/Volumes') === 0 ? 1 : 0;
    var bs = String(b.path || '').indexOf('/Volumes') === 0 ? 1 : 0;
    return as - bs;
  });
  return arr[0].path;
}

function cleanDuplicateCandidates(rows, opts) {
  opts = opts || {};
  var home = opts.home || '';
  var nowMs = opts.nowMs || Date.now();
  var buckets = {}, order = [], i, j, k;
  for (i = 0; i < (rows || []).length; i++) {
    var r = rows[i];
    if (!r || r.is_dir || r.missing) continue;
    var h = String(r.hash_full || '');
    if (!h || r.hash_state !== 'full') continue;
    var key = String(r.size || 0) + ':' + h;
    if (!buckets[key]) { buckets[key] = []; order.push(key); }
    buckets[key].push(r);
  }
  var out = [];
  for (k = 0; k < order.length; k++) {
    var g = buckets[order[k]];
    if (g.length < 2) continue;
    var keep = cleanKeepOf(g);
    for (j = 0; j < g.length; j++) {
      var r2 = g[j];
      if (r2.path === keep) continue;
      var p = String(r2.path || '');
      if (cleanProtect(p, home) || !cleanAllowedRoot(p, home)) continue;
      if (cleanIsRecent(r2.mtime_ns, nowMs, FF_CLEAN_RECENT_DAYS)) continue;
      var base = cleanCandidateFromRow(r2, opts);
      var cats = ['duplicate'].concat(base ? base.categories : []);
      var reasons = ['重复副本（同内容已有建议保留的一份）'].concat(base ? base.reasons : []);
      var seen = {}, cats2 = [];
      for (var x = 0; x < cats.length; x++) if (!seen[cats[x]]) { seen[cats[x]] = 1; cats2.push(cats[x]); }
      var c = makeCandidate(r2, cats2, reasons, opts);
      c.groupSize = g.length;
      c.keep = keep;
      out.push(c);
    }
  }
  return cleanMergeCandidates(out);
}

function cleanDedupeByHash(list) {
  var hashCount = {}, pathCount = {}, i, h;
  for (i = 0; i < (list || []).length; i++) {
    h = String(list[i].hash_full || '');
    if (h) hashCount[h] = (hashCount[h] || 0) + 1;
    else pathCount[String(list[i].path)] = (pathCount[String(list[i].path)] || 0) + 1;
  }
  var seenHash = {}, seenPath = {}, items = [], dropped = 0;
  for (i = 0; i < (list || []).length; i++) {
    var it = list[i];
    h = String(it.hash_full || '');
    if (h) {
      if (seenHash[h]) { dropped++; continue; }
      seenHash[h] = 1;
      items.push(Object.assign({}, it, { groupSize: hashCount[h] }));
    } else {
      var pk = String(it.path);
      if (seenPath[pk]) { dropped++; continue; }
      seenPath[pk] = 1;
      items.push(Object.assign({}, it, { groupSize: 1 }));
    }
  }
  return { items: items, dropped: dropped };
}

function cleanMergeCandidates(list) {
  var byPath = {}, order = [], i, j, k;
  for (i = 0; i < (list || []).length; i++) {
    var c = list[i];
    var p = c.path;
    if (!byPath[p]) {
      var t = Object.assign({}, c);
      t.categories = (c.categories || [c.category]).slice();
      t.reasons = (c.reasons || [c.reason]).slice();
      byPath[p] = t;
      order.push(p);
    } else {
      var e = byPath[p];
      var cs = c.categories || [c.category];
      for (j = 0; j < cs.length; j++) if (e.categories.indexOf(cs[j]) < 0) e.categories.push(cs[j]);
      var rs = c.reasons || [c.reason];
      for (j = 0; j < rs.length; j++) if (e.reasons.indexOf(rs[j]) < 0) e.reasons.push(rs[j]);
    }
  }
  var out = [];
  for (k = 0; k < order.length; k++) {
    var f = byPath[order[k]];
    var cat = 'unused';
    for (var m = 0; m < FF_CLEAN_PRIORITY.length; m++) {
      if (f.categories.indexOf(FF_CLEAN_PRIORITY[m]) >= 0) { cat = FF_CLEAN_PRIORITY[m]; break; }
    }
    f.category = cat;
    f.reason = f.reasons.join('；');
    out.push(f);
  }
  return out;
}

function cleanStale(c, current) {
  if (!current) return { stale: true, reason: '无法读取当前文件状态，请重新扫描' };
  var sizeOk = Number(c && c.scanned_size) === Number(current.size);
  var mOk = String(c && c.scanned_mtime) === String(current.mtimeNs);
  if (sizeOk && mOk) return { stale: false, reason: '' };
  return { stale: true, reason: '文件在扫描后发生变化，请重新扫描后再执行' };
}

function cleanCheckMap(items) {
  var m = {};
  for (var i = 0; i < (items || []).length; i++) m[items[i].id] = false;
  return m;
}

function cleanScanStamp(st) {
  if (!st) return { size: 0, mtimeNs: '0' };
  var size = Number(st.size || 0);
  var mtimeNs;
  try {
    mtimeNs = String(st.mtimeNs || BigInt(Math.floor(st.mtimeMs || (st.mtime && st.mtime.getTime()) || 0) * 1e6));
  } catch (e) { mtimeNs = '0'; }
  return { size: size, mtimeNs: mtimeNs };
}

function cleanSummary(list) {
  var s = { count: 0, bytes: 0, byCategory: {} };
  for (var i = 0; i < (list || []).length; i++) {
    var x = list[i], sz = Number(x.size || 0), cat = x.category || 'unused';
    s.count++; s.bytes += sz;
    if (!s.byCategory[cat]) s.byCategory[cat] = { count: 0, bytes: 0 };
    s.byCategory[cat].count++;
    s.byCategory[cat].bytes += sz;
  }
  return s;
}

// FlowFile Client 样式 · 第 19 轮 Tahoe 26（m09330「开始实施」）
// 视觉真源：/Volumes/Iris-Data/文件管理系统/docs/design/FLOWFINDER-COMPLETE-UIUX-SYSTEM-V4.html
//   ink 十一阶中性 + accent #007aff 单一强调 + 语义色 ok/warn/danger + SF Pro Text/Mono + spring 曲线
// 八 skill 审查基线：frontend-design / apple-design / emil-design-eng / web-design-guidelines / mobile-native
// 结构（三栏 / 6 tab / 底部 dock / 可拖分隔条）一行未动，只换皮肤与密度。
// 工程约束：纯脚本（无模板字符串、无 JSX），可被 scripts/build.mjs 直接拼接。
var FD_CSS = [
  // ---- 基础 / token ----
  '.fd-root{',
  // 第 14 轮 A 纸面（m07126）：暖白纸面 + 灰墨字 + 赤陶 accent，层级靠字号与字重，不靠边框
  // 第 19 轮 Tahoe 26：全域语义 token（对齐 docs/design/FLOWFINDER-COMPLETE-UIUX-SYSTEM-V4.html）
  '--fd-bg:#ffffff;--fd-panel:#f7f8fb;--fd-line:#e4e7ef;--fd-line2:#eff1f6;',
  '--fd-ink:#14161b;--fd-ink2:#6b7284;--fd-ink3:#8e96a8;--fd-accent:#007aff;--fd-accent-hover:#0062cc;--fd-accent-soft:rgba(0,122,255,.13);--fd-chip:#ffffff;--fd-sel:rgba(0,122,255,.10);--fd-ok:#248a3d;--fd-warn:#c96900;--fd-err:#d93025;--fd-hover:rgba(15,23,42,.04);--fd-card:#ffffff;',
  '--fd-row-h:30px;--fd-radius:9px;--fd-ease:cubic-bezier(0.16,1,0.3,1);',
  // 可调布局（m06434 → 第 13 轮 v4）：左树宽 / 右栏宽 / 底部对话 dock 高，拖分隔条改的就是这三个值
  '--fd-tree-w:210px;--fd-right-w:380px;--fd-dock-h:300px;',
  'color-scheme:light dark;',
  'display:flex;flex-direction:column;height:100%;min-height:0;',
  'background:var(--fd-bg);color:var(--fd-ink);',
  'font:12.5px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Helvetica Neue",sans-serif;',
  '--fd-font-mono:ui-monospace,"SF Mono",Menlo,monospace;',
  'overflow:hidden;-webkit-tap-highlight-color:transparent;overscroll-behavior:contain}',
  '.fd-root *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}',
  // 第 19 轮 Tahoe 26：深色主题（跟随系统）。语义阶整体反转，强调蓝提亮到 #3898ff。
  '@media (prefers-color-scheme:dark){',
  '.fd-root{--fd-bg:#1b1f2b;--fd-panel:#222733;--fd-line:rgba(255,255,255,.11);--fd-line2:rgba(255,255,255,.06);',
  '--fd-ink:#f2f4f9;--fd-ink2:#aab2c4;--fd-ink3:#7d8598;--fd-accent:#3898ff;--fd-accent-hover:#5aa9ff;--fd-accent-soft:rgba(56,152,255,.20);--fd-chip:rgba(255,255,255,.06);--fd-sel:rgba(56,152,255,.18);',
  '--fd-ok:#32d74b;--fd-warn:#ff9f0a;--fd-err:#ff453a;--fd-hover:rgba(255,255,255,.06);--fd-card:#252a37;background:var(--fd-bg);color:var(--fd-ink)}',
  '}',
  '.fd-root button,.fd-root input,.fd-root select{font:inherit;touch-action:manipulation}',
  // 全局焦点环：只给键盘，不给鼠标
  '.fd-root :focus-visible{outline:2px solid var(--fd-accent);outline-offset:2px;border-radius:4px}',
  // 第 19 轮：UI 线性图标（替字符占位）
  '.fd-ui-ico{flex:0 0 auto;display:block;vertical-align:middle}',
  '.fd-btn.fd-ico-btn .fd-ui-ico{pointer-events:none}',
  // ---- 顶栏（第 13 轮 v4：品牌 + 导航合并成一行，面包屑与标签筛选落到第二行）----
  '.fd-topbar{display:flex;align-items:center;gap:10px;padding:9px 16px;border-bottom:1px solid var(--fd-line);flex:0 0 auto;flex-wrap:nowrap;min-width:0;background:var(--fd-bg)}',
  // A 纸面：顶栏按钮不是按钮，是文字动作（无边框、无底色，悬停才显形）
  '.fd-topbar .fd-btn{border-color:transparent;background:transparent;color:var(--fd-ink2);padding:4px 7px;font-size:11.5px;border-radius:7px}',
  '.fd-topbar .fd-btn:hover{border-color:transparent;background:var(--fd-hover);color:var(--fd-ink)}',
  '.fd-topbar .fd-btn.primary{border-color:transparent;background:transparent;color:var(--fd-accent);font-weight:600}',
  '.fd-brand{display:flex;align-items:center;gap:7px;flex:0 0 auto}',
  '.fd-subbar{display:flex;align-items:center;gap:10px;padding:0 16px 7px;border:0;background:var(--fd-bg);flex:0 0 auto;min-height:24px;min-width:0}',
  '.fd-subbar .fd-crumbs{flex:1 1 auto}',
  '.fd-subbar .fd-tags{flex:0 0 auto;padding:0 !important;flex-wrap:nowrap;overflow-x:auto;max-width:60%}',
  '.fd-title{font:700 13px/1.2 -apple-system,BlinkMacSystemFont,"SF Pro Display","PingFang SC",sans-serif;letter-spacing:-.01em;white-space:nowrap;color:var(--fd-ink)}',
  '.fd-badge{font-size:9.5px;font-weight:600;color:var(--fd-accent);background:var(--fd-accent-soft);border:1px solid rgba(0,122,255,.22);border-radius:5px;padding:1px 6px;white-space:nowrap;letter-spacing:.02em}',
  '.fd-crumbs{display:flex;align-items:center;gap:2px;flex:1;min-width:120px;overflow:hidden;white-space:nowrap}',
  '.fd-crumb{background:none;border:0;color:var(--fd-ink2);cursor:pointer;padding:2px 5px;border-radius:4px;font-size:12px;transition:color 120ms ease-out}',
  '.fd-crumb.is-on{color:var(--fd-ink);font-weight:600}',
  '.fd-sep{color:#c2c8d6}',
  // ---- 按钮 / 输入：按压即时反馈，禁 transition:all ----
  '.fd-btn{background:var(--fd-chip);border:1px solid var(--fd-line);color:var(--fd-ink);border-radius:7px;padding:4px 10px;font-size:11.5px;font-weight:500;cursor:pointer;white-space:nowrap;transition:transform 100ms ease-out,border-color 120ms ease-out,background-color 120ms ease-out,color 120ms ease-out}',
  '.fd-btn:active{transform:scale(.97)}',
  '.fd-btn:disabled{opacity:.4;cursor:default;transform:none}',
  '.fd-btn.fd-ico-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:5px 8px}',
  '.fd-btn.primary{background:var(--fd-accent);border-color:var(--fd-accent);color:#ffffff;font-weight:600}',
  '.fd-btn.primary:hover{background:var(--fd-accent-hover);border-color:var(--fd-accent-hover)}',
  '.fd-search,.fd-chat-input input,.fd-ask input{background:var(--fd-bg);border:1px solid var(--fd-line);color:var(--fd-ink);border-radius:7px;padding:6px 10px;outline:none;transition:border-color 160ms ease-out,box-shadow 160ms ease-out}',
  '.fd-search{width:150px;background:transparent;border:0;border-bottom:1px solid transparent;border-radius:0;padding:4px 2px;font-size:12px}',
  '.fd-search:focus{background:transparent;border-bottom-color:var(--fd-accent);box-shadow:none}',
  '.fd-search:focus,.fd-chat-input input:focus,.fd-ask input:focus{border-color:var(--fd-accent);box-shadow:0 0 0 3px var(--fd-accent-soft)}',
  '.fd-root input::placeholder{color:var(--fd-ink3)}',
  '.fd-model{background:var(--fd-bg);border:1px solid var(--fd-line);color:var(--fd-ink2);border-radius:6px;padding:3px 8px;font-size:11px;max-width:220px;cursor:pointer}',
  '.fd-model:focus-visible{outline:2px solid var(--fd-accent);outline-offset:2px}',
  // hover 只给精确指针设备，键盘动作零动画
  '@media(hover:hover) and (pointer:fine){',
  '.fd-btn:hover{border-color:rgba(128,128,128,.28);background:#f3f5f9}',
  '.fd-crumb:hover{background:var(--fd-chip);color:var(--fd-ink)}',
  '.fd-vol:hover{background:var(--fd-chip);color:var(--fd-ink)}',
  '.fd-tab:hover{background:var(--fd-chip);color:var(--fd-ink)}',
  '.fd-row:hover{background:var(--fd-hover)}',
  '.fd-chat-h:hover{background:rgba(0,122,255,.05)}',
  '}',
  // ---- 主体三栏 ----
  '.fd-body{display:flex;flex:1;min-height:0}',
  '.fd-rail{width:186px;flex:0 0 186px;border-right:1px solid var(--fd-line2);padding:10px 8px;overflow:auto;background:rgba(247,248,251,.72)}',
  '@media (prefers-color-scheme:dark){.fd-rail{background:rgba(255,255,255,.03)}}',
  '.fd-rail-h{font-size:10.5px;color:var(--fd-ink2);text-transform:uppercase;letter-spacing:1.2px;padding:2px 8px 10px}',
  '.fd-vol{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:none;border:0;color:var(--fd-ink2);padding:7px 8px;border-radius:7px;cursor:pointer;font:inherit;margin-bottom:2px;transition:color 160ms ease-out,background 160ms ease-out}',
  '.fd-vol.is-on{background:var(--fd-accent-soft);color:var(--fd-accent);font-weight:600}',
  '.fd-vol-tag{margin-left:auto;flex-shrink:0;font-size:9.5px;color:var(--fd-ok);border:1px solid rgba(36,138,61,.30);border-radius:4px;padding:0 5px;letter-spacing:.3px}',
  '.fd-vol-tag.local{color:var(--fd-ink2);border-color:var(--fd-line)}',
  '.fd-vol > svg{flex-shrink:0}',
  '.fd-vol-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  // ---- 甲方案：能力 tab 条（导航行下） + 右侧覆盖抽屉 ----
  '.fd-nav-tabs{display:flex;gap:2px;padding:4px 12px;border-bottom:1px solid var(--fd-line2);background:transparent;flex:0 0 auto;overflow-x:auto}',
  '.fd-nav-tab{border:0;background:transparent;padding:5px 12px;border-radius:7px;font-size:12px;color:var(--fd-ink2);cursor:pointer;white-space:nowrap;transition:background 140ms ease-out,color 140ms ease-out}',
  '.fd-nav-tab:hover{background:rgba(0,122,255,.10);color:var(--fd-ink)}',
  '.fd-nav-tab.is-on{background:rgba(0,122,255,.15);color:var(--fd-accent);font-weight:600}',
  '.fd-drawer{position:absolute;top:0;right:0;bottom:0;width:360px;max-width:80%;background:var(--fd-bg);border-left:1px solid var(--fd-line);box-shadow:-10px 0 28px rgba(28,32,48,.10);display:flex;flex-direction:column;z-index:6;overflow:hidden}',
  '.fd-drawer-h{display:flex;align-items:center;gap:8px;padding:9px 14px;border-bottom:1px solid var(--fd-line);font-weight:600;font-size:12.5px;color:var(--fd-ink);flex:0 0 auto}',
  '.fd-drawer-x{margin-left:auto;border:0;background:transparent;color:var(--fd-ink2);font-size:15px;cursor:pointer;padding:2px 6px;border-radius:6px}',
  '.fd-drawer-x:hover{background:rgba(0,122,255,.10);color:var(--fd-ink)}',
  '.fd-drawer-body{flex:1;min-height:0;overflow:auto}',
  '.fd-center{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden}',
  // ---- 第 7 轮 VSCode 式布局：左树 / 中多标签 / 右预览+操作+AI ----
  '.fd-tree{width:var(--fd-tree-w);flex:0 0 var(--fd-tree-w);border-right:1px solid var(--fd-line2);background:var(--fd-bg);overflow:auto;padding:10px 8px 12px;min-width:0}',
  '.fd-tree-h{font-size:9.5px;font-weight:600;color:var(--fd-ink3);letter-spacing:.06em;padding:0 8px 6px}',
  '.fd-tree-node{display:flex;align-items:center;gap:6px;width:100%;text-align:left;background:none;border:0;color:var(--fd-ink);font-size:12px;padding:5px 8px;border-radius:6px;line-height:1.35;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background-color 120ms ease-out,color 120ms ease-out}',
  '.fd-tree-node:hover{background:var(--fd-hover)}',
  '.fd-tree-node.is-on{background:var(--fd-accent-soft);color:var(--fd-accent);font-weight:600}',
  '.fd-tree-node .tw{flex:0 0 12px;font-size:9px;color:var(--fd-ink2);text-align:center}',
  '.fd-tree-kids{padding-left:12px}',
  '.fd-tabbar{display:flex;align-items:stretch;gap:0;border-bottom:1px solid var(--fd-line);background:var(--fd-panel);flex:0 0 auto;overflow-x:auto}',
  '.fd-tab{display:flex;align-items:center;gap:6px;padding:7px 12px;border-right:1px solid var(--fd-line);background:none;border-top:0;border-bottom:2px solid transparent;color:var(--fd-ink2);font-size:12px;cursor:pointer;max-width:200px;min-width:0}',
  '.fd-tab.is-on{border-bottom-color:var(--fd-accent);color:var(--fd-ink);background:var(--fd-bg);font-weight:600}',
  '.fd-tab .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.fd-tab .x{opacity:.55;font-size:12px;padding:0 1px;border:0;background:none;color:inherit;cursor:pointer}',
  '.fd-tab .x:hover{opacity:1}',
  '.fd-right{width:var(--fd-right-w);flex:0 0 var(--fd-right-w);border-left:1px solid var(--fd-line2);background:var(--fd-bg);display:flex;flex-direction:column;overflow:hidden;min-width:0}',
  '.fd-right-top{flex:1 1 auto;min-height:0;overflow:auto;padding:20px 24px 20px 22px;contain:content}',
  '.fd-right-h{font-size:10.5px;color:var(--fd-ink2);letter-spacing:.05em;margin-bottom:6px}',
  // ---- 可调布局（m06434）：竖分隔条（树|中 / 中|右）与横分隔条（预览|AI）----
  '.fd-splitter{flex:0 0 6px;width:6px;cursor:col-resize;background:transparent;position:relative;z-index:3;transition:background 120ms ease-out}',
  '.fd-splitter:hover,.fd-splitter.is-drag{background:rgba(0,122,255,.24)}',
  '.fd-splitter:before{content:"";position:absolute;left:2px;top:0;bottom:0;width:1px;background:var(--fd-line)}',
  '.fd-root[data-dragging]{user-select:none}',
  // ---- 第 13 轮 v4：底部全宽对话 dock（替代原右栏 fd-aidock）----
  '.fd-dock{flex:0 0 auto;height:var(--fd-dock-h);max-height:70%;display:flex;flex-direction:column;border-top:1px solid var(--fd-line);background:var(--fd-bg);min-height:44px}',
  '.fd-dock.is-folded{height:auto;max-height:none}',
  '.fd-dock-grip{flex:0 0 6px;height:6px;cursor:row-resize;position:relative;background:transparent;transition:background 120ms ease-out}',
  '.fd-dock-grip:hover{background:rgba(0,122,255,.24)}',
  '.fd-dock-grip:before{content:"";position:absolute;top:2px;left:0;right:0;height:1px;background:var(--fd-line)}',
  '.fd-dock-h{display:flex;align-items:center;gap:9px;padding:2px 24px 6px;flex:0 0 auto;font-size:12px;min-width:0}',
  '.fd-dock-h .fd-btn{width:22px;height:20px;padding:0;min-width:0;font-size:11px;line-height:1}',
  '.fd-dock-h b{font-size:12.5px;white-space:nowrap}',
  '.fd-dock-note{margin-left:auto;font-size:10.5px;color:var(--fd-ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}',
  '.fd-dock-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}',
  '.fd-dock-body .fd-chat-log{flex:1 1 auto;overflow:auto;padding:8px 24px;min-height:0;overscroll-behavior:contain;display:flex;flex-direction:column;gap:6px}',
  '.fd-dock-plan{flex:0 0 auto;max-height:40%;overflow:auto;padding:0 12px}',
  '.fd-dock-in{display:flex;gap:10px;align-items:center;padding:10px 24px 14px;border-top:0;flex:0 0 auto}',
  // A 纸面：发送键是实心圆，不是带边框的按钮
  '.fd-dock-send{width:30px;height:30px;flex:0 0 30px;border-radius:50%;border:0;background:var(--fd-accent);color:#fff;font-size:13px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform 100ms ease-out,opacity 120ms ease-out,background-color 120ms ease-out}',
  '.fd-dock-send:active{transform:scale(.94)}',
  '.fd-dock-send:disabled{opacity:.35;transform:none}',
  '.fd-dock-in input{flex:1;min-width:0;background:rgba(15,23,42,.035);border:1px solid transparent;color:var(--fd-ink);border-radius:999px;padding:7px 14px;outline:none;font-size:12.5px}',
  '.fd-dock-in input:focus{border-color:var(--fd-accent);box-shadow:0 0 0 3px var(--fd-accent-soft);background:var(--fd-bg)}',
  '.fd-dock-body .fd-bubble{max-width:min(760px,76%)}',
  '.fd-dock-body .fd-bubble.user{margin-left:auto}',
  '.fd-chat-msg{font-size:12px;line-height:1.55;color:var(--fd-ink)}',
  '.fd-chat-msg.me{color:var(--fd-ink2)}',
  // ---- 预览区补充块（m06434）：智能识别摘要 + 变更时间线，在 manage 下也显示 ----
  '.fd-preview-more{padding-top:12px;margin-top:12px;border-top:1px solid var(--fd-line)}',
  '.fd-preview-h{font-size:9.5px;color:var(--fd-ink3);font-weight:600;letter-spacing:.06em;margin:0 0 7px}',
  '.fd-prev-line{font-size:12.5px;color:var(--fd-ink);margin-bottom:6px}',
  '.fd-prev-empty{font-size:11.5px;color:var(--fd-ink2);padding:2px 0}',
  '.fd-prev-tl{display:flex;flex-direction:column;gap:3px}',
  '.fd-prev-tl-row{display:flex;gap:8px;align-items:baseline;font-size:11.5px;color:var(--fd-ink2)}',
  '.fd-prev-tl-time{flex:0 0 auto;color:var(--fd-ink2);font-variant-numeric:tabular-nums}',
  '.fd-prev-tl-kind{flex:1;min-width:0;color:var(--fd-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '@media(max-width:900px){.fd-right{display:none}.fd-right-off{display:block}}',
  '.fd-table{flex:1;overflow:auto;overscroll-behavior:contain;padding:2px 14px 10px}',
  // ---- 文件表：无逐行硬线；sticky 表头渐隐；选中 inset accent 线 ----
  '.fd-row{display:grid;grid-template-columns:minmax(0,1fr) 84px 124px 132px;gap:14px;align-items:center;padding:0 10px;height:var(--fd-row-h);cursor:pointer}',
  // A 纸面：行间用 1px 发丝线（inset 阴影，不占盒模型），整屏只剩一层极淡的横向节奏
  '.fd-row + .fd-row{box-shadow:inset 0 1px 0 var(--fd-line2)}',
  '.fd-row.is-on{background:var(--fd-accent-soft);box-shadow:inset 2px 0 0 var(--fd-accent)}',
  '.fd-head{position:sticky;top:0;background:var(--fd-bg);color:var(--fd-ink3);font-size:10px;font-weight:600;letter-spacing:.06em;cursor:default;z-index:1;border-bottom:1px solid var(--fd-line);height:24px;box-shadow:none}',
  '.fd-name{display:flex;align-items:center;gap:9px;min-width:0;overflow:hidden}',
  '.fd-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:12.5px;font-weight:500;color:var(--fd-ink);text-wrap:balance}',
  '.fd-ico{width:22px;height:22px;flex:0 0 22px;border-radius:6px;display:flex;align-items:center;justify-content:center;padding:3px;background:var(--fd-panel);border:1px solid var(--fd-line)}',
  '.fd-ico{flex-shrink:0}.fd-ico.k-folder{fill:#eef0ff}',
  '.fd-num{color:var(--fd-ink3);font-family:var(--fd-font-mono);font-variant-numeric:tabular-nums;text-align:right;font-size:10.5px}',
  '.fd-time{color:var(--fd-ink3);font-family:var(--fd-font-mono);font-variant-numeric:tabular-nums;text-align:right;font-size:10.5px}',
  '.fd-tags{display:flex;gap:4px;flex-wrap:wrap}',
  // 标签：柔和底 + 细描边 + 文字，色不单载信息
  '.fd-chip{font-size:9.5px;font-weight:600;border-radius:8px;padding:1px 6px;white-space:nowrap;border:1px solid;letter-spacing:0;text-transform:none}',
  '.fd-chip.warm{color:var(--fd-warn);background:rgba(201,105,0,.09);border-color:rgba(201,105,0,.18)}',
  '.fd-chip.cool{color:var(--fd-accent);background:var(--fd-accent-soft);border-color:rgba(0,122,255,.18)}',
  '.fd-chip.neutral{color:var(--fd-ink2);background:var(--fd-chip);border-color:var(--fd-line)}',
  // ---- 右栏：黄底警告框降级为普通说明 ----
  // （旧 .fd-right 214px 规则已删除：与上方 VSCode 式 .fd-right 340px 冲突）
  '.fd-right h4,.fd-aside h4{margin:0 0 10px;font:600 12px/1.35 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif;color:var(--fd-ink);letter-spacing:-.01em}',
  '.fd-aside{padding:0 0 10px}',
  '.fd-kv{display:flex;justify-content:space-between;gap:12px;padding:3px 0;border:0;font-size:11.5px;line-height:1.7}',
  '.fd-kv span:first-child{color:var(--fd-ink3);flex:0 0 auto;font-size:10.5px}',
  '.fd-kv span:last-child{text-align:right;word-break:break-all;min-width:0}',
  '.fd-note{margin-top:12px;font-size:11px;line-height:1.65;color:var(--fd-ink2);padding:0;border:0;background:none}',
  '.fd-note.callout{background:var(--fd-bg);border:1px solid var(--fd-line);border-radius:var(--fd-radius);padding:9px 11px}',
  '.fd-actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}',
  // ---- tab / panel ----
  '.fd-tabs{display:flex;gap:3px;padding:7px 12px;border-top:1px solid var(--fd-line);background:var(--fd-panel);flex:0 0 auto;flex-wrap:wrap}',
  '.fd-tab{background:transparent;border:1px solid transparent;color:var(--fd-ink2);border-radius:7px;padding:4px 12px;cursor:pointer;white-space:nowrap;transition:color 160ms ease-out,background 160ms ease-out}',
  '.fd-tab.is-on{background:var(--fd-accent-soft);border-color:rgba(0,122,255,.18);color:var(--fd-accent);font-weight:600}',
  '.fd-panel{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:16px 20px 24px}',
  '.fd-cap-panel > .fd-panel{padding:16px 20px 24px}',
  '.fd-panel-h{display:flex;align-items:center;gap:10px;margin:0 0 12px;font-size:13.5px;font-weight:600;letter-spacing:-.015em;color:var(--fd-ink)}',
  '.fd-panel-h .fd-btn{padding:3px 9px;font-size:12px}',
  '.fd-card{background:var(--fd-card,#fff);border:1px solid var(--fd-line);border-radius:10px;padding:13px 15px;margin-bottom:10px;box-shadow:0 1px 2px rgba(15,23,42,.04),0 0 0 .5px rgba(0,0,0,.02)}',
  '.fd-card h4{margin:0 0 8px;font-size:12.5px;font-weight:600;color:var(--fd-ink);letter-spacing:-.01em}',
  '.fd-card p{margin:4px 0;color:var(--fd-ink2);font-size:11.5px;line-height:1.6}',
  '.fd-card b{color:var(--fd-ink)}',
  '.fd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}',
  '.fd-dup-item{display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--fd-line2);font-size:11.5px}',
  '.fd-dup-item:last-child{border-bottom:0}',
  '.fd-dup-item:last-child{border-bottom:0}',
  '.fd-dup-item .fd-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fd-ink2)}',
  '.fd-keep{color:var(--fd-ok);font-size:10px;font-weight:600;white-space:nowrap;background:rgba(36,138,61,.10);border-radius:6px;padding:1px 6px}',
  '.fd-weak{color:var(--fd-warn);font-size:10px;font-weight:600;white-space:nowrap;background:rgba(201,105,0,.10);border-radius:6px;padding:1px 6px}',
  // ---- 消息 / 空态 / 骨架屏 / 错误（六态里的加载与空态给下一步）----
  '.fd-msg{display:flex;flex-direction:column;align-items:center;gap:10px;color:var(--fd-ink2);padding:30px 20px;text-align:center;font-size:12px;line-height:1.7;max-width:520px;margin:0 auto}',
  '.fd-msg-ico{color:var(--fd-ink3);opacity:.85}',
  '.fd-err{color:var(--fd-err);font-size:11.5px}',
  '.fd-skeleton{height:var(--fd-row-h);border-radius:6px;background:linear-gradient(90deg,var(--fd-panel) 25%,#e9ecf3 50%,var(--fd-panel) 75%);background-size:200% 100%;animation:fd-shimmer 1.4s ease-out infinite;opacity:.6;margin:2px 14px}',
  '@keyframes fd-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}',
  '.fd-empty{display:flex;flex-direction:column;align-items:center;gap:9px;padding:40px 16px;color:var(--fd-ink2);font-size:12px;line-height:1.7}',
  '.fd-empty .fd-ui-ico{color:var(--fd-ink3)}',
  '.fd-empty b{color:var(--fd-ink);font-size:13px}',
  // ---- 对话抽屉 ----
  '.fd-chat{flex:0 0 auto;border-top:1px solid var(--fd-line);background:var(--fd-panel);display:flex;flex-direction:column;max-height:280px}',
  '.fd-chat-h{display:flex;align-items:center;gap:8px;padding:7px 14px;cursor:pointer;font-size:11.5px;color:var(--fd-ink2);transition:background 160ms ease-out}',
  '.fd-chat-h b{color:var(--fd-ink);font-weight:600}',
  '.fd-chat-log{flex:1;overflow:auto;padding:6px 12px;min-height:0;overscroll-behavior:contain}',
  '.fd-bubble{max-width:88%;margin:5px 0;padding:8px 13px;border-radius:10px;font-size:12.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;transform-origin:var(--transform-origin,center bottom);animation:fd-pop 200ms var(--fd-ease)}',
  '@keyframes fd-pop{from{opacity:0;transform:scale(.95)}to{opacity:1;transform:scale(1)}}',
  '.fd-bubble.user{background:var(--fd-accent-soft);border:1px solid rgba(0,122,255,.18);color:var(--fd-ink);margin-left:auto}',
  '.fd-bubble.ai{background:var(--fd-sel);border:1px solid transparent;color:var(--fd-ink)}',
  '.fd-chat-input{display:flex;gap:8px;padding:8px 12px;border-top:1px solid var(--fd-line)}',
  '.fd-chat-input input{flex:1;min-width:0}',
  // ---- 计划卡片 / 进度 ----
  '.fd-planbox{border:1px solid var(--fd-line);border-radius:10px;padding:12px 14px;margin:8px 0;background:var(--fd-card,#fff);box-shadow:0 1px 2px rgba(15,23,42,.04)}',
  '.fd-planbox h4{margin:0 0 6px;font-size:12px}',
  '.fd-check{display:flex;gap:9px;align-items:flex-start;padding:5px 0;font-size:11.5px;line-height:1.55}',
  '.fd-check input{margin-top:3px}',
  '.fd-check span{flex:1;min-width:0;word-break:break-all}',
  '.fd-progress{height:5px;background:rgba(15,23,42,.08);border-radius:3px;overflow:hidden;margin:7px 0}',
  '.fd-progress > i{display:block;height:100%;background:var(--fd-accent);transition:width 200ms ease-out}',
  '.fd-evidence{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}',
  '.fd-evidence{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}',
  '.fd-evidence span{background:rgba(15,23,42,.035);border:1px solid var(--fd-line2);border-radius:6px;padding:2px 7px;font-size:10.5px;color:var(--fd-ink2)}',
  '.fd-timeline-item{display:grid;grid-template-columns:132px minmax(0,1fr) auto;gap:12px;padding:7px 0;border-bottom:1px solid var(--fd-line2);font-size:11.5px;align-items:baseline}',
  '.fd-timeline-item > span:nth-child(2){min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fd-ink)}',
  '.fd-timeline-item > span:last-child{justify-self:end}',
  '.fd-timeline-item:last-child{border-bottom:0}',
  '.fd-timeline-time{color:var(--fd-ink3);white-space:nowrap;font-family:var(--fd-font-mono);font-variant-numeric:tabular-nums;font-size:10.5px}',
  '.fd-badge.ok{color:var(--fd-ok);background:rgba(36,138,61,.10);border-color:rgba(36,138,61,.24)}',
  '.fd-badge.warn{color:var(--fd-warn);background:rgba(168,100,26,.08);border-color:rgba(201,105,0,.2)}',
  // ---- 减弱动效：保留 opacity，去掉一切位移/缩放 ----
  '@media(prefers-reduced-motion:reduce){',
  '.fd-root *,.fd-root *::before,.fd-root *::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}',
  '.fd-btn:active{transform:none}',
  '.fd-bubble{animation:none;transform:none}',
  '.fd-skeleton{animation:none;opacity:.4}',
  '}',
  // ---- 窄屏：右栏让位，列精简（头与行同构，隐藏第 4 列即可对齐，不留隐式行）----
  '@media(max-width:900px){',
  '.fd-right{display:none}',
  '.fd-row{grid-template-columns:minmax(0,1fr) 80px 104px}',
  '.fd-row > *:nth-child(4){display:none}',
  '}',
  // ---- 第 15 轮（m07306 ①②）：折叠轨 + 预设条 + 作用域标注 ----
  // ---- 第 16 轮（m07634）：预览区顺序 缩略图 → 智能识别 → 时间线 → 属性 ----
  // ---- 第 17 轮（m07721）：树内标签栏 + 设置面板 ----
  // ---- 第 17 轮：能力 tab 条（v4 重排时丢过入口，这里补回）+ 中栏面板 ----
  '.fd-caps{display:flex;gap:4px;flex-wrap:wrap;padding:0}',
  '.fd-cap{border:0;background:transparent;color:var(--fd-ink2);font-family:inherit;font-size:11.5px;font-weight:500;padding:3px 9px;border-radius:999px;cursor:pointer;transition:background-color 120ms ease-out,color 120ms ease-out}',
  '.fd-cap:hover{background:var(--fd-hover,rgba(0,0,0,.04));color:var(--fd-ink)}',
  '.fd-cap.is-on{background:var(--fd-accent-soft);color:var(--fd-accent);font-weight:600}',
  '.fd-cap-panel{flex:1;overflow:auto;padding:16px 24px;min-width:0}',
  // 第 18 轮 A 方案：subbar 单行不换行，消除错位（右侧 crumb 允许收缩省略）
  '.fd-subbar{display:flex;align-items:center;gap:14px;flex-wrap:nowrap;min-width:0}',
  '.fd-subbar .fd-crumbs{flex:1;min-width:0;overflow:hidden;white-space:nowrap}',
  '.fd-tree{display:flex;flex-direction:column}',
  '.fd-tree-tags{margin-top:14px;padding:10px 0 2px;border-top:1px solid var(--fd-line2)}',
  '.fd-tree-tags .fd-tree-tags-h{font-size:10px;letter-spacing:.14em;color:#b0a99c;text-transform:uppercase;padding:0 4px 6px}',
  '.fd-tree-tags .fd-tags{display:flex;flex-wrap:wrap;gap:5px;padding:0}',
  '.fd-settings{padding:4px 0 24px;max-width:660px}',
  '.fd-settings h4{font-size:13px;font-weight:600;letter-spacing:-.01em;margin:14px 0 8px;color:var(--fd-ink)}',
  '.fd-settings-note{font-size:11.5px;color:var(--fd-ink2);line-height:1.7;margin:0 0 14px}',
  '.fd-field{display:flex;flex-direction:column;gap:6px;margin:0 0 14px}',
  '.fd-field > label{font-size:11px;font-weight:600;color:var(--fd-ink2);letter-spacing:0}',
  '.fd-field input,.fd-field select{font-family:inherit;font-size:12.5px;padding:7px 10px;border:1px solid var(--fd-line);border-radius:7px;background:var(--fd-bg);color:var(--fd-ink);max-width:420px;transition:border-color 120ms ease-out,box-shadow 120ms ease-out}',
  '.fd-field input:focus-visible,.fd-field select:focus-visible{outline:2px solid var(--fd-accent);outline-offset:1px}',
  '.fd-field-hint{font-size:10.5px;color:var(--fd-ink3);line-height:1.5}',
  '.fd-settings-danger{margin:6px 0 10px;color:#8a3b26;font-size:12.5px;line-height:1.65}',
  '.fd-settings-warn{font-size:11.5px;color:var(--fd-warn);background:rgba(201,105,0,.07);border-left:2px solid var(--fd-warn);border-radius:0 6px 6px 0;padding:8px 10px;margin:8px 0 10px;line-height:1.65}',
  '.fd-settings-state{font-size:11.5px;color:var(--fd-ink2);margin:0 0 4px}',
  '.fd-auto-tags{display:flex;flex-wrap:wrap;gap:5px;margin:6px 0 0}',
  '.fd-auto-tags .fd-chip{border-style:dashed}',
  '.fd-prev-thumb{margin:0 0 14px;border:1px solid var(--fd-line2);border-radius:8px;background:var(--fd-panel);overflow:hidden;display:flex;align-items:center;justify-content:center;min-height:96px;max-height:220px}',
  '.fd-prev-img{display:block;width:100%;height:auto;max-height:220px;object-fit:contain}',
  '.fd-prev-thumb-ph{display:flex;flex-direction:column;align-items:center;gap:8px;padding:22px 10px;color:#b0a99c;font-size:11.5px;text-align:center}',
  '.fd-prev-sec{margin:0 0 14px}',
  '.fd-tree-h{display:flex;align-items:center;justify-content:space-between;gap:8px}',
  '.fd-tree-fold{border:0;background:transparent;color:var(--fd-ink2);font-size:11px;cursor:pointer;padding:0 4px;border-radius:4px;line-height:1}',
  '.fd-tree-fold:hover{color:var(--fd-accent)}',
  '.fd-tree-rail,.fd-right-rail{flex:0 0 auto;width:30px;display:flex;flex-direction:column;align-items:center;gap:10px;padding:12px 0;background:var(--fd-panel);border-right:1px solid var(--fd-line2);cursor:pointer;user-select:none}',
  '.fd-right-rail{border-right:0;border-left:1px solid var(--fd-line2)}',
  '.fd-tree-rail:hover,.fd-right-rail:hover{background:var(--fd-sel)}',
  '.fd-rail-btn{width:22px;height:22px;border:0;background:transparent;color:var(--fd-ink2);font-size:12px;cursor:pointer;border-radius:4px}',
  '.fd-rail-txt{writing-mode:vertical-rl;letter-spacing:.18em;font-size:11px;color:var(--fd-ink2)}',
  '.fd-right-h{display:flex;align-items:center;justify-content:space-between;padding:0 0 8px}',
  '.fd-right-h span{font-size:11px;letter-spacing:.14em;color:#b0a99c;text-transform:uppercase}',
  '.fd-preset{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:7px 24px 3px}',
  '.fd-preset-h{font-size:11px;letter-spacing:.14em;color:#b0a99c;text-transform:uppercase;margin-right:2px}',
  '.fd-preset-chip{border:1px solid var(--fd-line);background:var(--fd-panel);color:var(--fd-ink);font-size:12px;padding:3px 10px;border-radius:999px;cursor:pointer;font-family:inherit}',
  '.fd-preset-chip:hover{border-color:var(--fd-accent);color:var(--fd-accent)}',
  '.fd-preset-chip:disabled{opacity:.5;cursor:default}',
  '.fd-preset-note{font-size:11px;color:#b0a99c;margin-left:auto}',
  '.fd-dock-scope{font-size:11px;color:var(--fd-ink2);max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.fd-plan-scope{font-size:11.5px;color:var(--fd-ink2);margin:0 0 6px}',
  '@media(max-width:1100px){.fd-preset{padding:6px 14px 2px}.fd-preset-note{display:none}}',
  '.fd-root[data-compact=on] .fd-right{display:none}',
  '.fd-root[data-compact=on] .fd-search{max-width:110px}',
  '.fd-root[data-compact=on] .fd-dock-note{display:none}',
  '.fd-root[data-compact=on] .fd-row{grid-template-columns:minmax(0,1fr) 76px 104px}',
  '.fd-root[data-compact=on] .fd-row > *:nth-child(4){display:none}',
  // 极窄 / 200% 缩放后的等效视口：只留名称 + 大小两列，仍不横向滚动。
  '@media(max-width:560px){',
  '.fd-rail{width:112px;flex:0 0 112px;padding:10px 6px}',
  '.fd-row{grid-template-columns:minmax(0,1fr) 68px;gap:6px;padding:0 8px}',
  '.fd-row > *:nth-child(3),.fd-row > *:nth-child(4){display:none}',
  '.fd-skeleton{margin:2px 8px}',
  '.fd-chat-h > span{white-space:nowrap}',
  '.fd-chat-h .fd-note{display:none}',
  '.fd-chat-h .fd-model{max-width:120px;min-width:0}',
  '.fd-vol{padding:7px 5px;gap:5px}',
  '}',
  // ---- 第 2 轮 ② P0：导航行 / 地址栏 / 列面板 ----
  '.fd-nav{display:flex;align-items:center;gap:6px;padding:0;border:0;background:transparent;flex:1 1 auto;min-width:0;flex-wrap:nowrap}',
  '.fd-btn.fd-nav{padding:4px 10px;font-size:14px;line-height:1.1;min-width:30px;text-align:center}',
  // A 纸面：地址栏不是输入框而是「当前页标题」——衬线大字、无边框、无底色，聚焦时才显形
  '.fd-root .fd-addr{flex:1;min-width:160px;max-width:560px;background:rgba(15,23,42,.03);border:1px solid transparent;color:var(--fd-ink);border-radius:7px;padding:3px 9px;outline:none;font-family:inherit;font-size:13px;font-weight:600;line-height:1.35;letter-spacing:-.01em;transition:border-color 120ms ease-out,background-color 120ms ease-out}',
  '.fd-root .fd-addr:focus{border-color:var(--fd-accent);background:var(--fd-bg)}',
  '.fd-root .fd-addr::placeholder{color:var(--fd-ink3);font-size:13px}',
  '.fd-nav-sep{width:1px;height:18px;background:var(--fd-line);margin:0 3px}',
  '.fd-popover{position:absolute;z-index:40;background:var(--fd-panel);border:1px solid var(--fd-line);border-radius:var(--fd-radius);box-shadow:0 14px 38px rgba(0,0,0,.5);padding:10px 12px}',
  '.fd-col-panel{top:96px;right:16px;width:220px}',
  '.fd-pop-h{font-size:11px;color:var(--fd-ink2);font-weight:600;letter-spacing:.5px;margin-bottom:8px;text-transform:uppercase}',
  '.fd-col-row{display:flex;align-items:center;gap:8px;padding:5px 0;font-size:12px}',
  '.fd-col-row > span{flex:1;min-width:0}',
  '.fd-col-w{width:64px;background:var(--fd-bg);border:1px solid var(--fd-line);color:var(--fd-ink);border-radius:5px;padding:3px 6px;font-size:11px}',
  // ---- 可排序表头 ----
  '.fd-th{background:none;border:0;color:inherit;font:inherit;text-align:left;cursor:pointer;padding:0;letter-spacing:inherit}',
  '.fd-th.is-sorted{color:var(--fd-ink);font-weight:600}',
  '.fd-num.fd-th,.fd-time.fd-th{text-align:right}',
  '.fd-row.is-cut{opacity:.5;text-decoration:line-through}',
  // ---- 网格视图 + 真实缩略图 ----
  '.fd-grid-view{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:12px;padding:14px;overflow:auto;flex:1}',
  '.fd-tile{border:1px solid var(--fd-line);border-radius:9px;background:var(--fd-card,#fff);padding:8px;cursor:pointer;display:flex;flex-direction:column;gap:7px;transition:border-color 120ms ease-out,transform 120ms var(--fd-ease),box-shadow 120ms ease-out}',
  '.fd-tile:hover{border-color:rgba(0,122,255,.35);box-shadow:0 2px 8px rgba(15,23,42,.07)}',
  '.fd-tile.is-on{border-color:var(--fd-accent);box-shadow:inset 0 0 0 1px var(--fd-accent)}',
  '.fd-tile:active{transform:scale(.97)}',
  '.fd-thumb{aspect-ratio:1;background:var(--fd-panel);border-radius:7px;display:flex;align-items:center;justify-content:center;overflow:hidden;color:var(--fd-ink2)}',
  '.fd-thumb-img{width:100%;height:100%;object-fit:contain}',
  '.fd-thumb-ph{font-size:18px;opacity:.5}',
  '.fd-thumb .fd-ico{width:40px;height:40px;flex:0 0 40px;font-size:15px}',
  '.fd-tile-name{font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
  '.fd-tile-sub{font-size:10.5px;color:var(--fd-ink2);font-variant-numeric:tabular-nums}',
  // ---- 右键菜单 ----
  '@media (prefers-color-scheme:dark){.fd-context-menu{background:rgba(38,43,56,.96);border-color:rgba(255,255,255,.14)}}',
  '.fd-context-menu{position:fixed;z-index:60;min-width:190px;background:rgba(255,255,255,.96);-webkit-backdrop-filter:blur(22px) saturate(180%);backdrop-filter:blur(22px) saturate(180%);border:1px solid rgba(255,255,255,.85);border-radius:11px;box-shadow:0 12px 34px rgba(15,23,42,.20),0 0 0 .5px rgba(0,0,0,.09);padding:5px;display:flex;flex-direction:column}',
  '.fd-menu-item{background:none;border:0;color:var(--fd-ink);text-align:left;padding:5px 10px;border-radius:6px;font:inherit;cursor:pointer;font-size:11.5px}',
  '.fd-menu-item:hover:not(:disabled){background:var(--fd-accent-soft);color:var(--fd-accent)}',
  '.fd-menu-item:disabled{opacity:.35;cursor:default}',
  '.fd-menu-item.danger:not(:disabled){color:var(--fd-err)}',
  '.fd-menu-sep{height:1px;background:var(--fd-line);margin:4px 2px}',
  // ---- 状态栏（六态）----
  '.fd-status{display:flex;align-items:center;gap:8px;padding:4px 16px;border-top:1px solid var(--fd-line2);border-bottom:0;background:var(--fd-bg);font-size:10.5px;color:var(--fd-ink3);flex:0 0 auto;min-height:24px}',
  '.fd-status-dot{width:7px;height:7px;border-radius:50%;flex:0 0 7px;background:var(--fd-ok)}',
  '.fd-status-dot.info{background:var(--fd-accent)}.fd-status-dot.warning{background:var(--fd-warn)}.fd-status-dot.error{background:var(--fd-err)}.fd-status-dot.ok{background:var(--fd-ok)}',
  '.fd-status-text{font-variant-numeric:tabular-nums;white-space:nowrap}',
  '.fd-status-badge{font-size:9.5px;font-weight:600;border-radius:6px;padding:1px 6px;border:1px solid}',
  '.fd-status-badge.info{color:var(--fd-accent);border-color:rgba(0,122,255,.30)}.fd-status-badge.warning{color:var(--fd-warn);border-color:rgba(201,105,0,.3)}.fd-status-badge.error{color:var(--fd-err);border-color:rgba(217,48,37,.3)}.fd-status-badge.ok{color:var(--fd-ok);border-color:rgba(36,138,61,.32)}',
  '.fd-status-hint{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
  '.fd-status-sp{flex:1}',
  '.fd-status-view{font-size:10px;color:var(--fd-ink2);white-space:nowrap}',
  // ---- 侧栏分区 ----
  '.fd-rail-new{padding:10px 8px}',
  '.fd-side-sec{display:flex;flex-direction:column;gap:1px;margin-bottom:6px}',
  '.fd-side-item{display:flex;align-items:center;gap:7px;width:100%;text-align:left;background:none;border:0;color:var(--fd-ink2);padding:5px 7px;border-radius:6px;cursor:pointer;font:inherit;min-width:0}',
  '.fd-side-item.is-on{background:var(--fd-accent-soft);color:var(--fd-accent);font-weight:600}',
  '.fd-side-ico{flex:0 0 14px;text-align:center;font-size:11px;color:var(--fd-ink2)}',
  '.fd-side-svg{flex:0 0 15px;display:block}',
  '.fd-side-item{display:flex;align-items:center;gap:7px}',
  '.fd-side-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px}',
  '.fd-side-x{opacity:.5;font-size:13px;padding:0 2px;flex:0 0 auto}',
  '.fd-side-hint{font-size:10.5px;color:#a3aab9;padding:4px 7px;line-height:1.5}',
  '.fd-tag-dot{width:11px;height:11px;border-radius:50%;flex:0 0 11px;display:inline-block;border:1px solid rgba(0,0,0,.15)}',
  '.fd-tag-dot.sm{width:8px;height:8px;flex:0 0 8px}',
  '.fd-cap{padding:9px 7px;border-top:1px solid var(--fd-line);margin-top:4px}',
  '.fd-cap-h{font-size:10.5px;color:var(--fd-ink2);font-variant-numeric:tabular-nums;margin-bottom:5px}',
  // ---- 弹窗 / 冲突三选 / 输入 / QuickLook / Toast ----
  '.fd-modal-mask{position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:20px}',
  '@media (prefers-color-scheme:dark){.fd-modal{background:rgba(35,40,52,.97);border-color:rgba(255,255,255,.14)}}',
  '.fd-modal{background:rgba(252,253,255,.97);-webkit-backdrop-filter:blur(30px) saturate(180%);backdrop-filter:blur(30px) saturate(180%);border:1px solid rgba(255,255,255,.9);border-radius:14px;box-shadow:0 24px 70px rgba(15,23,42,.28),0 0 0 .5px rgba(0,0,0,.10);padding:18px;width:min(440px,92vw);max-height:86vh;overflow:auto;animation:fd-pop 200ms var(--fd-ease)}',
  '.fd-modal-sm{width:min(340px,92vw)}',
  '.fd-modal h4{margin:0 0 12px;font-size:14px}',
  '.fd-modal-list{max-height:150px;overflow:auto;margin-bottom:12px;border:1px solid var(--fd-line);border-radius:7px}',
  '.fd-modal-list .fd-kv{padding:5px 10px}',
  '.fd-modal-input{width:100%;background:var(--fd-bg);border:1px solid var(--fd-line);color:var(--fd-ink);border-radius:7px;padding:8px 10px;outline:none;font-size:12.5px;transition:border-color 120ms ease-out,box-shadow 120ms ease-out}',
  '.fd-modal-input:focus{border-color:var(--fd-accent);box-shadow:0 0 0 3px var(--fd-accent-soft)}',
  '.fd-choice-list{display:flex;flex-direction:column;gap:8px}',
  '.fd-choice{display:flex;flex-direction:column;gap:4px;text-align:left;background:var(--fd-card,#fff);border:1px solid var(--fd-line);border-radius:9px;padding:10px 13px;color:var(--fd-ink);cursor:pointer;font:inherit;transition:border-color 120ms ease-out,transform 120ms var(--fd-ease)}',
  '.fd-choice:hover{border-color:var(--fd-accent)}',
  '.fd-choice:active{transform:scale(.98)}',
  '.fd-choice b{font-size:12.5px}.fd-choice span{font-size:11px;color:var(--fd-ink2)}',
  '.fd-tag-editor{margin-top:12px;border-top:1px solid var(--fd-line);padding-top:10px}',
  '.fd-tag-palette{display:flex;gap:5px;margin-bottom:9px}',
  '.fd-tag-list{display:flex;flex-wrap:wrap;gap:5px;max-height:110px;overflow:auto;margin-bottom:9px}',
  '.fd-tag-opt{display:flex;align-items:center;gap:5px;background:var(--fd-card,#fff);border:1px solid var(--fd-line);border-radius:7px;padding:3px 8px;color:var(--fd-ink2);font-size:10.5px;cursor:pointer;transition:border-color 120ms ease-out,color 120ms ease-out}',
  '.fd-tag-opt.is-on{border-color:var(--fd-accent);color:var(--fd-accent);background:var(--fd-accent-soft)}',
  '.fd-tag-new{display:flex;gap:6px}',
  '.fd-tag-new input{flex:1;min-width:0;background:var(--fd-bg);border:1px solid var(--fd-line);color:var(--fd-ink);border-radius:6px;padding:5px 8px;outline:none}',
  '.fd-ql-mask{z-index:80}',
  '@media (prefers-color-scheme:dark){.fd-ql{background:rgba(35,40,52,.97);border-color:rgba(255,255,255,.14)}}',
  '.fd-ql{width:min(720px,92vw);max-height:88vh;background:var(--fd-panel);border:1px solid var(--fd-line);border-radius:12px;display:flex;flex-direction:column;overflow:hidden;animation:fd-pop 200ms var(--fd-ease)}',
  '.fd-ql-h{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;border-bottom:1px solid var(--fd-line);font-size:13px}',
  '.fd-ql-body{flex:1;min-height:240px;display:flex;align-items:center;justify-content:center;background:var(--fd-bg);padding:20px;overflow:auto}',
  '.fd-ql-img{max-width:100%;max-height:60vh;object-fit:contain}',
  '.fd-ql-ph .fd-ico{width:72px;height:72px;flex:0 0 72px;font-size:24px}',
  '.fd-ql-meta{display:flex;gap:14px;padding:10px 14px;border-top:1px solid var(--fd-line);font-size:11px;color:var(--fd-ink2);font-variant-numeric:tabular-nums}',
  '@media (prefers-color-scheme:dark){.fd-toast{background:rgba(38,43,56,.96);border-color:rgba(255,255,255,.14)}}',
  '.fd-toast{position:fixed;z-index:90;left:50%;bottom:26px;transform:translateX(-50%);background:rgba(252,253,255,.96);-webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%);border:1px solid rgba(255,255,255,.9);border-radius:10px;padding:9px 16px;font-size:11.5px;color:var(--fd-ink);box-shadow:0 12px 36px rgba(15,23,42,.20),0 0 0 .5px rgba(0,0,0,.09);animation:fd-pop 200ms var(--fd-ease);max-width:80vw}',
  '.fd-toast.error{border-color:rgba(217,48,37,.5);color:var(--fd-err)}.fd-toast.warning{border-color:rgba(201,105,0,.5);color:var(--fd-warn)}',
  // ---- 减弱动效/窄屏：新组件同样遵守 ----
  '@media(prefers-reduced-motion:reduce){.fd-modal,.fd-ql,.fd-toast{animation:none}.fd-tile:active,.fd-choice:active,.fd-btn.fd-nav:active{transform:none}}',
  '@media(max-width:560px){.fd-nav{gap:4px;padding:6px 8px}.fd-addr{min-width:110px}.fd-col-panel{right:8px;top:130px}.fd-grid-view{grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px;padding:8px}.fd-status-hint{display:none}.fd-toast{bottom:14px;font-size:11px}}',
  // ---- 第 18 轮 A 方案：右栏「任务历史 + 对话 + 折叠预览」三段常驻 ----
  '.fd-right .fd-rail-tasks{flex:0 1 auto;max-height:32%;min-height:92px;display:flex;flex-direction:column;border-bottom:1px solid var(--fd-line2);min-width:0}',
  '.fd-rail-tasks-h{display:flex;align-items:center;gap:8px;padding:8px 12px 6px;font-size:11.5px;font-weight:600;color:var(--fd-ink)}',
  '.fd-rail-tasks-h .fd-rail-num{background:var(--fd-accent);color:#fff;border-radius:999px;padding:0 6px;font-size:9.5px;font-weight:600;line-height:15px;min-width:15px;text-align:center}',
  '.fd-rail-tasks-h .fd-btn{margin-left:auto;width:20px;height:20px;padding:0;min-width:0;font-size:11px;line-height:1}',
  '.fd-rail-tasks-body{flex:1 1 auto;overflow:auto;min-height:0;padding:0 12px 8px;overscroll-behavior:contain}',
  '.fd-taskrow{padding:6px 8px;border:1px solid var(--fd-line);border-radius:7px;margin-bottom:5px;font-size:10.5px;background:var(--fd-card,#fff);min-width:0}',
  '.fd-taskrow b{color:var(--fd-ink);font-weight:600;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}',
  '.fd-taskrow .fd-btn .fd-ui-ico{opacity:.72}',
  '.fd-taskrow .fd-task-ok{color:var(--fd-ok)}.fd-taskrow .fd-task-und{color:var(--fd-warn)}',
  '.fd-taskrow .fd-task-meta{color:var(--fd-ink2);font-size:10px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.fd-taskrow .fd-btn{border:0;background:transparent;color:var(--fd-ink2);font-size:10px;cursor:pointer;padding:2px 4px}',
  '.fd-taskrow .fd-btn:hover{color:var(--fd-accent)}',
  '.fd-rail-empty{font-size:11px;color:var(--fd-ink2);padding:8px 4px;line-height:1.6}',
  '.fd-rail-preview{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;border-bottom:1px solid var(--fd-line2);min-width:0;overflow:hidden}',
  '.fd-rail-preview .fd-right-h{padding:6px 12px}',
  '.fd-rail-preview-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:10px 12px;min-width:0}',
  '.fd-right .fd-dock{height:auto;max-height:none;flex:0 1 auto;min-height:136px;border-top:0;border-bottom:1px solid var(--fd-line2)}',
  '.fd-right .fd-dock .fd-dock-grip{display:none}',
  '.fd-right .fd-dock .fd-dock-h{padding:6px 12px}',
  '.fd-right .fd-dock .fd-dock-note{display:none}',
  '.fd-right .fd-dock .fd-dock-scope{max-width:100%;flex:1}',
  '.fd-right .fd-dock .fd-chat-log{padding:8px 12px;gap:5px}',
  '.fd-right .fd-dock .fd-bubble{max-width:94%;font-size:12px;line-height:1.55;padding:6px 10px;margin:4px 0}',
  '.fd-right .fd-dock .fd-dock-plan{max-height:32%}',
  '.fd-right .fd-dock .fd-dock-in{padding:8px 12px 10px;gap:6px}',
  '.fd-right .fd-dock .fd-dock-in input{font-size:12px;padding:8px 12px}',
  '.fd-right .fd-dock .fd-preset{padding:6px 12px;gap:5px;flex-wrap:wrap}',
  '.fd-right .fd-dock .fd-preset-chip{font-size:10.5px;padding:3px 8px}',
].join('')

// FlowFile · Tahoe 26 结构层样式（第 20 轮 m09643「侧边栏进入的还是旧版」）
// 真源：flowfile/docs/flowfile-design-tahoe.html（用户已确认的确认门产物）
// 与 client-style.js 的分工：那份是旧的 v4 骨架 + 面板皮肤，这份是新的骨架层。
// 全部选择器以 .fd-root 作用域前缀，类名沿用设计稿原名（sidebar/pane/row/dock…），
// 与旧 fd-* 类名零冲突，因此两套样式可共存，面板（查重/相似/设置）先继续吃旧皮肤。
var FD_TAHOE = [
'/* ===== token（对齐设计稿 :root） ===== */',
'.fd-root{',
'--ink-900:#14161b;--ink-800:#222630;--ink-700:#363b47;--ink-600:#4e5565;--ink-500:#6b7284;--ink-400:#667085;--ink-350:#8e96a8;--ink-300:#b4bccb;--ink-200:#d5dae4;--ink-150:#e4e7ef;--ink-100:#eff1f6;--ink-50:#f7f8fb;--ink-0:#fff;',
  // 第 25 轮设计审查：ink-400 原为 #8e96a8，在 #fff 上只有 2.97:1，225 个文字节点里 92 个吃它（41%）——
  // 全部小字都低于 WCAG AA 4.5:1。文字阶改 #667085（4.97:1，且在 #f7f8fb/#eff1f6 上也达标），
  // 原 #8e96a8 降级为 --ink-350，只许给非文字（分割线、禁用图标、骨架屏）用。
  '--t-meta:11px;--t-body:12px;--t-title:13px;--t-display:15px;',
  '--r-chip:4px;--r-ctl:6px;--r-card:8px;--r-pane:12px;--r-dock:21px;',
'--accent:#0071e3;--accent-hover:#005ecb;--accent-soft:rgba(0,113,227,.13);--accent-mid:rgba(0,113,227,.24);--accent-ring:rgba(0,113,227,.62);',
  // accent 原 #007aff：白字压在它上面只有 4.02:1，它自己当文字压在白底上也是 4.02:1——两头都不达标。
  // 换成 #0071e3（白字 4.70:1 / 当文字 4.70:1），一处改动同时修好「填充上的白字」与「强调色文字」。',
'--ok:#248a3d;--ok-bg:rgba(52,199,89,.14);--warn:#c96900;--warn-bg:rgba(255,149,0,.15);--danger:#d93025;--danger-bg:rgba(255,59,48,.14);--purple:#6e5ce6;--purple-bg:rgba(110,92,230,.14);',
'--win-canvas:radial-gradient(900px 500px at 12% 4%,rgba(10,132,255,.16),transparent 60%),radial-gradient(900px 500px at 88% 96%,rgba(110,92,230,.13),transparent 60%),#dfe3ec;',
'--side-glass:linear-gradient(180deg,rgba(255,255,255,.72) 0%,rgba(255,255,255,.46) 100%);',
'--side-border:rgba(255,255,255,.72);--top-glass:linear-gradient(180deg,rgba(255,255,255,.64) 0%,rgba(255,255,255,.38) 100%);',
'--card-bg:#fff;--card-sub:#fafbfd;--card-line:#eef0f5;--card-shadow:0 10px 26px rgba(18,28,55,.08),0 0 0 .5px rgba(0,0,0,.08);',
'--card-focus-shadow:0 0 0 1.5px var(--accent),0 14px 34px var(--accent-soft);',
'--dock-glass:linear-gradient(180deg,rgba(255,255,255,.92),rgba(255,255,255,.74));--dock-border:rgba(255,255,255,.9);',
'--dock-shadow:0 14px 36px rgba(15,23,42,.16),0 0 0 .5px rgba(0,0,0,.09),inset 0 1px 0 rgba(255,255,255,.98);',
'--font-sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Helvetica Neue",sans-serif;',
'--font-display:-apple-system,BlinkMacSystemFont,"SF Pro Display","PingFang SC",sans-serif;',
'--font-mono:ui-monospace,"SF Mono",Menlo,monospace;',
'--spring:cubic-bezier(.32,1.35,.62,1);--ease-out:cubic-bezier(.16,1,.3,1);--fd-row-h:30px;',
'background:var(--win-canvas);color:var(--ink-900);font-family:var(--font-sans);font-size:12.5px;',
'display:flex;flex-direction:column;min-height:0;overflow:hidden;position:relative}',
'.fd-root[data-density="compact"]{--fd-row-h:26px}',
'.fd-root[data-density="cozy"]{--fd-row-h:34px}',
'@media (prefers-color-scheme:dark){',
'.fd-root{--ink-900:#f5f7fb;--ink-800:#e6e9f2;--ink-700:#cfd5e3;--ink-600:#aeb6c8;--ink-500:#8b94a8;--ink-400:#959db0;--ink-350:#687084;--ink-300:#495062;--ink-200:#353b49;--ink-150:#2b303c;--ink-100:#30374a;--ink-50:#252b3a;--ink-0:#1b1f2b;',
'--accent:#4a9fff;--accent-hover:#6fb6ff;--accent-soft:rgba(74,159,255,.22);--accent-mid:rgba(74,159,255,.35);',
'--ok:#32d74b;--warn:#ff9f0a;--danger:#ff453a;--purple:#a78bfa;',
'--win-canvas:radial-gradient(900px 500px at 12% 4%,rgba(10,132,255,.16),transparent 60%),radial-gradient(900px 500px at 88% 96%,rgba(110,92,230,.14),transparent 60%),#121724;',
'--side-glass:linear-gradient(180deg,rgba(34,38,50,.72),rgba(24,27,38,.5));--side-border:rgba(255,255,255,.09);',
'--top-glass:linear-gradient(180deg,rgba(32,36,48,.66),rgba(26,29,39,.44));',
'--card-bg:#262b3a;--card-sub:#2e3446;--card-line:rgba(255,255,255,.12);--card-shadow:0 14px 34px rgba(0,0,0,.48),0 0 0 .5px rgba(255,255,255,.08);',
'--card-focus-shadow:0 0 0 1.5px #3898ff,0 16px 38px rgba(0,0,0,.62);',
'--dock-glass:linear-gradient(180deg,rgba(44,49,62,.9),rgba(32,36,46,.76));--dock-border:rgba(255,255,255,.16);',
'--dock-shadow:0 16px 42px rgba(0,0,0,.58),0 0 0 .5px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.18)}}',
'/* ===== 骨架 ===== */',
'.fd-root .desk{flex:1;min-height:0;display:flex;flex-direction:column}',
'.fd-root .desk-inner{flex:1;min-height:0;display:flex;padding:8px;gap:0}',
'/* ===== 玻璃侧栏 ===== */',
'.fd-root .sidebar{width:222px;flex:0 0 222px;background:var(--side-glass);-webkit-backdrop-filter:blur(26px) saturate(180%);backdrop-filter:blur(26px) saturate(180%);border:1px solid var(--side-border);border-radius:13px 0 0 13px;padding:10px 9px 11px;display:flex;flex-direction:column;gap:1px;overflow:hidden;box-shadow:var(--card-shadow)}',
'.fd-root .sb-brand{display:flex;align-items:center;justify-content:space-between;padding:1px 7px 8px;flex:0 0 auto}',
'.fd-root .sb-name{font-family:var(--font-display);font-size:15px;font-weight:800;letter-spacing:-.02em;background:linear-gradient(90deg,#007aff,#6e5ce6 60%,#ff5f7e);-webkit-background-clip:text;background-clip:text;color:transparent}',
'.fd-root .sb-tag{font-size:9px;font-family:var(--font-mono);padding:2px 5px;border-radius:4px;background:var(--accent-soft);color:var(--accent);font-weight:700}',
'.fd-root .sb-scroll{flex:1;min-height:0;overflow-y:auto;padding-right:2px;display:flex;flex-direction:column;overscroll-behavior:contain}',
'.fd-root .sb-group{font-size:10px;font-weight:700;color:var(--ink-400);padding:11px 8px 4px;letter-spacing:.06em;text-transform:uppercase;flex:0 0 auto}',
'.fd-root .vol-card{padding:6px 8px 7px;border-radius:8px;cursor:default;transition:background .12s;flex:0 0 auto}',
'.fd-root .vol-card:hover{background:rgba(128,128,128,.1)}',
'.fd-root .vol-card.on{background:rgba(255,255,255,.72);box-shadow:0 1px 3px rgba(0,0,0,.06)}',
'@media (prefers-color-scheme:dark){.fd-root .vol-card.on{background:rgba(255,255,255,.12)}}',
'.fd-root .vol-l1{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;color:var(--ink-800)}',
'.fd-root .vol-l2{font-size:9.5px;color:var(--ink-400);margin:3px 0 5px 26px;display:flex;justify-content:space-between;gap:6px}',
'.fd-root .vol-meter{height:3px;border-radius:2px;background:rgba(128,128,128,.2);margin-left:26px;overflow:hidden}',
'.fd-root .vol-meter i{display:block;height:100%;background:var(--accent);border-radius:2px}',
'.fd-root .sb-row{height:29px;padding:0 8px;border-radius:7px;font-size:12.5px;color:var(--ink-800);display:flex;align-items:center;gap:8px;cursor:default;transition:background .12s;flex:0 0 auto;border:0;background:transparent;width:100%;text-align:left}',
'.fd-root .sb-row:hover{background:rgba(128,128,128,.1)}',
'.fd-root .sb-row.on{background:rgba(255,255,255,.74);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.05)}',
'@media (prefers-color-scheme:dark){.fd-root .sb-row.on{background:rgba(255,255,255,.13)}}',
'.fd-root .sb-row .cnt{margin-left:auto;font-size:10.5px;color:var(--ink-400);font-family:var(--font-mono)}',
'.fd-root .sb-ico{width:19px;height:19px;border-radius:5px;flex:0 0 19px;display:grid;place-items:center}',
'.fd-root .sb-ico svg{width:11.5px;height:11.5px;stroke:currentColor;fill:none;stroke-width:1.8}',
'.fd-root .ic-blue{background:rgba(0,122,255,.15);color:#007aff}',
'.fd-root .ic-indigo{background:rgba(94,92,230,.16);color:#5e5ce6}',
'.fd-root .ic-green{background:rgba(52,199,89,.17);color:#248a3d}',
'.fd-root .ic-orange{background:rgba(255,149,0,.17);color:#c96900}',
'.fd-root .ic-rose{background:rgba(255,45,85,.14);color:#d70015}',
'.fd-root .ic-slate{background:rgba(120,130,148,.16);color:var(--ink-600)}',
'.fd-root .tagsec{padding:8px 8px 4px;border-top:1px solid rgba(128,128,128,.14);margin-top:6px;flex:0 0 auto}',
'.fd-root .tagsec .lbl{font-size:9.5px;font-weight:700;color:var(--ink-400);padding-bottom:6px;letter-spacing:.05em}',
'.fd-root .tagchip{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 7px;border-radius:10px;font-size:10px;font-weight:600;color:var(--ink-700);background:rgba(255,255,255,.6);border:1px solid rgba(128,128,128,.16);margin:0 4px 5px 0;cursor:default}',
'@media (prefers-color-scheme:dark){.fd-root .tagchip{background:rgba(255,255,255,.07)}}',
'.fd-root .tagchip.on{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}',
'.fd-root .tagchip i{width:6px;height:6px;border-radius:50%}',
'.fd-root .sb-ws{padding-top:8px;border-top:1px solid rgba(128,128,128,.15);flex:0 0 auto}',
'.fd-root .sb-ws .t{font-size:9.5px;font-weight:700;color:var(--ink-400);padding:0 8px 5px}',
'.fd-root .tool-item{height:29px;padding:0 8px;border-radius:7px;display:flex;align-items:center;gap:9px;font-size:11.5px;color:var(--ink-700);cursor:default;transition:background .12s;border:0;background:transparent;width:100%;text-align:left}',
'.fd-root .tool-item:hover{background:rgba(128,128,128,.1)}',
'.fd-root .tool-item.on{background:var(--accent-soft);color:var(--accent);font-weight:600}',
'.fd-root .tool-item svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:1.7;flex:0 0 auto}',
'.fd-root .tool-item .badge{margin-left:auto;font-family:var(--font-mono);font-size:9.5px;color:var(--ink-400)}',
'/* ===== 目录树 v2（第 24 轮重写） ===== */',
'/* 旧树的问题：整行单击既导航又展开、没有独立折叠箭头、没有缩进引导线、不记忆展开状态、',
'   当前路径不会自动展开，24px 行高在 222px 侧栏里只有图标与截断名。',
'   新实现：caret 独立可点（导航与折叠分离）+ 缩进引导线 + 展开态持久化 + 当前项自动 reveal。 */',
'.fd-root .tree-wrap{flex:0 1 auto;min-height:120px;max-height:44%;overflow-y:auto;overscroll-behavior:contain;padding:0 2px 2px}',
'.fd-root .tree-wrap .fd-tree-h{display:flex;align-items:center;gap:6px;font-size:9.5px;font-weight:700;color:var(--ink-400);padding:11px 6px 5px;letter-spacing:.06em;text-transform:uppercase;position:sticky;top:0;background:var(--side-glass);z-index:2}',
'.fd-root .tree-wrap .fd-tree-h .cnt{margin-left:auto;font-family:var(--font-mono);font-size:9px;color:var(--ink-300)}',
'.fd-root .tree-wrap .fd-tree-fold{border:0;background:transparent;color:var(--ink-400);cursor:default;display:grid;place-items:center;padding:2px;border-radius:4px}',
'.fd-root .tree-wrap .fd-tree-fold:hover{background:rgba(128,128,128,.14);color:var(--ink-600)}',
'.fd-root .tn-row{display:flex;align-items:center;gap:3px;width:100%;height:25px;border:0;background:transparent;color:var(--ink-700);font:inherit;font-size:11.5px;border-radius:6px;cursor:default;text-align:left;padding-right:8px;position:relative}',
'.fd-root .tn-row:hover{background:rgba(128,128,128,.10)}',
'.fd-root .tn-row.is-on{background:var(--accent-soft);color:var(--accent);font-weight:600}',
'.fd-root .tn-row.is-on .tn-name{color:var(--accent)}',
'.fd-root .tn-caret{width:14px;height:14px;flex:0 0 14px;display:grid;place-items:center;border:0;background:transparent;color:var(--ink-400);cursor:default;border-radius:3px;padding:0}',
'.fd-root .tn-caret:hover{background:rgba(128,128,128,.18);color:var(--ink-700)}',
'.fd-root .tn-caret.leaf{visibility:hidden}',
'.fd-root .tn-caret svg{width:10px;height:10px;stroke:currentColor;fill:none;stroke-width:2.2;transition:transform .14s var(--ease-out)}',
'.fd-root .tn-caret.open svg{transform:rotate(90deg)}',
'.fd-root .tn-dot{width:14px;height:14px;flex:0 0 14px;display:grid;place-items:center}',
'.fd-root .tn-ico{width:15px;height:15px;flex:0 0 15px;display:grid;place-items:center;color:var(--accent)}',
'.fd-root .tn-ico.smb{color:#2a9d8f}',
'.fd-root .tn-ico svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:1.8}',
'.fd-root .tn-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.fd-root .tn-kids{position:relative}',
'.fd-root .tn-kids:before{content:"";position:absolute;left:var(--tn-guide,18px);top:0;bottom:2px;width:1px;background:rgba(128,128,128,.20)}',
'@media (prefers-color-scheme:dark){.fd-root .tn-kids:before{background:rgba(255,255,255,.14)}}',
'.fd-root .tn-empty{font-size:10px;color:var(--ink-400);padding:2px 0 4px 30px}',
'.fd-root .tn-load{width:14px;height:14px;flex:0 0 14px;display:grid;place-items:center;color:var(--ink-300)}',
'.fd-root .tn-load i{width:8px;height:8px;border-radius:50%;border:1.5px solid var(--ink-300);border-top-color:transparent;animation:tnspin .7s linear infinite;display:block}',
'@keyframes tnspin{to{transform:rotate(360deg)}}',
'/* ===== 主壳 ===== */',
'.fd-root .main{flex:1;min-width:0;display:flex;flex-direction:column;position:relative;background:var(--card-bg);border:1px solid var(--card-line);border-left:0;border-radius:0 13px 13px 0;overflow:hidden}',
'.fd-root .coord{height:38px;flex:0 0 38px;padding:0 12px;background:var(--top-glass);-webkit-backdrop-filter:blur(20px) saturate(160%);backdrop-filter:blur(20px) saturate(160%);border-bottom:1px solid var(--card-line);display:flex;align-items:center;gap:8px}',
'.fd-root .coord-l,.fd-root .coord-r{display:flex;align-items:center;gap:6px;min-width:0}',
'.fd-root .coord-l{flex:1}',
'.fd-root .glass-chip{height:26px;padding:0 10px;border-radius:7px;border:1px solid rgba(128,128,128,.2);background:rgba(255,255,255,.54);color:var(--ink-700);font-size:11.5px;font-weight:600;display:inline-flex;align-items:center;gap:5px;cursor:default;transition:background-color .12s,border-color .12s,color .12s}',
'@media (prefers-color-scheme:dark){.fd-root .glass-chip{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.13)}}',
'.fd-root .glass-chip:hover{background:rgba(255,255,255,.84);color:var(--ink-900)}',
'.fd-root .glass-chip.pri{background:var(--accent);color:#fff;border-color:var(--accent)}',
'.fd-root .glass-chip.off{color:var(--ink-400);background:transparent}',
'.fd-root .glass-chip.pri svg{stroke:#fff}',
'.fd-root .glass-chip svg{width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:1.8}',
'.fd-root .nav-sq{width:26px;height:26px;border-radius:7px;border:1px solid rgba(128,128,128,.2);background:rgba(255,255,255,.5);color:var(--ink-600);display:grid;place-items:center;cursor:default}',
'@media (prefers-color-scheme:dark){.fd-root .nav-sq{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.13)}}',
'.fd-root .nav-sq:disabled{opacity:.4}',
'.fd-root .nav-sq svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:1.9}',
'.fd-root .crumb{display:flex;align-items:center;gap:3px;font-size:11.5px;color:var(--ink-500);min-width:0;white-space:nowrap;overflow:hidden;margin-left:4px}',
'.fd-root .crumb .n{padding:2px 6px;border-radius:4px;cursor:default;border:0;background:transparent;color:inherit;font:inherit}',
'.fd-root .crumb .n:hover{background:rgba(128,128,128,.1)}',
'.fd-root .crumb .n.cur{color:var(--ink-900);font-weight:600}',
'.fd-root .crumb .sep{opacity:.5;font-size:10px}',
'.fd-root .spot{margin-left:auto;width:230px;height:27px;border-radius:14px;background:rgba(255,255,255,.64);border:1px solid rgba(255,255,255,.76);box-shadow:0 1px 3px rgba(0,0,0,.04);display:flex;align-items:center;gap:7px;padding:0 11px;color:var(--ink-500);font-size:11.5px}',
'@media (prefers-color-scheme:dark){.fd-root .spot{background:rgba(255,255,255,.09);border-color:rgba(255,255,255,.14)}}',
'.fd-root .spot svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:1.8;flex:0 0 auto}',
'.fd-root .spot input{flex:1;min-width:0;border:0;background:transparent;outline:none;color:var(--ink-900);font:inherit}',
'.fd-root .spot input::placeholder{color:var(--ink-400)}',
'.fd-root .spot kbd{font:10px/1 var(--font-mono);color:var(--ink-400);border:1px solid rgba(128,128,128,.22);border-radius:4px;padding:3px 5px}',
'/* 工作区标签条 */',
'.fd-root .tabstrip{height:32px;flex:0 0 32px;padding:0 10px;background:var(--card-sub);border-bottom:1px solid var(--card-line);display:flex;align-items:center;gap:5px;overflow-x:auto}',
'.fd-root .tabstrip::-webkit-scrollbar{display:none}',
'.fd-root .tab{height:25px;padding:0 10px;border-radius:7px;background:transparent;color:var(--ink-500);font-size:11.5px;font-weight:500;display:inline-flex;align-items:center;gap:6px;cursor:default;white-space:nowrap;transition:background-color .12s,color .12s;border:0}',
'.fd-root .tab.on{background:var(--card-bg);color:var(--ink-900);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.06),0 0 0 .5px var(--ink-200)}',
'.fd-root .tab .dot{width:7px;height:7px;border-radius:2px;flex:0 0 auto}',
'.fd-root .tab .x{opacity:.5;font-size:12px;padding:0 2px;border-radius:3px;border:0;background:transparent;color:inherit}',
'.fd-root .tab .x:hover{opacity:1;background:rgba(128,128,128,.2)}',
'.fd-root .tab-add{width:23px;height:23px;border-radius:6px;display:grid;place-items:center;color:var(--ink-500);font-size:15px;cursor:default;border:0;background:transparent}',
'/* ===== 舞台 + 空间卡片 ===== */',
'.fd-root .stage{flex:1;min-height:0;display:flex;gap:8px;padding:8px;background:var(--card-sub)}',
'.fd-root .pane{flex:1;min-width:0;background:var(--card-bg);border-radius:12px;box-shadow:var(--card-shadow);display:flex;flex-direction:column;overflow:hidden;position:relative;transition:box-shadow .16s}',
'/* 第 25 轮：主卡永远只有一张、永远处于 focused，整圈 1.5px 蓝框等于给整个文件区画了个输入框。',
'   焦点该只在真有键盘焦点时出现（见 :focus-visible），常态用中性阴影即可。 */',
'.fd-root .pane.focused{box-shadow:var(--card-shadow)}',
'.fd-root .pane.focused:focus-within{box-shadow:0 0 0 1.5px var(--accent-mid),0 14px 34px rgba(18,28,55,.08)}',
'.fd-root .pane.insp{flex:0 0 282px;width:282px;min-width:0}',
'/* 宿主窗口窄时检查器先收窄再整个让位——不能像刚才那样被右边缘裁掉 */',
'@media (max-width:1180px){.fd-root .pane.insp{flex:0 0 240px;width:240px}}',
'@media (max-width:1040px){.fd-root .pane.insp{display:none}}',
'.fd-root .hero{height:44px;flex:0 0 44px;padding:0 13px;border-bottom:1px solid var(--card-line);background:var(--card-bg);display:flex;align-items:center;justify-content:space-between;gap:8px;transition:height .18s var(--ease-out)}',
'.fd-root .pane.scrolled .hero{height:30px;flex-basis:30px}',
'.fd-root .hero-l{min-width:0;display:flex;flex-direction:column;justify-content:center;gap:2px}',
'.fd-root .hero-t{display:flex;align-items:baseline;gap:8px}',
'.fd-root .hero-t b{font-family:var(--font-display);font-size:15px;font-weight:700;letter-spacing:-.02em;white-space:nowrap;transition:font-size .16s;color:var(--ink-900)}',
'.fd-root .pane.scrolled .hero-t b{font-size:13px}',
'.fd-root .hero-t .cnt{font-size:11px;color:var(--ink-400);font-family:var(--font-mono)}',
'.fd-root .pane.scrolled .hero-t .cnt{display:none}',
'.fd-root .hero-crumb{display:flex;align-items:center;gap:3px;font-size:10.5px;color:var(--ink-400)}',
'.fd-root .hero-crumb span{padding:0 3px}',
'.fd-root .hero-crumb .cur{color:var(--ink-600);font-weight:600}',
'.fd-root .hero-r{display:flex;align-items:center;gap:5px;flex-shrink:0}',
'.fd-root .filter{height:24px;width:92px;border-radius:12px;border:1px solid var(--ink-150);background:var(--ink-50);padding:0 9px;font-size:11px;color:var(--ink-900);outline:none;transition:width .15s,border-color .15s,box-shadow .15s,background-color .15s;font-family:var(--font-sans)}',
'.fd-root .filter:focus-visible{width:130px;border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft);background:var(--card-bg)}',
'.fd-root .viewseg{display:inline-flex;background:var(--ink-100);border-radius:7px;padding:2px;gap:2px}',
'.fd-root .viewseg button{width:24px;height:20px;border:0;border-radius:5px;display:grid;place-items:center;color:var(--ink-500);background:transparent;cursor:default;padding:0}',
'.fd-root .viewseg button svg{width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:1.8}',
'.fd-root .viewseg button.on{background:var(--card-bg);color:var(--ink-900);box-shadow:0 1px 2px rgba(0,0,0,.08)}',
'.fd-root .colhead{height:22px;flex:0 0 22px;padding:0 10px;display:grid;grid-template-columns:minmax(0,2.4fr) 124px 68px minmax(0,.85fr) 38px;align-items:center;gap:6px;font-size:10px;font-weight:600;color:var(--ink-400);border-bottom:1px solid var(--card-line);background:var(--card-sub);text-transform:uppercase;letter-spacing:.04em}',
'.fd-root .colhead span{padding-left:10px;border-left:1px solid var(--card-line)}',
'.fd-root .colhead span:first-child{padding-left:0;border-left:0}',
'.fd-root .rows{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:3px 6px 68px}',
'.fd-root .row{height:var(--fd-row-h);padding:0 10px;border-radius:7px;display:grid;grid-template-columns:minmax(0,2.4fr) 124px 68px minmax(0,.85fr) 38px;align-items:center;gap:6px;font-size:11.5px;color:var(--ink-700);cursor:default;border-bottom:1px solid rgba(128,128,128,.04);transition:background .08s}',
'.fd-root .row:hover{background:var(--ink-50)}',
'.fd-root .row.on{background:var(--accent-soft);color:var(--ink-900)}',
'.fd-root .cell{display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden}',
'.fd-root .fname{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink-900);font-weight:500}',
// 行内类型图标：淡色底 + 类型色 Lucide 线性图标（与侧栏 .sb-ico 同一套语言，替掉渐变实心字母块）
'.fd-root .fico{width:18px;height:18px;border-radius:4px;flex:0 0 18px;display:grid;place-items:center;color:#007aff;background:rgba(0,122,255,.12);overflow:hidden}',
'.fd-root .fico .fico-ico{display:block}',
'/* 列表行缩略图：20px 小图，填满 .fico 的框，避免行高被撑高 */',
'/* 第 25 轮：缩略图框 5px → 4px，与 .fico 基准图标框同档 */',
'.fd-root .fico.thumb{width:20px;height:20px;flex-basis:20px;border-radius:4px;background:var(--ink-50);box-shadow:inset 0 0 0 1px rgba(128,128,128,.14)}',
'.fd-root .fico.thumb img{width:100%;height:100%;object-fit:cover;border-radius:4px;display:block}',
'.fd-root .fico.folder{color:#007aff;background:rgba(0,122,255,.12)}',
'.fd-root .fico.img{color:#ff9500;background:rgba(255,149,0,.14)}',
'.fd-root .fico.doc{color:#007aff;background:rgba(0,122,255,.12)}',
'.fd-root .fico.xls{color:#34c759;background:rgba(52,199,89,.15)}',
'.fd-root .fico.slide{color:#ff9500;background:rgba(255,149,0,.14)}',
'.fd-root .fico.archive{color:#8e8e93;background:rgba(142,142,147,.16)}',
'.fd-root .fico.code{color:#5856d6;background:rgba(88,86,214,.14)}',
'.fd-root .fico.other{color:#8e96a8;background:rgba(142,150,168,.16)}',
'@media (prefers-color-scheme:dark){',
'.fd-root .fico.folder,.fd-root .fico.doc{color:#3898ff;background:rgba(56,152,255,.20)}',
'.fd-root .fico.img,.fd-root .fico.slide{color:#ff9f0a;background:rgba(255,159,10,.18)}',
'.fd-root .fico.xls{color:#32d74b;background:rgba(50,215,75,.18)}',
'.fd-root .fico.archive{color:#aab2c4;background:rgba(170,178,196,.16)}',
'.fd-root .fico.code{color:#a78bfa;background:rgba(167,139,250,.20)}',
'.fd-root .fico.other{color:#8b94a8;background:rgba(139,148,168,.18)}}',
'.fd-root .meta{font-size:10.5px;color:var(--ink-400);font-family:var(--font-mono);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-left:8px;border-left:1px solid var(--card-line);min-width:0}',
'.fd-root .rowtags{display:flex;align-items:center;gap:5px;overflow:hidden;padding-left:10px;border-left:1px solid var(--card-line)}',
'.fd-root .tpill{height:17px;padding:0 7px;border-radius:8px;font-size:10px;font-weight:600;display:inline-flex;align-items:center;gap:4px;flex-shrink:0;background:var(--accent-soft);color:var(--accent)}',
'/* 第二个起的标签降级为描边，避免一列实心 pill 抢走名称列的注意力 */',
'.fd-root .tpill.ghost{background:transparent;border:1px solid var(--ink-200);color:var(--ink-600);font-weight:500}',
'.fd-root .tdot{width:6px;height:6px;border-radius:50%;flex-shrink:0}',
'.fd-root .srccell{font-size:9.5px;font-weight:700;color:var(--ink-400);padding-left:8px;border-left:1px solid var(--card-line);font-family:var(--font-mono);overflow:hidden}',
'/* 第 25 轮：标签列与来源列在绝大多数目录里是空的（没有用户标签、全在本机）——',
'   空列白占两段宽度，还让名称列被迫截断。给容器一个 no-tags / no-src 类就整列收掉。 */',
'.fd-root .rows.no-tags .row,.fd-root .colhead.no-tags{grid-template-columns:minmax(0,2.4fr) 124px 68px 0}',
'.fd-root .rows.no-tags .rowtags,.fd-root .colhead.no-tags span:nth-child(4){display:none}',
'.fd-root .rows.no-src .row,.fd-root .colhead.no-src{grid-template-columns:minmax(0,2.4fr) 124px 68px minmax(0,.85fr)}',
'.fd-root .rows.no-src .srccell,.fd-root .colhead.no-src span:nth-child(5){display:none}',
'.fd-root .rows.no-tags.no-src .row,.fd-root .colhead.no-tags.no-src{grid-template-columns:minmax(0,1fr) 124px 68px}',

'/* ===== 灵动底坞 ===== */',
'.fd-root .dock{box-sizing:border-box;position:absolute;left:9px;right:9px;bottom:9px;z-index:14;background:var(--dock-glass);-webkit-backdrop-filter:blur(28px) saturate(190%);backdrop-filter:blur(28px) saturate(190%);border:1px solid var(--dock-border);box-shadow:var(--dock-shadow);border-radius:21px;overflow:hidden;display:flex;flex-direction:column;transition:height .26s var(--spring),border-radius .2s}',
'.fd-root .dock:before{content:"";position:absolute;left:-10%;top:-70%;width:120%;height:110%;background:radial-gradient(ellipse at 25% 15%,rgba(255,255,255,.55),rgba(255,255,255,0) 52%);pointer-events:none}',
'@media (prefers-color-scheme:dark){.fd-root .dock:before{background:radial-gradient(ellipse at 25% 15%,rgba(255,255,255,.14),rgba(255,255,255,0) 58%)}}',
'.fd-root .dock[data-tier="idle"]{height:46px;border-radius:23px;--dock-h:46px}',
'.fd-root .dock[data-tier="selected"]{height:58px;border-radius:29px;--dock-h:58px}',
'.fd-root .dock[data-tier="expanded"]{height:141px;border-radius:18px}',
'.fd-root .dock-top{height:56px;padding:0 12px;display:flex;align-items:center;gap:10px;position:relative;z-index:2;flex-shrink:0}',
'.fd-root .dock[data-tier="idle"] .dock-top{height:44px}',
'.fd-root .dthumb{width:34px;height:34px;border-radius:9px;flex:0 0 34px;display:grid;place-items:center;color:#fff;font-size:9px;font-weight:800;box-shadow:0 2px 6px rgba(15,23,42,.16);background:linear-gradient(140deg,#007aff,#5b6780)}',
'.fd-root .dock[data-tier="idle"] .dthumb{display:none}',
'/* 第 26 轮：有真实缩略图时换成图片，圆角/尺寸与色块版一致，避免切换时跳动 */',
'.fd-root .dthumb-img{padding:0;overflow:hidden;background:var(--fd-line2)}',
'.fd-root .dthumb-img img{width:100%;height:100%;object-fit:cover;display:block}',
'.fd-root .dinfo{flex:1;min-width:0;cursor:default}',
'.fd-root .dinfo .t{font-size:12px;font-weight:600;color:var(--ink-900);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.fd-root .dinfo .s{font-size:10.5px;color:var(--ink-500);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.fd-root .dacts{display:flex;align-items:center;gap:5px;flex-shrink:0}',
'.fd-root .pill{height:28px;padding:0 10px;border-radius:14px;background:rgba(255,255,255,.8);border:1px solid rgba(0,0,0,.08);box-shadow:0 2px 6px rgba(0,0,0,.05);color:var(--ink-800);font-size:11px;font-weight:600;display:inline-flex;align-items:center;gap:5px;cursor:default;transition:transform .12s,border-color .12s}',
'@media (prefers-color-scheme:dark){.fd-root .pill{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.15)}}',
'.fd-root .pill:hover{transform:translateY(-1px);border-color:var(--accent)}',
'.fd-root .pill:active{transform:scale(.97)}',
'.fd-root .pill.pri{background:var(--accent);color:#fff;border-color:var(--accent)}',
'.fd-root .pill svg{width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:1.8}',
'.fd-root .dock-drawer{flex:1 1 auto;min-height:0;overflow:hidden;padding:7px 13px 9px;border-top:1px solid rgba(128,128,128,.14);display:none;align-items:center;gap:12px;position:relative;z-index:2}',
'.fd-root .dock[data-tier="expanded"] .dock-drawer{display:flex}',
/* 滚动区底部让位跟随底坞真实档位，避免内容被玻璃面板压住 */
'.fd-root .pane[data-dock="selected"] .rows,.fd-root .pane[data-dock="selected"] .gridview{padding-bottom:80px}',
'.fd-root .pane[data-dock="expanded"] .rows,.fd-root .pane[data-dock="expanded"] .gridview{padding-bottom:158px}',
/* 展开把手：选中档才出现，位于操作按钮左侧 */
'.fd-root .dpull{width:26px;height:26px;flex:0 0 26px;border-radius:13px;border:1px solid rgba(0,0,0,.08);background:rgba(255,255,255,.72);color:var(--ink-500);display:grid;place-items:center;cursor:default;transition:transform .12s,color .12s,border-color .12s}',
'.fd-root .dpull svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:2}',
'.fd-root .dpull:hover{color:var(--accent);border-color:var(--accent)}',
'.fd-root .dpull:active{transform:scale(.94)}',
'@media (prefers-color-scheme:dark){.fd-root .dpull{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.16)}}',
'.fd-root .dprev{width:64px;height:64px;border-radius:10px;flex:0 0 64px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:15px;box-shadow:0 4px 12px rgba(0,122,255,.22);background:linear-gradient(140deg,#007aff,#5b6780)}',
'.fd-root .mgrid{flex:1;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px 14px;font-size:10.5px;align-content:start}',
'.fd-root .kvline.wide{grid-column:span 2}',
'.fd-root .kvline b{display:block;font-size:9.5px;color:var(--ink-400);font-weight:500}',
'.fd-root .kvline span{display:block;color:var(--ink-900);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.fd-root .kvline.tags-kv{grid-column:1/-1;display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:2px}',
'/* ===== 工具结果视图（查重/相似/时间线/识别/清理/设置） ===== */',
'.fd-root .toolview{position:absolute;inset:0;z-index:16;background:var(--card-bg);display:none;flex-direction:column}',
'.fd-root .toolview.on{display:flex}',
'.fd-root .tvhead{height:52px;flex:0 0 52px;padding:0 14px;border-bottom:1px solid var(--card-line);display:flex;align-items:center;gap:10px}',
'.fd-root .tvhead .role{height:20px;padding:0 8px;border-radius:6px;background:var(--purple-bg);color:var(--purple);font-size:10px;font-weight:700;display:inline-flex;align-items:center}',
'.fd-root .tvhead b{font-size:14px;color:var(--ink-900)}',
'.fd-root .tvhead .back{margin-left:auto;height:27px;padding:0 11px;border:1px solid var(--ink-200);border-radius:7px;color:var(--ink-700);font-size:11px;font-weight:600;cursor:default;background:var(--card-bg)}',
'.fd-root .tvbody{flex:1;min-height:0;overflow-y:auto;padding:16px;overscroll-behavior:contain}',
'.fd-root .tvnote{font-size:11px;color:var(--ink-500);margin-bottom:14px}',
'/* ===== 检查器 v2（第 24 轮）：只放底坞没有的东西，可手动隐藏 ===== */',
'.fd-root .insp-h{height:32px;flex:0 0 32px;padding:0 8px 0 12px;display:flex;align-items:center;gap:6px;font-size:10px;font-weight:700;color:var(--ink-400);border-bottom:1px solid var(--card-line);background:var(--card-sub);letter-spacing:.06em}',
'.fd-root .insp-x{margin-left:auto;width:22px;height:22px;border-radius:6px;border:0;background:transparent;color:var(--ink-400);display:grid;place-items:center;cursor:default}',
'.fd-root .insp-x:hover{background:rgba(128,128,128,.16);color:var(--ink-700)}',
'.fd-root .insp-x svg{width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:1.9}',
'.fd-root .insp-body{padding:12px 13px 16px;overflow-y:auto;flex:1;min-height:0;overscroll-behavior:contain;display:flex;flex-direction:column;gap:11px}',
'.fd-root .ititle{display:flex;align-items:baseline;gap:7px;min-width:0}',
'.fd-root .ititle b{font-size:12.5px;font-weight:600;color:var(--ink-900);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}',
'.fd-root .ititle-k{flex:0 0 auto;font-size:9.5px;font-weight:700;color:var(--accent);background:var(--accent-soft);border-radius:5px;padding:1px 5px}',
'.fd-root .ikv{display:flex;flex-direction:column;gap:1px}',
'.fd-root .ikv-r{display:grid;grid-template-columns:64px minmax(0,1fr);gap:8px;font-size:11px;padding:2px 0}',
'.fd-root .ikv-r span{color:var(--ink-400)}',
'.fd-root .ikv-r b{color:var(--ink-800);font-weight:600;font-family:var(--font-mono);font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.fd-root .itags{display:flex;flex-direction:column;gap:5px}',
'.fd-root .itags-r{display:grid;grid-template-columns:56px minmax(0,1fr);gap:6px;align-items:start}',
'.fd-root .itags-h{font-size:9.5px;color:var(--ink-400);padding-top:3px}',
'.fd-root .itags-w{display:flex;flex-wrap:wrap;gap:4px}',
'.fd-root .ichip{font-size:9.5px;font-weight:600;padding:1px 6px;border-radius:8px;background:rgba(128,128,128,.13);color:var(--ink-700);white-space:nowrap}',
'.fd-root .ichip.on{background:var(--accent-soft);color:var(--accent)}',
'.fd-root .ichip.dash{background:transparent;border:1px dashed var(--ink-200);color:var(--ink-500)}',
'.fd-root .ipath{display:flex;align-items:flex-start;gap:5px;border:0;background:transparent;padding:0;text-align:left;color:var(--ink-400);cursor:default}',
'.fd-root .ipath:hover{color:var(--accent)}',
'.fd-root .ipath svg{width:11px;height:11px;stroke:currentColor;fill:none;stroke-width:1.8;flex:0 0 11px;margin-top:2px}',
'.fd-root .ipath span{font-size:9.5px;font-family:var(--font-mono);word-break:break-all;line-height:1.45}',
'.fd-root .idiv{height:1px;background:var(--card-line);margin:1px 0}',
'.fd-root .isec{display:flex;flex-direction:column;gap:6px}',
'.fd-root .isec-h{display:flex;align-items:center;gap:6px}',
'.fd-root .isec-i{width:12px;height:12px;stroke:var(--accent);fill:none;stroke-width:1.8;flex:0 0 12px}',
'.fd-root .isec-h b{font-size:10.5px;font-weight:700;color:var(--ink-700);letter-spacing:.02em}',
'.fd-root .isec-b{margin-left:auto;font-size:9px;font-family:var(--font-mono);color:var(--ink-400);background:rgba(128,128,128,.12);border-radius:6px;padding:1px 5px}',
'.fd-root .isec-empty{font-size:10.5px;color:var(--ink-400);line-height:1.55;display:flex;flex-direction:column;align-items:flex-start;gap:5px}',
'.fd-root .ipill{height:21px;padding:0 8px;border-radius:11px;border:1px solid var(--ink-200);background:var(--card-bg);color:var(--ink-700);font-size:10px;font-weight:600;cursor:default}',
'.fd-root .ipill:hover{border-color:var(--accent);color:var(--accent)}',
'.fd-root .irec{display:flex;flex-direction:column;gap:3px;padding:8px 9px;border-radius:8px;background:var(--card-sub);border:1px solid var(--card-line)}',
'.fd-root .irec-what{font-size:11px;font-weight:600;color:var(--ink-900);line-height:1.45;margin-bottom:2px}',
'.fd-root .irec-r{display:grid;grid-template-columns:44px minmax(0,1fr);gap:6px;font-size:10px}',
'.fd-root .irec-r span{color:var(--ink-400)}',
'.fd-root .irec-r b{color:var(--ink-800);font-weight:500;line-height:1.4}',
'.fd-root .itl{display:flex;flex-direction:column;gap:5px;padding-left:2px}',
'.fd-root .itl-r{display:grid;grid-template-columns:8px minmax(0,1fr) auto;gap:7px;align-items:center;font-size:10.5px}',
'.fd-root .itl-dot{width:6px;height:6px;border-radius:50%;background:var(--accent);opacity:.7}',
'.fd-root .itl-k{color:var(--ink-800);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.fd-root .itl-r time{font-size:9px;color:var(--ink-400);font-family:var(--font-mono)}',
'.fd-root .isim{display:flex;flex-direction:column;gap:2px}',
'.fd-root .isim-r{display:flex;align-items:center;gap:6px;height:22px;padding:0 5px;border:0;background:transparent;border-radius:5px;cursor:default;text-align:left}',
'.fd-root .isim-r:hover{background:rgba(128,128,128,.11)}',
'.fd-root .isim-n{flex:1;min-width:0;font-size:10.5px;color:var(--ink-800);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.fd-root .isim-p{font-size:9px;font-family:var(--font-mono);color:var(--accent)}',
'.fd-root .insp-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;color:var(--ink-400);text-align:center;padding:0 20px}',
'.fd-root .insp-empty .ie-ico{width:20px;height:20px;stroke:var(--ink-300);fill:none;stroke-width:1.5}',
'.fd-root .insp-empty p{font-size:11.5px;color:var(--ink-600);font-weight:600}',
'.fd-root .insp-empty small{font-size:10px;line-height:1.55;color:var(--ink-400)}',
'/* ===== AI 抽屉 ===== */',
// 诉求「AI 助手不要加模糊效果」：抽屉与遮罩都不用 backdrop-filter。
// 抽屉改成实色卡面 + 左侧细线 + 投影（层次靠边界与阴影，不靠糊背景）；
// 遮罩只保留半透明底色，让底下的文件列表仍然可辨，但不被磨砂。
'.fd-root .scrim{position:absolute;inset:0;background:rgba(12,16,28,.30);opacity:0;pointer-events:none;transition:opacity .22s;z-index:30}',
'.fd-root .drawer{position:absolute;top:0;right:0;bottom:0;width:400px;background:var(--card-bg);border-left:1px solid var(--ink-200);box-shadow:-16px 0 44px rgba(15,23,42,.16);transform:translateX(100%);transition:transform .28s var(--ease-out);z-index:31;display:flex;flex-direction:column;overscroll-behavior:contain}',
'@media (prefers-color-scheme:dark){.fd-root .drawer{border-left-color:rgba(255,255,255,.12);box-shadow:-16px 0 44px rgba(0,0,0,.6)}}',
'.fd-root.ai-open .drawer{transform:translateX(0)}',
'.fd-root.ai-open .scrim{opacity:1;pointer-events:auto}',
'.fd-root .dr-h{height:48px;flex:0 0 48px;display:flex;align-items:center;gap:9px;padding:0 16px;border-bottom:1px solid var(--card-line)}',
'.fd-root .dr-ic{width:24px;height:24px;border-radius:7px;background:linear-gradient(135deg,#007aff,#6e5ce6);display:grid;place-items:center}',
'.fd-root .dr-ic svg{width:13px;height:13px;stroke:#fff;fill:none;stroke-width:1.9}',
'.fd-root .dr-h b{font-size:13px;font-weight:600;color:var(--ink-900)}',
'.fd-root .dr-h .sub{font-size:10px;color:var(--ink-400)}',
'.fd-root .dr-x{margin-left:auto;width:25px;height:25px;border:1px solid var(--ink-200);border-radius:6px;color:var(--ink-600);display:grid;place-items:center;cursor:default;background:transparent}',
'.fd-root .dr-x svg{width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:1.9}',
'.fd-root .dr-tabs{height:34px;flex:0 0 34px;display:flex;gap:18px;padding:0 16px;border-bottom:1px solid var(--card-line);align-items:center}',
'.fd-root .dr-tab{font-size:11px;color:var(--ink-400);height:100%;display:flex;align-items:center;border-bottom:2px solid transparent;position:relative;top:1px;cursor:default;border:0;background:transparent;padding:0}',
'.fd-root .dr-tab.on{color:var(--ink-900);font-weight:600;border-bottom-color:var(--accent)}',
'.fd-root .dr-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:16px}',
'.fd-root .chat-msg{margin-bottom:16px}',
'.fd-root .chat-msg.me{text-align:right}',
'/* 第 25 轮：气泡圆角收到刻度（原 11px / 11-11-2-11，与全局 4/6/8/12 不成体系） */',
'.fd-root .bub{display:inline-block;max-width:93%;padding:10px 12px;line-height:1.6;text-align:left;border-radius:8px;background:var(--card-bg);border:1px solid var(--card-line);color:var(--ink-900)}',
'/* 自身发出的气泡：只有右下角收尖（对话尾巴），其余按 8px 刻度 */',
'.fd-root .chat-msg.me .bub{background:var(--ink-900);color:var(--ink-0);border-radius:8px 8px 2px 8px;border-color:transparent}',
'.fd-root .dr-input{border-top:1px solid var(--card-line);padding:11px 13px;flex:0 0 auto}',
'.fd-root .ipt{width:100%;box-sizing:border-box;border:1px solid var(--ink-200);border-radius:9px;padding:10px 11px;font-size:13px;color:var(--ink-900);min-height:44px;background:var(--card-bg);font-family:var(--font-sans);outline:none;resize:none}',
'.fd-root .ipt::placeholder{color:var(--ink-400)}',
'.fd-root .ipt-row{display:flex;align-items:center;margin-top:7px;font-size:10px;color:var(--ink-400);gap:8px}',
'.fd-root .send{margin-left:auto;background:var(--accent);color:#fff;border:0;border-radius:7px;padding:6px 13px;font-size:11px;font-weight:600;cursor:default;transition:transform 100ms ease-out}',
'.fd-root .send:active{transform:scale(.96)}',
'.fd-root .send:disabled{opacity:.45}',
'/* 抽屉内任务列表 */',
'.fd-root .task{display:grid;grid-template-columns:1fr auto;gap:3px 10px;padding:11px 0;border-bottom:1px solid var(--card-line)}',
'.fd-root .task b{font-size:11.5px;font-weight:600;color:var(--ink-900)}',
'.fd-root .task time{font-size:10px;color:var(--ink-400);font-family:var(--font-mono)}',
'.fd-root .task p{grid-column:1/3;font-size:10.5px;color:var(--ink-600)}',
'/* ===== 网格视图 ===== */',
'.fd-root .gridview{flex:1;min-height:0;overflow-y:auto;padding:10px 10px 68px;display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px;overscroll-behavior:contain}',
'.fd-root .tile{display:flex;flex-direction:column;align-items:center;gap:6px;padding:9px 6px;border-radius:9px;cursor:default;border:1px solid transparent}',
'.fd-root .tile:hover{background:var(--ink-50)}',
'.fd-root .tile.on{background:var(--accent-soft);border-color:var(--accent-mid)}',
'.fd-root .tile .nm{font-size:10.5px;color:var(--ink-800);text-align:center;word-break:break-all;max-height:2.6em;overflow:hidden}',
'.fd-root .tile .th{width:100%;height:66px;border-radius:7px;background:var(--ink-100);display:grid;place-items:center;overflow:hidden}',
'.fd-root .tile .th img{width:100%;height:100%;object-fit:cover}',
'.fd-root .empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:40px 20px;color:var(--ink-400);text-align:center;font-size:11.5px}',
'/* ===== 分栏视图（Finder 式级联栏）===== */',
'/* 每栏固定 236px，横向滚动；最后一栏吃掉剩余宽度（Finder 也是这么做的）。 */',
'.fd-root .colview{flex:1;min-height:0;display:flex;overflow-x:auto;overflow-y:hidden;overscroll-behavior:contain;border-top:1px solid var(--card-line)}',
'.fd-root .colview .col{display:flex;flex-direction:column;width:236px;flex:0 0 236px;border-right:1px solid var(--card-line);min-height:0;position:relative}',
'.fd-root .colview .col:last-child{flex:1 1 236px;border-right:0;min-width:236px}',
'.fd-root .colview .col-h{height:22px;flex:0 0 22px;display:flex;align-items:center;padding:0 10px;font-size:10px;font-weight:700;color:var(--ink-400);letter-spacing:.04em;text-transform:uppercase;border-bottom:1px solid var(--card-line);background:var(--card-sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.fd-root .colview .col-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:3px 4px 24px}',
'.fd-root .colview .col-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:7px;height:26px;padding:0 7px;border-radius:6px;cursor:default;font-size:11.5px;color:var(--ink-700)}',
'.fd-root .colview .col-row:hover{background:var(--ink-50)}',
'.fd-root .colview .col-row.on{background:var(--accent-soft);color:var(--ink-900);font-weight:600}',
'.fd-root .colview .col-row.on .col-n{color:var(--accent)}',
'.fd-root .colview .col-n{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.fd-root .colview .col-ar{color:var(--ink-300);font-size:12px;line-height:1}',
'.fd-root .colview .col-sz{font-size:9px;font-family:var(--font-mono);color:var(--ink-400)}',
'.fd-root .colview .col-empty{font-size:10px;color:var(--ink-400);padding:10px}',
'.fd-root .colview .col-loading{font-size:11px;color:var(--ink-400);padding:16px}',
'.fd-root .colview .col-spin{position:absolute;right:7px;top:5px}',
'.fd-root .colview .col-spin i{display:block;width:9px;height:9px;border-radius:50%;border:1.5px solid var(--ink-300);border-top-color:transparent;animation:tnspin .7s linear infinite}',
'@media (max-width:1080px){.fd-root .colview .col{width:200px;flex-basis:200px}}',
'.fd-root .empty b{font-size:12.5px;color:var(--ink-600)}',
'.fd-root .skeleton{height:26px;margin:4px 6px;border-radius:6px;background:linear-gradient(90deg,var(--ink-50),var(--ink-100),var(--ink-50));background-size:200% 100%;animation:fdsk 1.2s linear infinite}',
'@keyframes fdsk{from{background-position:0 0}to{background-position:-200% 0}}',
'/* 窄卡自适应：先砍来源列，再砍标签列，名称列永远优先 */',
'@media (max-width:1080px){',
'.fd-root .colhead,.fd-root .row{grid-template-columns:minmax(0,2.4fr) 118px 64px minmax(0,.8fr)}',
'.fd-root .srccell,.fd-root .colhead span:nth-child(5){display:none}}',
'@media (max-width:900px){',
'.fd-root .colhead,.fd-root .row{grid-template-columns:minmax(0,1fr) 110px 62px}',
'.fd-root .rowtags,.fd-root .colhead span:nth-child(4){display:none}}',

'/* ===== 第 25 轮：刻度层（设计审查 m11235 诉求 6） ===== */',
'/* 审查结论：这套界面不是"配色丑"，是"没有刻度"。改前三项实测——',
'   ① 字号 10 档（9/9.5/10/10.5/11/11.5/12/12.5/13/15），其中 9.5px 出现 50 次、9px 出现 2 次，',
'      全都在可读下限之下；225 个文字节点里 85 个挤在 11.5px，没有任何层级。',
'   ② 圆角 15 档（2/3/4/5/6/7/8/9/10/11/12/13/14/23/50%），七个相邻档差 1px——这不是设计，是随手写的。',
'   ③ 间距 11 档（1/2/3/4/5/6/7/8/9/10/18），3px 与 5px 与 6px 交替出现，没有节奏。',
'   这一层不重写任何组件规则，只在末尾用同特异性的选择器把三套刻度锁成 4 / 5 / 6 档，',
'   上层规则（结构、颜色、布局）全部照旧，所以回滚只需删掉这一段。 */',
'/* —— 字号：11 / 12 / 13 / 15 四档，行高统一到 1.45 —— */',
'.fd-root .row .fname,.fd-root .tn-name,.fd-root .col-row,.fd-root .dinfo .t,.fd-root .bub,.fd-root .ipt,.fd-root .vol-l1{font-size:12px}',
'.fd-root .meta,.fd-root .srccell,.fd-root .tpill,.fd-root .cnt,.fd-root .badge,.fd-root .kvline span,.fd-root .ikv-r b,.fd-root .irec-r b,.fd-root .itl-r,.fd-root .isim-n{font-size:11px}',
'.fd-root .kvline b,.fd-root .sb-group,.fd-root .tagsec .lbl,.fd-root .sb-ws .t,.fd-root .colhead,.fd-root .itags-h,.fd-root .isec-h b,.fd-root .fd-tree-h,.fd-root .insp-h,.fd-root .colview .col-h{font-size:10px;letter-spacing:.04em}',
'/* 9px / 9.5px 一律抬到 10px：这是可读下限，不是审美偏好 */',
'.fd-root .sb-tag,.fd-root .tpill,.fd-root .srccell,.fd-root .ichip,.fd-root .ipill,.fd-root .isim-p,.fd-root .itl-r time,.fd-root .colview .col-sz,.fd-root .isec-b{font-size:10px}',
'/* —— 圆角：4（chip）/ 6（控件）/ 8（卡）/ 12（面板）/ 21（坞）—— */',
'.fd-root .glass-chip,.fd-root .nav-sq,.fd-root .viewseg,.fd-root .viewseg button,.fd-root .pill,.fd-root .dpull,.fd-root .tab,.fd-root .tab-add,.fd-root .dr-x,.fd-root .ipill,.fd-root .insp-x,.fd-root .tn-caret,.fd-root .tn-row,.fd-root .isim-r,.fd-root .sb-row,.fd-root .tool-item{--fd-r:6px;border-radius:var(--fd-r)}',
'.fd-root .pill,.fd-root .ipill,.fd-root .tagchip,.fd-root .tpill,.fd-root .ichip,.fd-root .sb-tag{border-radius:999px}',
'/* —— 间距：4 / 6 / 8 / 12 —— */',
'.fd-root .coord-l,.fd-root .coord-r,.fd-root .dacts,.fd-root .hero-r,.fd-root .sb-brand,.fd-root .isec-h,.fd-root .itags-w{gap:6px}',
'.fd-root .itags,.fd-root .isec,.fd-root .insp-body,.fd-root .ikv{gap:8px}',
'/* —— 顶栏：三个 chip + 搜索框挤在 38px 里，右侧没有主次；把 AI 助手做成唯一的实心主操作 —— */',
'.fd-root .coord{height:40px;flex-basis:40px;gap:10px}',
'.fd-root .glass-chip{height:28px}',
'/* —— 选中态：行高亮加左侧 2px 实心条，让"当前目录树位置"和"当前选中行"看起来不是同一个东西 —— */',
'.fd-root .row.on{box-shadow:inset 2px 0 0 var(--accent)}',
'.fd-root .tn-row.is-on{box-shadow:inset 2px 0 0 var(--accent);background:var(--accent-soft)}',
'/* —— 键盘焦点：全局只给键盘（client-style 已有 :focus-visible），这里补齐被 outline:none 抹掉的搜索框 —— */',
'.fd-root .spot:focus-within{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}',
'.fd-root .spot input:focus-visible{outline:none}',
'/* —— 骨架屏与加载态用 ink-350（非文字），文字永不使用 —— */',
'.fd-root .skeleton{background:linear-gradient(90deg,var(--ink-50),var(--ink-150),var(--ink-50))}',
'/* —— 圆角收尾：组件规则里残留的 7/10/13/14/23px 归到 4/6/8/12/21 五档 —— */',
'.fd-root .fd-planbox{border-radius:8px}',
'.fd-root .row{border-radius:6px}',
'.fd-root .sb-ico,.fd-root .fico,.fd-root .fico.thumb{border-radius:4px}',
'.fd-root .fd-btn,.fd-root .dr-ic,.fd-root .send{border-radius:6px}',
'.fd-root .ipt{border-radius:8px}',
'.fd-root .sidebar{border-radius:12px 0 0 12px}',
'.fd-root .spot{border-radius:12px}',
'/* 底坞两档高度不同，圆角必须是高度的一半才是胶囊：46/2=23、58/2=29 */',
'.fd-root .dock[data-tier="idle"]{border-radius:23px}',
'.fd-root .dock[data-tier="selected"]{border-radius:29px}',
'/* 容量条 2px 是 3px 细条本身的半径上限，不是装饰圆角，保持 */',
'/* —— 可排序列头：按钮化，箭头只在 hover 或已排序时出现（避免五列全是 ↕ 噪声）—— */',
'.fd-root .colhead{gap:0;padding:0 16px}',
'.fd-root .colhead-btn{display:flex;align-items:center;gap:4px;height:100%;padding:0 0 0 10px;border:0;background:transparent;color:inherit;font:inherit;font-weight:600;letter-spacing:inherit;text-transform:inherit;cursor:default;text-align:left}',
'.fd-root .colhead-btn:first-child{padding-left:0}',
'.fd-root .colhead-btn:hover{color:var(--ink-700)}',
'.fd-root .colhead-btn.on{color:var(--ink-800)}',
'.fd-root .colhead-ar{font-size:10px;opacity:0;transition:opacity .12s}',
'.fd-root .colhead-btn:hover .colhead-ar,.fd-root .colhead-btn.on .colhead-ar{opacity:.75}',
'.fd-root .colhead>span{height:100%;display:flex;align-items:center;padding-left:10px}',
'/* —— 快速筛选命中的行高亮（.sb-row.on 已有，这里只补按下态）—— */',
'.fd-root .sb-row:active{transform:scale(.99)}',
'/* —— 收尾：旧皮肤组件（fd-btn / fd-check / fd-plan-*）与残留的 9/9.5/10.5/11.5/12.5 也归到同一刻度 —— */',
'.fd-root{font-size:12px}',
'.fd-root .vol-l2,.fd-root .tool-item .badge,.fd-root .tree-wrap .fd-tree-h .cnt,.fd-root .sb-row .cnt,.fd-root .hero-crumb,.fd-root .dinfo .s,.fd-root .insp-empty p,.fd-root .insp-empty small,.fd-root .crumb,.fd-root .lede,.fd-root .hint,.fd-root .tree-wrap .fd-tree-h{font-size:11px}',
'.fd-root dl,.fd-root dd,.fd-root dt{font-size:12px}',
'.fd-root .fd-btn,.fd-root .fd-check,.fd-root .fd-plan-scope,.fd-root .fd-msg,.fd-root .tvnote,.fd-root .fd-plan-item,.fd-root .fd-kv{font-size:12px}',
'.fd-root .fd-plan-scope{line-height:1.5}',
'/* —— 检查器空态：左对齐而不是居中悬浮，与整列内容对齐 —— */',
'.fd-root .insp-empty{align-items:flex-start;justify-content:flex-start;text-align:left;padding:20px 14px}',
'@media (prefers-reduced-motion:reduce){.fd-root *,.fd-root *:before,.fd-root *:after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}'
].join('\n')

// Lucide 图标官方数据内嵌（lucide-react v1.47.0，ISC License，https://lucide.dev）
// 本轮（m10238「图标能不能用开源图标集，现在自绘的太丑」）把手绘 path 全部换成 Lucide 官方节点数据。
// 零构建器约束：不引 npm 包、不 import，只把官方 __iconData.node 抄成常量并注明出处与许可。
// 节点格式 [[tag, attrs], ...]，tag 为 path / circle / rect / line / polyline / polygon，由 FF_Lucide 统一渲染。
var FD_LUCIDE_VERSION = "1.47.0"
var FD_LUCIDE_FILE = {
  folder: [["path", {d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"}]],
  image: [["rect", {width: "18", height: "18", x: "3", y: "3", rx: "2", ry: "2"}], ["circle", {cx: "9", cy: "9", r: "2"}], ["path", {d: "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"}]],
  video: [["path", {d: "m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"}], ["rect", {x: "2", y: "6", width: "14", height: "12", rx: "2"}]],
  audio: [["path", {d: "M4 6.835V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2h-.343"}], ["path", {d: "M14 2v5a1 1 0 0 0 1 1h5"}], ["path", {d: "M2 19a2 2 0 0 1 4 0v1a2 2 0 0 1-4 0v-4a6 6 0 0 1 12 0v4a2 2 0 0 1-4 0v-1a2 2 0 0 1 4 0"}]],
  document: [["path", {d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}], ["path", {d: "M14 2v5a1 1 0 0 0 1 1h5"}], ["path", {d: "M10 9H8"}], ["path", {d: "M16 13H8"}], ["path", {d: "M16 17H8"}]],
  spreadsheet: [["path", {d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}], ["path", {d: "M14 2v5a1 1 0 0 0 1 1h5"}], ["path", {d: "M8 13h2"}], ["path", {d: "M14 13h2"}], ["path", {d: "M8 17h2"}], ["path", {d: "M14 17h2"}]],
  presentation: [["path", {d: "M2 3h20"}], ["path", {d: "M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"}], ["path", {d: "m7 21 5-5 5 5"}]],
  code: [["path", {d: "m18 16 4-4-4-4"}], ["path", {d: "m6 8-4 4 4 4"}], ["path", {d: "m14.5 4-5 16"}]],
  archive: [["rect", {width: "20", height: "5", x: "2", y: "3", rx: "1"}], ["path", {d: "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"}], ["path", {d: "M10 12h4"}]],
  large_file: [["path", {d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}], ["path", {d: "M12 9v4"}], ["path", {d: "M12 17h.01"}]],
  unknown: [["path", {d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}], ["path", {d: "M14 2v5a1 1 0 0 0 1 1h5"}]],
  star: [["path", {d: "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"}]],
  disk: [["path", {d: "M10 16h.01"}], ["path", {d: "M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"}], ["path", {d: "M21.946 12.013H2.054"}], ["path", {d: "M6 16h.01"}]],
  cloud: [["path", {d: "M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"}]]
}
var FD_LUCIDE_UI = {
  back: [["path", {d: "m12 19-7-7 7-7"}], ["path", {d: "M19 12H5"}]],
  forward: [["path", {d: "M5 12h14"}], ["path", {d: "m12 5 7 7-7 7"}]],
  up: [["path", {d: "m5 12 7-7 7 7"}], ["path", {d: "M12 19V5"}]],
  refresh: [["path", {d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"}], ["path", {d: "M21 3v5h-5"}], ["path", {d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"}], ["path", {d: "M8 16H3v5"}]],
  star: [["path", {d: "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"}]],
  starOff: [["path", {d: "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"}]],
  list: [["path", {d: "M3 5h.01"}], ["path", {d: "M3 12h.01"}], ["path", {d: "M3 19h.01"}], ["path", {d: "M8 5h13"}], ["path", {d: "M8 12h13"}], ["path", {d: "M8 19h13"}]],
  grid: [["rect", {width: "7", height: "7", x: "3", y: "3", rx: "1"}], ["rect", {width: "7", height: "7", x: "14", y: "3", rx: "1"}], ["rect", {width: "7", height: "7", x: "14", y: "14", rx: "1"}], ["rect", {width: "7", height: "7", x: "3", y: "14", rx: "1"}]],
  columns: [["rect", {width: "18", height: "18", x: "3", y: "3", rx: "2"}], ["path", {d: "M12 3v18"}]],
  close: [["path", {d: "M18 6 6 18"}], ["path", {d: "m6 6 12 12"}]],
  panelRight: [["rect", {width: "18", height: "18", x: "3", y: "3", rx: "2"}], ["path", {d: "M15 3v18"}]],
  columns3: [["rect", {width: "18", height: "18", x: "3", y: "3", rx: "2"}], ["path", {d: "M9 3v18"}], ["path", {d: "M15 3v18"}]],
  info: [["circle", {cx: "12", cy: "12", r: "10"}], ["path", {d: "M12 16v-4"}], ["path", {d: "M12 8h.01"}]],
  history: [["path", {d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"}], ["path", {d: "M3 3v5h5"}], ["path", {d: "M12 7v5l4 2"}]],
  chevronR: [["path", {d: "m9 18 6-6-6-6"}]],
  chevronD: [["path", {d: "m6 9 6 6 6-6"}]],
  foldLeft: [["path", {d: "m11 17-5-5 5-5"}], ["path", {d: "m18 17-5-5 5-5"}]],
  foldRight: [["path", {d: "m6 17 5-5-5-5"}], ["path", {d: "m13 17 5-5-5-5"}]],
  send: [["path", {d: "m5 12 7-7 7 7"}], ["path", {d: "M12 19V5"}]],
  folderPlus: [["path", {d: "M12 10v6"}], ["path", {d: "M9 13h6"}], ["path", {d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"}]],
  scan: [["path", {d: "M3 7V5a2 2 0 0 1 2-2h2"}], ["path", {d: "M17 3h2a2 2 0 0 1 2 2v2"}], ["path", {d: "M21 17v2a2 2 0 0 1-2 2h-2"}], ["path", {d: "M7 21H5a2 2 0 0 1-2-2v-2"}]],
  sparkle: [["path", {d: "M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"}], ["path", {d: "M20 2v4"}], ["path", {d: "M22 4h-4"}], ["circle", {cx: "4", cy: "20", r: "2"}]],
  more: [["circle", {cx: "12", cy: "12", r: "1"}], ["circle", {cx: "19", cy: "12", r: "1"}], ["circle", {cx: "5", cy: "12", r: "1"}]],
  check: [["path", {d: "M20 6 9 17l-5-5"}]],
  search: [["path", {d: "m21 21-4.34-4.34"}], ["circle", {cx: "11", cy: "11", r: "8"}]],
  hdd: [["path", {d: "M10 16h.01"}], ["path", {d: "M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"}], ["path", {d: "M21.946 12.013H2.054"}], ["path", {d: "M6 16h.01"}]],
  clock: [["circle", {cx: "12", cy: "12", r: "10"}], ["path", {d: "M12 6v6l4 2"}]],
  spark: [["path", {d: "M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"}], ["path", {d: "M20 2v4"}], ["path", {d: "M22 4h-4"}], ["circle", {cx: "4", cy: "20", r: "2"}]],
  copy: [["rect", {width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2"}], ["path", {d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"}]],
  trash: [["path", {d: "M10 11v6"}], ["path", {d: "M14 11v6"}], ["path", {d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"}], ["path", {d: "M3 6h18"}], ["path", {d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"}]],
  settings: [["path", {d: "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"}], ["circle", {cx: "12", cy: "12", r: "3"}]]
}

// 统一渲染器：接收 Lucide 官方节点数组，输出 <svg> 子元素。
// stroke/线宽/端点由调用方统一给（Tahoe 基准 1.8 线性），颜色一律 currentColor 继承。
var FD_LUCIDE_TAGS = ['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse']
function FF_Lucide(props) {
  var nodes = props.nodes
  if (!nodes || !nodes.length) nodes = FD_LUCIDE_FILE.unknown
  var args = ['svg', {
    key: props.k,
    className: props.className || 'fd-lucide',
    width: props.size || 16,
    height: props.size || 16,
    viewBox: '0 0 24 24',
    fill: props.filled ? 'currentColor' : 'none',
    stroke: props.filled ? 'none' : (props.stroke || 'currentColor'),
    strokeWidth: props.strokeWidth || 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    role: 'img'
  }]
  nodes.forEach(function (n, i) {
    var tag = FD_LUCIDE_TAGS.indexOf(n[0]) >= 0 ? n[0] : 'path'
    var attrs = Object.assign({ key: i }, n[1] || {})
    args.push(h(tag, attrs))
  })
  return h.apply(null, args)
}

// Client 侧 HTTP 封装：全部走不带前导斜杠的相对 URL（与 host prefix /flowfile/ 对齐）。
var FF_BASE = 'flowfile/'

async function ffRequest(path, options) {
  const response = await fetch(FF_BASE + path, options)
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || ('请求失败（' + response.status + '）'))
  return body
}

function ffGet(path, params) {
  const qs = new URLSearchParams()
  for (const k in (params || {})) if (params[k] !== undefined && params[k] !== null && params[k] !== '') qs.set(k, params[k])
  const s = qs.toString()
  return ffRequest(path + (s ? '?' + s : ''))
}

function ffPost(path, body) {
  return ffRequest(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  })
}

function ffGetVolumes() { return ffGet('volumes') }
function ffList(path) { return ffGet('list', { path: path }) }
function ffMeta(path) { return ffGet('meta', { path: path }) }
function ffSearch(q, path, kind, tag) { return ffGet('search', { q: q, path: path, kind: kind, tag: tag }) }
function ffDuplicates(root) { return ffGet('duplicates', { root: root }) }
function ffSimilar(path) { return ffGet('similar', { path: path }) }
function ffTimeline(path, limit) { return ffGet('timeline', { path: path, limit: limit }) }
function ffRecognize(path) { return ffGet('recognize', { path: path }) }
function ffScan(root, options) { return ffPost('scan', { root: root, options: options || {} }) }
function ffScanStatus(id) { return ffGet('scan/status', { scanId: id }) }
function ffScanCancel(id) { return ffPost('scan/cancel', { scanId: id }) }
function ffChat(message, path, selected) { return ffPost('chat', { message: message, path: path, selected: selected }) }
function ffChatHistory(limit) { return ffGet('chat/history', { limit: limit }) }
function ffChatPlan(message, path) { return ffPost('chat/plan', { message: message, path: path }) }
// 第 15 轮（m07306 ⑤）：预设整理方案——纯规则枚举，不调模型，点一下就有计划。
function ffPresets() { return ffGet('presets') }
// 第 17 轮（m07721）：设置读写 + 上传策略。策略判定在 host，client 只展示结果。
function ffGetSettings() { return ffGet('settings') }
function ffSetSettings(s) { return ffPost('settings', s || {}) }
function ffRecognizeCached(path, opts) { return ffPost('recognize/cached', { path: path, force: !!(opts && opts.force) }) }
function ffPreScan(path) { return ffPost('recognize/prescan', { path: path }) }
function ffPresetPlan(id, path) { return ffPost('preset', { id: id, path: path }) }
function ffPlan(message, path) { return ffPost('plan', { message: message, path: path }) }
function ffDryRun(batchId) { return ffPost('ops/dry-run', { batchId: batchId }) }
function ffExecute(batchId, ids, flags) { return ffPost('ops/execute', { batchId: batchId, approvedIds: ids, confirmFlags: flags || {} }) }
function ffUndo(batchId) { return ffPost('ops/undo', { batchId: batchId }) }
function ffBatches(limit) { return ffGet('ops/batches', { limit: limit }) }
function ffBatch(id) { return ffGet('ops/batch', { id: id }) }
function ffTags(path, tags, source) { return ffPost('tags', { path: path, tags: tags, source: source || 'user' }) }
function ffOpen(path, reveal) { return ffPost('open', { path: path, reveal: !!reveal }) }
// 第 2 轮 ③：AI 模型状态与选择（GET models / POST model）。
function ffModels() { return ffGet('models') }
function ffSetModel(sel) { return ffPost('model', sel || { auto: true }) }
// 第 2 轮 ②：浏览管理接缝（只读接口 + 菜单计划建批次；写仍走既有 ops/* 执行门）。
function ffCapacity(path) { return ffGet('capacity', { path: path }) }
function ffTagList() { return ffGet('tags') }
function ffThumb(path, w) { return ffGet('thumb', { path: path, w: w || 128 }) }
function ffMenuPlan(ctx) { return ffPost('ops/menu-plan', ctx) }
// 第 3 轮清理 P0：只读候选枚举 + 勾选路径建 planned 批次（不执行，AI 只写解释文案）。
function ffCleanCandidates() { return ffGet('clean/candidates') }
function ffCleanPlan(paths) { return ffPost('clean/plan', { paths: paths || [] }) }

// Client 侧格式化工具（纯函数，无 DOM 依赖）。
// 方向 A / WIG A23：大小与时间一律走 Intl.*，不手写单位换算与日期拼接。
function fdSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, i)
  const digits = i === 0 ? 0 : (value >= 100 ? 0 : value >= 10 ? 1 : 2)
  return new Intl.NumberFormat('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value) + ' ' + units[i]
}

function fdTime(iso) {
  if (!iso) return '—'
  const d = new Date(typeof iso === 'string' && /^\d+$/.test(iso) ? Number(iso) : iso)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
}

// 时间归一（第 25 轮）：接口给的 mtime 是 ISO 字符串，但旧代码有几处按毫秒数比较
// （Number(iso) → NaN → 恒为「很久以前」），结果「近 7 天修改」永远是 0。
// 所有时间比较一律先过这个函数，返回毫秒；无法解析时返回 0（视作远古，不误判为「刚改过」）。
function fdTimeMs(v) {
  if (v === null || v === undefined || v === '') return 0
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const s = String(v)
  if (/^\d+$/.test(s)) { const n = Number(s); return Number.isFinite(n) ? n : 0 }
  const t = new Date(s).getTime()
  return Number.isNaN(t) ? 0 : t
}

function fdKind(e) { return e && e.isDir ? '文件夹' : (e && e.ext ? String(e.ext).replace(/^\./, '').toUpperCase() + ' 文件' : '文件') }
function fdBase(p) { return String(p || '').split('/').filter(Boolean).pop() || '/' }
// 父目录：太长时保留首尾两段，中间用省略号，避免撑破属性格
function fdParent(p) {
  const parts = String(p || '').split('/').filter(Boolean)
  if (parts.length < 2) return '/'
  const dirs = parts.slice(0, -1)
  if (dirs.length <= 2) return '/' + dirs.join('/')
  return '/' + dirs[0] + '/…/' + dirs[dirs.length - 1]
}
function fdPct(a, b) { return b > 0 ? Math.round(a * 100 / b) : 0 }

// Client 能力面板组件：查重 / 相似 / 时间线 / 识别 / 对话抽屉 / 计划卡片 / 扫描进度。
// 纯脚本 + React.createElement（宿主 require('react')），不用 JSX、不用模板字符串。
var h = React.createElement

// DSH 侧栏工作台入口图标：Lucide（开源图标库，ISC License）官方 folder path。
// 出处 https://lucide.dev/icons/folder ，内嵌 path 数据符合 ISC 许可；线性 stroke 风格与插件内图标一致。
function FF_Icon(props) {
  return FF_Lucide({ nodes: FD_LUCIDE_FILE.folder, size: props && props.size ? props.size : 16 })
}

// 方向 A：标签不再直接吃扩展名表的饱和色，按 category 派生柔和底 + 细描边；文字必带。
function fdChipStyle(category) {
  var c = String(category || '')
  if (c === 'large_file' || c === 'video' || c === 'image' || c === 'presentation' || c === 'audio') return 'warm'
  if (c === 'folder' || c === 'document' || c === 'spreadsheet' || c === 'code' || c === 'archive') return 'cool'
  return 'neutral'
}
function FF_Tag(props) {
  return h('span', { className: 'fd-chip ' + fdChipStyle(props.category), title: props.category || '' }, props.name)
}
// 标签语义色：warm=需注意(cool/warm/neutral 三档)，色不单载信息，文字始终在。


// 乙方案：真类型图标（svg path），按 category 区分形状与色，不再是字母方块。
// 统一 UI 图标组件：走 Lucide 官方节点（FD_LUCIDE_UI），size 默认 14；filled 用于实心星。
function FF_UiIco(props) {
  var key = props.icon || 'close'
  // 文件类型键（folder/cloud/disk…）也可能从 UI 侧用到，两级表都查，最后才回落 close
  var nodes = FD_LUCIDE_UI[key] || FD_LUCIDE_FILE[key] || FD_LUCIDE_UI.close
  return FF_Lucide({ k: props.k, nodes: nodes, size: props.size || 14, className: props.className,
    filled: props.filled && key === 'star', strokeWidth: props.strokeWidth })
}

var FD_ICON_TINT = { folder: '#007aff', image: '#ff9500', video: '#ff3b30', audio: '#af52de',
  document: '#007aff', spreadsheet: '#34c759', presentation: '#ff9500', code: '#5856d6',
  archive: '#8e8e93', large_file: '#ff3b30', unknown: '#8e8e93',
  star: '#ff9500', disk: '#007aff', cloud: '#34c759' }
function fdIconKey(e) {
  if (e && e.isDir) return 'folder'
  var t = e && e.tags && e.tags[0]
  var c = t ? String(t.category || '') : ''
  if (c === 'large_file') return 'large_file'
  return FD_LUCIDE_FILE[c] ? c : 'unknown'
}
function FF_FileIcon(props) {
  var e = props.entry || {}
  var key = fdIconKey(e)
  var nodes = FD_LUCIDE_FILE[key] || FD_LUCIDE_FILE.unknown
  return FF_Lucide({ nodes: nodes, size: props.size || 22, className: 'fd-ico k-' + key,
    stroke: FD_ICON_TINT[key] || 'var(--fd-ink2)', strokeWidth: 1.7, filled: props.filled })
}

// 侧栏专用小图标（16px 线性 svg，与文件区 FF_FileIcon 同体系）。key ∈ FD_ICON_PATHS。
function FF_SideIco(props) {
  var key = props.icon || 'unknown'
  var nodes = FD_LUCIDE_FILE[key] || FD_LUCIDE_UI[key] || FD_LUCIDE_FILE.unknown
  return FF_Lucide({ nodes: nodes, size: props.size || 15, className: 'fd-side-svg',
    stroke: FD_ICON_TINT[key] || 'var(--fd-ink2)', strokeWidth: 1.7 })
}

// 文件区工具栏刷新图标：Lucide（开源图标库，ISC License）官方 refresh-cw path。
// 出处 https://lucide.dev/icons/refresh-cw ，内嵌 path 数据符合 ISC 许可；风格与 FF_Icon 一致。
function FF_RefreshIco(props) {
  return FF_Lucide({ nodes: FD_LUCIDE_UI.refresh, size: props && props.size ? props.size : 14 })
}

// 第 2 轮 ②：面包屑改用 crumbTrail —— 首段映射到卷根（修 onGo('/') 被白名单静默拦下的缺陷）。
function FF_Crumbs(props) {
  var trail = crumbTrail(props.path, props.volumes || [])
  var items = []
  trail.forEach(function (t, i) {
    if (i) items.push(h('span', { key: 'sep' + i, className: 'fd-sep' }, '/'))
    var label = t.label
    items.push(h('button', { key: t.path || i, className: 'fd-crumb' + (t.last ? ' is-on' : ''),
      disabled: !t.enabled, title: t.path || '',
      onClick: (function (pp, en) { return function () { if (en && pp) props.onGo(pp) } })(t.path, t.enabled) }, label))
  })
  return h('div', { className: 'fd-crumbs' }, items)
}

function FF_Msg(props) {
  var icon = props.icon || 'more'
  return h('div', { className: 'fd-msg' },
    h(FF_UiIco, { k: 'mi', icon: icon, size: 20, className: 'fd-msg-ico' }),
    h('div', null, props.children || props.text || ''))
}

// ---- 查重面板 ----
function FF_DupPanel(props) {
  var data = props.data, error = props.error, loading = props.loading
  var onRescan = props.onRescan, onPlan = props.onPlan
  if (loading) return h('div', { className: 'fd-panel' }, h(FF_Msg, { text: '正在查找重复文件…' }))
  if (error) return h('div', { className: 'fd-panel' }, h('div', { className: 'fd-err fd-msg' }, error))
  if (!data) return h('div', { className: 'fd-panel' }, h(FF_Msg, { text: '点「查重」扫描当前卷，或直接扫描后查看重复组。' }))
  var groups = data.groups || []
  if (!groups.length) return h('div', { className: 'fd-panel' }, h('div', { className: 'fd-panel-h' }, '文件查重 · 无重复'), h(FF_Msg, { text: '索引里没有发现完全相同的文件。先点顶栏「扫描」建立索引。' }), h('div', { className: 'fd-actions' }, h('button', { className: 'fd-btn', onClick: onRescan }, '重新查询')))
  var cards = groups.map(function (g, i) {
    var rows = (g.items || []).map(function (it) {
      var isKeep = g.keepSuggestion && g.keepSuggestion.keep === it.path
      return h('div', { key: it.path, className: 'fd-dup-item' },
        h('span', { className: 'fd-path', title: it.path }, fdBase(it.path)),
        h('span', { className: 'fd-num' }, fdSize(it.size)),
        isKeep ? h('span', { className: 'fd-keep' }, '建议保留') : null
      )
    })
    return h('div', { key: i, className: 'fd-card' },
      h('h4', null, '重复组 ' + (i + 1) + ' · ' + (g.items || []).length + ' 份 · ' + fdSize(g.size)),
      h('p', null, 'SHA-256 ' + String(g.hash || '').slice(0, 16) + '… · ' + (g.state === 'full' ? '已全量校验' : '未全量校验')),
      rows,
      h('p', null, g.keepSuggestion ? g.keepSuggestion.reason : ''),
      h('div', { className: 'fd-actions' },
        h('button', { className: 'fd-btn', onClick: function () { onPlan && onPlan(g) } }, '生成清理计划')
      )
    )
  })
  return h('div', { className: 'fd-panel' },
    h('div', { className: 'fd-panel-h' }, '文件查重 · ' + groups.length + ' 组',
      h('button', { className: 'fd-btn', onClick: onRescan }, '刷新')),
    h('p', { className: 'fd-note' }, '按 size → 部分哈希 → 全量 SHA-256 三级判据找完全相同的文件。建议只是文案，绝不自动删除。'),
    h('div', { className: 'fd-grid' }, cards)
  )
}

// ---- 相似面板 ----
function FF_SimPanel(props) {
  var data = props.data, error = props.error, loading = props.loading, target = props.target
  if (!target) return h('div', { className: 'fd-panel' }, h(FF_Msg, { text: '在文件表里点选一个文件，查看与它相似的文件。' }))
  if (loading) return h('div', { className: 'fd-panel' }, h(FF_Msg, { text: '正在查找相似文件…' }))
  if (error) return h('div', { className: 'fd-panel' }, h('div', { className: 'fd-err fd-msg' }, error))
  var strong = data ? (data.strong || []) : []
  var weak = data ? (data.weak || []) : []
  function render(items, strength) {
    if (!items.length) return h(FF_Msg, { text: strength === 'weak' ? '没有弱信号候选。' : '没有找到强相似文件。' })
    return items.map(function (it) {
      return h('div', { key: it.path, className: 'fd-dup-item' },
        h('span', { className: 'fd-path', title: it.path }, fdBase(it.path)),
        h('span', { className: 'fd-num' }, fdSize(it.size)),
        h('span', { className: strength === 'weak' ? 'fd-weak' : 'fd-keep' }, it.basis + (it.distance !== undefined ? ' · 距离 ' + it.distance : ''))
      )
    })
  }
  return h('div', { className: 'fd-panel' },
    h('div', { className: 'fd-panel-h' }, '相似文件 · ' + (target && target.path ? fdBase(target.path) : fdBase(target))),
    h('div', { className: 'fd-card' }, h('h4', null, '强相似（可据以判断）'), render(strong, 'strong')),
    h('div', { className: 'fd-card' }, h('h4', null, '弱信号（仅供参考，不可批量操作）'), render(weak, 'weak'))
  )
}

// ---- 时间线面板 ----
function FF_TimelinePanel(props) {
  var data = props.data, error = props.error, loading = props.loading, target = props.target, onAll = props.onAll
  if (loading) return h('div', { className: 'fd-panel' }, h(FF_Msg, { text: '正在读取时间线…' }))
  if (error) return h('div', { className: 'fd-panel' }, h('div', { className: 'fd-err fd-msg' }, error))
  var events = data ? (data.events || []) : []
  var labels = { created: '出现', modified: '被修改', moved: '被移动', renamed: '重命名', deleted: '被删除', tagged: '被标记', seen: '扫描到', undo: '撤销', copy: '复制', hash_checked: '校验' }
  var rows = events.length ? events.map(function (e, i) {
    return h('div', { key: i, className: 'fd-timeline-item' },
      h('span', { className: 'fd-timeline-time' }, fdTime(e.at)),
      h('span', null, fdBase(e.path || e.to_path || e.from_path || '')),
      h('span', { style: { color: 'var(--fd-ink2)' } }, labels[e.kind] || e.kind),
      e.from_path && e.to_path && e.from_path !== e.to_path ? h('span', { className: 'fd-note' }, fdBase(e.from_path) + ' → ' + fdBase(e.to_path)) : null
    )
  }) : [h(FF_Msg, { key: 'empty', text: '还没有事件。扫描目录、移动文件或打标签后，这里会记录变更时间线（只记事件，不存内容快照）。' })]
  return h('div', { className: 'fd-panel' },
    h('div', { className: 'fd-panel-h' }, target ? ('变更时间线 · ' + fdBase(target)) : '变更时间线 · 全部',
      h('button', { className: 'fd-btn', onClick: onAll }, '看全部')),
    rows
  )
}

// ---- 识别面板 ----
function FF_RecognizePanel(props) {
  var data = props.data, error = props.error, loading = props.loading, target = props.target
  if (!target) return h('div', { className: 'fd-panel' }, h(FF_Msg, { text: '在文件表里点选一个文件，识别它是什么、从哪来、怎么用。' }))
  if (loading) return h('div', { className: 'fd-panel' }, h(FF_Msg, { text: '正在识别（本地信号 + 宿主模型）…' }))
  if (error) return h('div', { className: 'fd-panel' }, h('div', { className: 'fd-err fd-msg' }, error))
  if (!data) return h('div', { className: 'fd-panel' }, h(FF_Msg, { text: '点「识别」开始。' }))
  var card = data.card || {}, sig = data.signals || {}
  function row(k, v) { return h('div', { className: 'fd-kv' }, h('span', null, k), h('span', null, v == null || v === '' ? '—' : String(v))) }
  var ev = (card.evidence || []).map(function (e, i) { return h('span', { key: i }, e) })
  return h('div', { className: 'fd-panel' },
    h('div', { className: 'fd-panel-h' }, '智能识别 · ' + fdBase(target)),
    h('div', { className: 'fd-card' },
      h('h4', null, card.what || '未知'),
      row('从哪来', card.sourceUnknown ? '来源未知' : card.from),
      row('通常怎么用', card.usage === 'unknown' ? '证据不足，未判断' : card.usage),
      row('能否安全清理', card.cleanable === 'unknown' ? '不确定' : card.cleanable),
      row('置信度', (card.confidence != null ? Math.round(card.confidence * 100) : 0) + '%'),
      card.sourceUnknown ? h('p', { className: 'fd-note' }, '这个文件没有可观测的下载来源信号（whereFroms 为空，SMB 卷尤甚），所以显示为「来源未知」，不会编造来源。') : null,
      ev.length ? h('div', { className: 'fd-evidence' }, ev) : null
    ),
    h('div', { className: 'fd-card' },
      h('h4', null, '已知信号（本地采集，未外传）'),
      row('大小', fdSize(sig.size)),
      row('类型', sig.content_type || sig.ext || '—'),
      row('修改时间', fdTime(sig.mtime)),
      row('图片尺寸', sig.image_width && sig.image_height ? (sig.image_width + ' × ' + sig.image_height) : '—'),
      row('Finder 标签', (sig.finder_tags || []).join('、') || '—'),
      row('感知哈希', sig.phash ? String(sig.phash).slice(0, 16) : '—'),
      row('文本指纹', sig.text_fp ? String(sig.text_fp).slice(0, 16) : '—')
    )
  )
}

// ---- 计划卡片（逐项勾选 → dry-run → 执行 → 撤销）----
function FF_PlanCard(props) {
  var plan = props.plan, batchId = plan.batchId
  var checked = props.checked || {}, onToggle = props.onToggle
  var dry = props.dry, execResult = props.execResult, busy = props.busy
  var onDry = props.onDry, onExec = props.onExec, onUndo = props.onUndo
  var items = plan.items || []
  var allIds = items.map(function (it) { return it.id })
  var chosen = allIds.filter(function (id) { return checked[id] })
  var status = execResult ? execResult.status : null
  var done = status === 'done' || status === 'rolled_back' || (execResult && execResult.idempotent)
  var canUndo = status === 'done' || status === 'failed'
  return h('div', { className: 'fd-planbox' },
    h('h4', null, '整理计划 · ' + (plan.reply || '')),
    // 第 15 轮（m07306 ③）：写清作用范围，否则用户不知道 AI 是在哪个目录上动手
    h('p', { className: 'fd-plan-scope', title: plan.at || props.path || '' },
      (plan.at ? '作用目录 ' + plan.at : '作用目录 ' + (props.path || '未标注')) +
      (plan.scanned ? '（扫描 ' + plan.scanned + ' 项）' : '')),
    plan.dropped ? h('p', { className: 'fd-note' }, '已丢弃 ' + plan.dropped + ' 个越界/失效路径。') : null,
    items.map(function (it) {
      return h('label', { key: it.id, className: 'fd-check' },
        h('input', { type: 'checkbox', disabled: done || busy, checked: !!checked[it.id], onChange: function () { onToggle && onToggle(it.id) } }),
        h('span', null, '[' + it.op + '] ' + fdBase(it.src) + (it.dst ? ' → ' + fdBase(it.dst) : '') + (it.reason ? ' · ' + it.reason : ''))
      )
    }),
    dry ? h('div', { className: 'fd-card', style: { marginTop: 8 } },
      h('h4', null, '预检结果 · ' + (dry.items || []).length + ' 项可执行 / ' + (dry.blocked || []).length + ' 项已拦截'),
      (dry.items || []).map(function (d, i) {
        return h('div', { key: i, className: 'fd-kv' },
          h('span', null, '[' + d.op + '] ' + fdBase(d.src)),
          h('span', null, d.willOverwrite ? '目标已存在' : (d.crossVolume ? '跨卷·需单独确认' : '就绪')))
      }),
      (dry.blocked || []).map(function (d, i) {
        return h('div', { key: 'b' + i, className: 'fd-kv' }, h('span', null, fdBase(d.src)), h('span', { className: 'fd-err' }, d.reason))
      })
    ) : null,
    execResult ? h('div', { className: 'fd-card', style: { marginTop: 8 } },
      h('h4', null, '执行结果 · ' + execResult.status),
      (execResult.items || []).map(function (r, i) {
        return h('div', { key: i, className: 'fd-kv' }, h('span', null, fdBase(r.src || '')), h('span', { className: r.status === 'failed' ? 'fd-err' : (r.status === 'done' || r.status === 'restored' ? 'fd-keep' : '') }, r.status + (r.error ? ' · ' + r.error : '')))
      })
    ) : null,
    h('div', { className: 'fd-actions' },
      !dry && !done ? h('button', { className: 'fd-btn', disabled: busy || !chosen.length, onClick: function () { onDry && onDry(batchId) } }, busy ? '处理中…' : '预检（' + chosen.length + ' 项）') : null,
      dry && !done ? h('button', { className: 'fd-btn', disabled: busy || !chosen.length, onClick: function () { onExec && onExec(batchId, chosen) } }, busy ? '处理中…' : '确认执行（' + chosen.length + ' 项）') : null,
      canUndo ? h('button', { className: 'fd-btn', disabled: busy, onClick: function () { onUndo && onUndo(batchId) } }, '撤销这一批') : null
    )
  )
}



// FF_SETTINGS_FALLBACK：client 侧兜底默认值（与 host 侧 src/settings.js 的 DEFAULT_SETTINGS 一致）。
// 为什么需要：设置存在 host 侧 ~/.flowfile/settings.json，而 host 半片要重启 DSH 才生效；
// 没有兜底时设置页会显示「设置尚未加载」，用户不知道是没加载还是坏了。
// 注意：这里只有默认值，**任何判定（能不能上传）都在 host**，改这份不影响安全性。
var FF_SETTINGS_FALLBACK = {
  version: 1,
  ai: { mode: 'off', localBaseUrl: 'http://127.0.0.1:11434/v1', localModel: '', allowCloud: false, timeoutMs: 60000 },
  recognize: { preScan: false, preScanDepth: 1, preScanLimit: 20, cacheDays: 30, autoTags: true }
}
// ---- 设置面板（第 17 轮 m07721）：智能识别默认关闭；本地 AI / 预识别可选；上传需显式授权 ----
// 这里只渲染与提交，真正的安全判定在 host 侧 src/settings.js 的 uploadPolicy()，UI 骗不过去。
function FF_SettingsPanel(props) {
  var s = props.settings || null
  var busy = props.busy
  var onSave = props.onSave
  var onReload = props.onReload
  // 兜底：拿到默认值也比空白强；offline 时明确告知设置服务未就绪（多半是 host 半片没加载）。
  if (!s) s = FF_SETTINGS_FALLBACK
  var ai = s.ai || {}
  var rc = s.recognize || {}
  function setAi(patch) { props.onChange({ ai: Object.assign({}, ai, patch), recognize: rc }) }
  function setRc(patch) { props.onChange({ ai: ai, recognize: Object.assign({}, rc, patch) }) }
  // offline 时 host 没给策略，这里按同一口径在本地推导一份**展示用**文案；
  // 真正的判定永远是 host 的 uploadPolicy()，这里只影响提示文字，改错也不会导致上传。
  var uplink = props.uplink || (ai.mode === 'off'
    ? { reason: '识别已关闭（默认），只显示规则标签，不调用任何模型' }
    : (ai.mode === 'local'
      ? { reason: /^http:\/\/(127\.|localhost|\[::1\])/.test(String(ai.localBaseUrl || '')) ? '本地 AI：数据不出本机' : '本地端点不是本机回环地址，会被拒绝' }
      : { reason: ai.allowCloud ? '宿主模型：文件元数据可能被 AI 服务商处理（已授权）' : '未勾选同意上传，不会发出任何内容' }))
  if (props.offline && uplink.reason) uplink = Object.assign({}, uplink, { reason: uplink.reason + '（设置服务未就绪）' })
  var modeOpts = [
    h('option', { key: 'off', value: 'off' }, '关闭（默认，不调用任何模型）'),
    h('option', { key: 'local', value: 'local' }, '本地 AI（仅本机回环地址）'),
    h('option', { key: 'host', value: 'host' }, '宿主默认模型（可能上传元数据）')
  ]
  return h('div', { className: 'fd-settings' },
    props.offline ? h('p', { className: 'fd-settings-warn' }, '设置服务未就绪（host 半片需要重启 DSH 才加载）。下面显示的是出厂默认值：识别关闭、不上传。') : null,
    h('h4', null, '智能识别'),
    h('p', { className: 'fd-settings-note' }, '默认关闭。关闭时只按扩展名规则打标签，不联网、不调用模型、不上传任何内容。'),
    h('div', { className: 'fd-field' },
      h('label', null, '识别方式'),
      h('select', { value: ai.mode || 'off', onChange: function (e) { setAi({ mode: e.target.value }) } }, modeOpts)),
    ai.mode === 'local' ? h('div', { className: 'fd-field' },
      h('label', null, '本地端点'),
      h('input', { value: ai.localBaseUrl || '', placeholder: 'http://127.0.0.1:11434/v1',
        onChange: function (e) { setAi({ localBaseUrl: e.target.value }) } }),
      h('span', { className: 'fd-field-hint' }, '只接受 127.0.0.1 / localhost / ::1；填内网或公网地址会被拒绝。')) : null,
    ai.mode === 'local' ? h('div', { className: 'fd-field' },
      h('label', null, '模型名'),
      h('input', { value: ai.localModel || '', placeholder: '留空用端点默认模型',
        onChange: function (e) { setAi({ localModel: e.target.value }) } })) : null,
    ai.mode === 'host' ? h('label', { className: 'fd-check fd-settings-danger' },
      h('input', { type: 'checkbox', checked: ai.allowCloud === true,
        onChange: function (e) { setAi({ allowCloud: e.target.checked }) } }),
      h('span', null, '我了解：文件元数据（名称、大小、类型、时间等）可能被 AI 服务商处理，同意后才会上传')) : null,
    ai.mode !== 'off' ? h('p', { className: 'fd-settings-warn' },
      '注意：识别开启后，可能把文件元数据（甚至文本片段）发给模型服务。' +
      (ai.mode === 'host' ? '当前选择的是宿主模型，数据可能离开本机。' : '') +
      '不建议在不清楚后果时开启。') : null,
    h('p', { className: 'fd-settings-state' }, '当前策略：' + (uplink.reason || '—')),

    h('h4', { style: { marginTop: 18 } }, '预识别'),
    h('p', { className: 'fd-settings-note' }, '开启后进入目录时主动识别首层文件。会产生模型调用，默认关闭。'),
    h('label', { className: 'fd-check' },
      h('input', { type: 'checkbox', checked: rc.preScan === true,
        onChange: function (e) { setRc({ preScan: e.target.checked }) } }),
      h('span', null, '进入目录时主动识别首层文件')),
    rc.preScan ? h('div', { className: 'fd-field' },
      h('label', null, '最多识别'),
      h('input', { type: 'number', min: 1, max: 200, value: rc.preScanLimit || 20,
        onChange: function (e) { setRc({ preScanLimit: Number(e.target.value) || 20 }) } }),
      h('span', { className: 'fd-field-hint' }, '个文件（1–200）')) : null,

    h('h4', { style: { marginTop: 18 } }, '缓存'),
    h('label', { className: 'fd-check' },
      h('input', { type: 'checkbox', checked: rc.autoTags !== false,
        onChange: function (e) { setRc({ autoTags: e.target.checked }) } }),
      h('span', null, '识别结果自动派生成标签')),
    h('div', { className: 'fd-field' },
      h('label', null, '保留天数'),
      h('input', { type: 'number', min: 0, max: 3650, value: rc.cacheDays == null ? 30 : rc.cacheDays,
        onChange: function (e) { setRc({ cacheDays: Number(e.target.value) || 0 }) } }),
      h('span', { className: 'fd-field-hint' }, '0 表示不自动清理')),

    h('div', { className: 'fd-actions', style: { marginTop: 16 } },
      h('button', { className: 'fd-btn primary', disabled: busy, onClick: onSave }, busy ? '保存中…' : '保存设置'),
      h('button', { className: 'fd-btn', disabled: busy, onClick: onReload }, '重新读取')),
    h('p', { className: 'fd-settings-note', style: { marginTop: 14 } },
      '安全说明：未经你明确允许，FlowFile 不会上传任何本地文件。关闭识别或选择「本地 AI」时，内容只在本机处理。')
  )
}
// ---- 对话抽屉 ----
function FF_Chat(props) {
  var open = props.open, onToggle = props.onToggle
  var messages = props.messages || [], input = props.input, onInput = props.onInput, onSend = props.onSend, busy = props.busy
  // 第 2 轮 ③：模型下拉状态与回调从 FD_App 传入，Chat 只负责渲染。
  var models = props.models, onModel = props.onModel
  var planProps = props.planProps || {}
  var logRef = React.useRef(null)
  React.useEffect(function () { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, [messages.length, open])
  var bubbles = messages.map(function (m) {
    var isUser = m.role === 'user'
    var plan = m.payload && m.payload.kind === 'plan' && m.payload.plan ? m.payload.plan : null
    var bid = m.batch_id || (plan && plan.batchId)
    var card = plan ? h(FF_PlanCard, Object.assign({ plan: plan }, planProps[bid] || {})) : null
    return h('div', { key: m.id, className: 'fd-bubble ' + (isUser ? 'user' : 'ai') },
      m.content || '',
      card
    )
  })
  return h('div', { className: 'fd-chat' },
    h('div', { className: 'fd-chat-h', onClick: onToggle },
      h('b', null, 'FlowFile 对话'),
      h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(FF_UiIco, { k: 'dc', icon: open ? 'chevronD' : 'chevronR', size: 11 }), open ? '收起' : '展开'),
      // 阻止冒泡：点下拉/点「对话」标题区不触发抽屉收起。
      h('select', { className: 'fd-model', value: models && models.currentKey ? models.currentKey : 'auto', disabled: !models || models.busy,
        onClick: function (e) { e.stopPropagation() }, onChange: function (e) { e.stopPropagation(); onModel && onModel(e.target.value) }, title: '选择对话/整理计划使用的模型' },
        h('option', { value: 'auto' }, (models && models.autoLabel) || '跟随宿主默认'),
        ((models && models.routes) || []).map(function (r) {
          return r.available ? (r.models || []).map(function (m) {
            return h('option', { key: r.provider + '/' + m, value: r.provider + '/' + m }, r.provider + ' · ' + m)
          }) : h('option', { key: r.provider + '/off', value: r.provider + '/off', disabled: true }, r.provider + ' · 不可用')
        })
      ),
      h('span', { className: 'fd-note', style: { marginLeft: 'auto' } }, '工作台内自建对话，与宿主会话独立'),
    ),
    open ? h('div', { className: 'fd-chat-log', ref: logRef },
      bubbles.length ? bubbles : h(FF_Msg, { text: '说点什么，例如「把大于 100MB 的挑出来」「找重复文件」。' })
    ) : null,
    open ? h('div', { className: 'fd-chat-input' },
      h('input', { placeholder: '针对当前目录提问或下整理指令…', value: input, onChange: function (e) { onInput(e.target.value) }, onKeyDown: function (e) { if (e.key === 'Enter' && !busy) onSend() } }),
      h('button', { className: 'fd-btn', disabled: busy || !String(input || '').trim(), onClick: onSend }, busy ? '…' : '发送')
    ) : null
  )
}

// ---- 扫描进度 ----
function FF_ScanBar(props) {
  var scan = props.scan, onScan = props.onScan, onCancel = props.onCancel, path = props.path
  if (!scan) return h('button', { className: 'fd-btn', onClick: function () { onScan(path) }, title: '扫描当前目录建立索引' }, '扫描')
  var running = scan.state === 'running' || scan.state === 'queued'
  var pct = fdPct(scan.done, scan.total)
  return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 200 } },
    h('span', { className: 'fd-note' }, running ? (scan.state === 'queued' ? '排队中' : '扫描 ' + scan.done + '/' + (scan.total || '?')) : ('扫描' + (scan.state === 'done' ? '完成' : scan.state === 'cancelled' ? '已取消' : scan.state === 'failed' ? '失败' : ''))),
    running ? h('div', { className: 'fd-progress', style: { flex: 1 } }, h('i', { style: { width: pct + '%' } })) : null,
    running ? h('button', { className: 'fd-btn', onClick: function () { onCancel(scan.id) } }, '取消') : h('button', { className: 'fd-btn', onClick: function () { onScan(path) } }, '重扫')
  )
}

// FlowFile 第2轮 ② P0 浏览管理：Client 组件层。
// 纯脚本 + React.createElement；全局可用 browse-core.js（crumbTrail/menuFor/statusFor 等）、
// api.js（ff* 封装）、format.js（fdSize/fdTime/fdBase）、client-ui.js（FF_FileIcon/FF_Tag）里的顶层符号。
// 约定：组件只渲染 + 回调，不持有跨组件状态；所有状态机由 FD_App 集中管理。
var h = React.createElement

// ---- 顶栏导航：前进/后退/地址栏/上级/刷新/视图切换/列显隐/收藏 ----
function FF_NavBar(props) {
  var c = []
  c.push(h('button', { key: 'back', className: 'fd-btn fd-nav', disabled: !props.canBack, onClick: props.onBack, title: '后退（⌘[）', 'aria-label': '后退' }, h(FF_UiIco, { k: 'back', icon: 'back', size: 13 })))
  c.push(h('button', { key: 'fwd', className: 'fd-btn fd-nav', disabled: !props.canForward, onClick: props.onForward, title: '前进（⌘]）', 'aria-label': '前进' }, h(FF_UiIco, { k: 'fwd', icon: 'forward', size: 13 })))
  c.push(h('input', { key: 'addr', className: 'fd-addr', value: props.address, placeholder: '输入绝对路径后回车…',
    onChange: function (e) { props.onAddress(e.target.value) },
    onKeyDown: function (e) { if (e.key === 'Enter') props.onGoAddress() }, 'aria-label': '地址栏' }))
  c.push(h('button', { key: 'go', className: 'fd-btn', onClick: props.onGoAddress, title: '跳到地址' }, '前往'))
  c.push(h('button', { key: 'up', className: 'fd-btn fd-ico-btn', disabled: !props.canUp, onClick: props.onUp, title: '上级目录', 'aria-label': '上级目录' }, h(FF_UiIco, { k: 'up', icon: 'up', size: 13 })))
  c.push(h('button', { key: 'refresh', className: 'fd-btn fd-ico-btn', onClick: props.onRefresh, title: '刷新', 'aria-label': '刷新' }, h(FF_RefreshIco, { size: 14 })))
  c.push(h('button', { key: 'fav', className: 'fd-btn' + (props.isFav ? ' primary' : ''), onClick: props.onToggleFav,
    title: props.isFav ? '从收藏移除' : '收藏当前目录', 'aria-label': '收藏' }, h(FF_UiIco, { k: 'fav', icon: 'star', size: 13, filled: !!props.isFav })))
  c.push(h('span', { key: 'sp', className: 'fd-nav-sep' }))
  c.push(h('button', { key: 'view', className: 'fd-btn fd-ico-btn', onClick: props.onView, title: props.viewMode === 'grid' ? '切换到列表视图' : '切换到网格视图', 'aria-label': '切换视图' },
    h(FF_UiIco, { k: 'view', icon: props.viewMode === 'grid' ? 'list' : 'grid', size: 13 })))
  c.push(h('button', { key: 'cols', className: 'fd-btn fd-ico-btn', onClick: props.onCols, title: '列显隐与宽度', 'aria-label': '列设置' }, h(FF_UiIco, { k: 'cols', icon: 'columns', size: 13 })))
  return h('div', { className: 'fd-nav' }, c)
}

// ---- 列显隐面板 ----
function FF_ColPanel(props) {
  var cols = props.columns || []
  var rows = cols.map(function (col) {
    return h('label', { key: col.key, className: 'fd-col-row' },
      h('input', { type: 'checkbox', checked: col.visible, disabled: col.key === 'name',
        onChange: function () { props.onToggle(col.key) } }),
      h('span', null, col.label),
      col.key !== 'name' ? h('input', { type: 'number', className: 'fd-col-w', min: 60, max: 600,
        value: col.width == null ? '' : col.width, placeholder: 'auto',
        onChange: function (e) { props.onWidth(col.key, e.target.value === '' ? null : e.target.value) } }) : null)
  })
  return h('div', { className: 'fd-popover fd-col-panel' },
    h('div', { className: 'fd-pop-h' }, '列显隐与宽度'), rows,
    h('button', { className: 'fd-btn', onClick: props.onReset }, '恢复默认'))
}

// ---- 可排序表头（三击复原）----
// 动态列栅格 CSS：放在 FD_CSS 之后、用 .fd-root 前缀提高特异性，并自带窄屏降级。
// 这样「列显隐/宽度」与 320/2560/200% 六档都不横向溢出。
function fdGridCSS(cols) {
  var vis = (cols || []).filter(function (c) { return c.visible })
  function grid(list) { return list.map(function (c) { return c.width == null ? 'minmax(0,1fr)' : (c.width + 'px') }).join(' ') }
  var base = grid(vis)
  // 断点与 client-style.js 基础 CSS 严格对齐：≤900 显示 3 列（隐藏第 4 起）、≤560 显示 2 列（隐藏第 3 起）。
  var n3 = grid(vis.slice(0, 3))
  var n2 = grid(vis.slice(0, 2))
  return '.fd-root .fd-row{grid-template-columns:' + base + '}' +
    '@media(max-width:900px){.fd-root .fd-row{grid-template-columns:' + n3 + '}.fd-root .fd-row > *:nth-child(n+4){display:none}}' +
    '@media(max-width:560px){.fd-root .fd-row{grid-template-columns:' + n2 + '}.fd-root .fd-row > *:nth-child(n+3){display:none}}'
}

function FF_Head(props) {
  var cols = (props.columns || []).filter(function (c) { return c.visible })
  var cells = cols.map(function (c) {
    var on = props.sort && props.sort.key === c.key
    var arrow = on ? (props.sort.dir === 'desc' ? ' ↓' : ' ↑') : ''
    return h('button', { key: c.key, className: 'fd-th' + (on ? ' is-sorted' : ''), onClick: function () { props.onSort(c.key) },
      title: '点击排序，再点反向，第三下复原' }, c.label + arrow)
  })
  return h('div', { className: 'fd-row fd-head' + (props.compact ? ' compact' : '') }, cells)
}

// ---- 单条文件行 ----
function FF_Row(props) {
  var e = props.entry, cols = (props.columns || []).filter(function (c) { return c.visible })
  var cells = cols.map(function (c) {
    if (c.key === 'name') return h('div', { key: 'name', className: 'fd-name' },
      h(FF_FileIcon, { entry: e }), h('span', { title: e.path }, e.name))
    if (c.key === 'size') return h('span', { key: 'size', className: 'fd-num' }, e.isDir ? '—' : fdSize(e.size))
    if (c.key === 'mtime') return h('span', { key: 'mtime', className: 'fd-time' }, fdTime(e.mtime))
    if (c.key === 'tags') return h('div', { key: 'tags', className: 'fd-tags' }, (e.tags || []).map(function (t) {
      return h(FF_Tag, { key: t.name, name: t.name, color: t.color, category: t.category })
    }))
    return null
  })
  return h('div', { className: 'fd-row' + (props.selected ? ' is-on' : '') + (props.cutting ? ' is-cut' : ''),
    role: 'row', tabIndex: 0, 'aria-selected': !!props.selected,
    'aria-label': (e.isDir ? '文件夹 ' : '文件 ') + e.name,
    style: props.gridStyle ? { gridTemplateColumns: props.gridStyle } : null,
    onClick: function (ev) { props.onPick(e, ev) },
    onDoubleClick: function (ev) { props.onOpen && props.onOpen(e, ev) },
    onContextMenu: function (ev) { props.onContext(e, ev) },
    onKeyDown: function (ev) { props.onKeyDown && props.onKeyDown(e, ev) } }, cells)
}

// ---- 网格视图（真实缩略图，异步由 FD_App 预取）----
function FF_Grid(props) {
  var tiles = (props.entries || []).map(function (e) {
    var thumb = props.thumbs ? props.thumbs[e.path] : null
    var media = thumb ? h('img', { className: 'fd-thumb-img', src: thumb, alt: '', loading: 'lazy' })
      : (canThumb(e) ? h('div', { className: 'fd-thumb-ph' }, '…') : h(FF_FileIcon, { entry: e, size: 34 }))
    return h('div', { key: e.path, className: 'fd-tile' + (props.selected && props.selected[e.path] ? ' is-on' : ''),
      role: 'button', tabIndex: 0, title: e.path,
      onClick: function (ev) { props.onPick(e, ev) },
      onDoubleClick: function (ev) { props.onOpen && props.onOpen(e, ev) },
      onContextMenu: function (ev) { props.onContext(e, ev) } },
      h('div', { className: 'fd-thumb' + (e.isDir ? ' dir' : '') }, media),
      h('div', { className: 'fd-tile-name', title: e.name }, e.name),
      h('div', { className: 'fd-tile-sub' }, e.isDir ? '文件夹' : fdSize(e.size)))
  })
  return h('div', { className: 'fd-grid-view' }, tiles.length ? tiles
    : h('div', { className: 'fd-empty' }, h('b', null, '这里没有文件'), h('span', null, '换个目录或清除筛选试试')))
}

// ---- 右键动态菜单 ----
function FF_ContextMenu(props) {
  var items = props.items || []
  var rows = items.map(function (it, i) {
    if (it.sep) return h('div', { key: 's' + i, className: 'fd-menu-sep' })
    return h('button', { key: it.id, className: 'fd-menu-item' + (it.danger ? ' danger' : ''),
      disabled: !it.enabled, onClick: function () { if (it.enabled) props.onAction(it.id) } }, it.label)
  })
  return h('div', { className: 'fd-context-menu', style: { left: props.x, top: props.y },
    onClick: function (e) { e.stopPropagation() } }, rows)
}

// ---- 状态栏（六态 + 每态给下一步）----
function FF_StatusBar(props) {
  var s = props.status || {}
  var tone = s.tone || 'ok'
  return h('div', { className: 'fd-status' },
    h('span', { className: 'fd-status-dot ' + tone }),
    h('span', { className: 'fd-status-text' }, s.text),
    s.label && s.label !== '就绪' ? h('span', { className: 'fd-status-badge ' + tone }, s.label) : null,
    s.hint ? h('span', { className: 'fd-status-hint' }, s.hint) : null,
    h('span', { className: 'fd-status-sp' }),
    h('span', { className: 'fd-status-view' }, props.viewMode === 'grid' ? '网格' : '列表'))
}

// ---- 冲突三选 ----
function FF_ConflictDialog(props) {
  var list = (props.conflicts || []).map(function (p, i) { return h('div', { key: i, className: 'fd-kv' }, h('span', null, fdBase(p))) })
  var opts = [
    { id: 'keep', label: '保留两者', desc: '新文件自动改名（如 a 2.txt），旧文件不动' },
    { id: 'replace', label: '替换', desc: '旧文件先进回收站（可撤销），再写入新文件' },
    { id: 'skip', label: '跳过', desc: '冲突的文件不处理，其余照常' }
  ]
  return h('div', { className: 'fd-modal-mask', onClick: props.onCancel },
    h('div', { className: 'fd-modal', onClick: function (e) { e.stopPropagation() } },
      h('h4', null, '发现 ' + (props.conflicts || []).length + ' 个同名文件'),
      h('div', { className: 'fd-modal-list' }, list),
      h('div', { className: 'fd-choice-list' }, opts.map(function (o) {
        return h('button', { key: o.id, className: 'fd-choice', onClick: function () { props.onChoose(o.id) } },
          h('b', null, o.label), h('span', null, o.desc))
      })),
      h('div', { className: 'fd-actions' }, h('button', { className: 'fd-btn', onClick: props.onCancel }, '取消'))))
}

// ---- 输入弹窗（新建文件夹 / 重命名）----
function FF_InputDialog(props) {
  return h('div', { className: 'fd-modal-mask', onClick: props.onCancel },
    h('div', { className: 'fd-modal fd-modal-sm', onClick: function (e) { e.stopPropagation() } },
      h('h4', null, props.title),
      h('input', { className: 'fd-modal-input', autoFocus: true, value: props.value, placeholder: props.placeholder || '',
        onChange: function (e) { props.onChange(e.target.value) },
        onKeyDown: function (e) { if (e.key === 'Enter') props.onSubmit(); if (e.key === 'Escape') props.onCancel() } }),
      props.error ? h('div', { className: 'fd-err' }, props.error) : null,
      h('div', { className: 'fd-actions' },
        h('button', { className: 'fd-btn primary', disabled: !String(props.value || '').trim(), onClick: props.onSubmit }, '确定'),
        h('button', { className: 'fd-btn', onClick: props.onCancel }, '取消'))))
}

// ---- 标签编辑（7 色，色点 + 名称，不单靠色）----
function FF_TagEditor(props) {
  var cur = props.current || []
  var palette = FF_TAG_COLORS.map(function (c) {
    return h('span', { key: c.id, className: 'fd-tag-dot', style: { background: c.hex }, title: c.name + ' ' + c.hex })
  })
  var chosen = (props.allTags || []).map(function (t) {
    var on = cur.indexOf(t.name) >= 0
    return h('button', { key: t.name, className: 'fd-tag-opt' + (on ? ' is-on' : ''),
      onClick: function () { props.onToggle(t.name, !on) } },
      h('span', { className: 'fd-tag-dot sm', style: { background: t.color || 'var(--fd-ink3)' } }), t.name)
  })
  return h('div', { className: 'fd-tag-editor' },
    h('div', { className: 'fd-tag-palette' }, palette),
    h('div', { className: 'fd-tag-list' }, chosen.length ? chosen : h('span', { className: 'fd-note' }, '还没有标签，输入名称新建一个。')),
    h('div', { className: 'fd-tag-new' },
      h('input', { placeholder: '新标签名称', value: props.newName || '', onChange: function (e) { props.onNewName(e.target.value) },
        onKeyDown: function (e) { if (e.key === 'Enter') props.onAdd() } }),
      h('button', { className: 'fd-btn', disabled: !String(props.newName || '').trim(), onClick: props.onAdd }, '添加')),
    h('div', { className: 'fd-actions' }, h('button', { className: 'fd-btn primary', onClick: props.onApply }, '应用到选中项')))
}

// ---- 侧栏分区：收藏 / 位置 / 标签 / SMB + 设备容量条 ----
function FF_Sidebar(props) {
  var sec = []
  function head(t) { return h('div', { key: 'h' + t, className: 'fd-rail-h' }, t) }
  // 收藏
  sec.push(head('收藏'))
  var favs = (props.favorites || []).map(function (f) {
    return h('button', { key: 'f' + f.path, className: 'fd-side-item', title: f.path, onClick: function () { props.onGo(f.path) } },
      h(FF_SideIco, { icon: 'star' }), h('span', { className: 'fd-side-name' }, f.name || fdBase(f.path)),
      h('span', { className: 'fd-side-x', role: 'button', title: '移除收藏', 'aria-label': '移除收藏', onClick: function (e) { e.stopPropagation(); props.onFavRemove(f.path) } }, h(FF_UiIco, { k: 'x', icon: 'close', size: 11 })))
  })
  if (!favs.length) favs = [h('div', { key: 'fav-empty', className: 'fd-side-hint' }, '点顶栏「收藏」按钮收藏当前目录')]
  sec.push(h('div', { key: 'fav', className: 'fd-side-sec' }, favs))
  // 位置（本机卷）
  sec.push(head('位置'))
  sec.push(h('div', { key: 'loc', className: 'fd-side-sec' }, (props.partition ? props.partition.local : []).map(function (v) {
    return h('button', { key: 'l' + v.path, className: 'fd-side-item' + (props.path === v.path ? ' is-on' : ''), title: v.path,
      onClick: function () { props.onGo(v.path) } },
      h(FF_SideIco, { icon: 'disk' }), h('span', { className: 'fd-side-name' }, v.name),
      h('span', { className: 'fd-vol-tag local' }, v.type))
  })))
  // 标签筛选
  sec.push(head('标签'))
  sec.push(h('div', { key: 'tags', className: 'fd-side-sec' }, (props.tags || []).length
    ? (props.tags || []).map(function (t) {
        return h('button', { key: 't' + t.name, className: 'fd-side-item' + (props.tagFilter === t.name ? ' is-on' : ''),
          onClick: function () { props.onTagFilter(t.name) } },
          h('span', { className: 'fd-tag-dot sm', style: { background: t.color || 'var(--fd-ink3)' } }),
          h('span', { className: 'fd-side-name' }, t.name))
      })
    : h('div', { key: 'tag-empty', className: 'fd-side-hint' }, '右栏可给文件加标签')))
  // SMB / 网络卷
  sec.push(head('SMB · 网络卷'))
  sec.push(h('div', { key: 'smb', className: 'fd-side-sec' }, (props.partition ? props.partition.smb : []).map(function (v) {
    return h('button', { key: 's' + v.path, className: 'fd-side-item' + (props.path === v.path ? ' is-on' : ''), title: v.path,
      onClick: function () { props.onGo(v.path) } },
      h(FF_SideIco, { icon: 'cloud' }), h('span', { className: 'fd-side-name' }, v.name),
      h('span', { className: 'fd-vol-tag' }, 'SMB'))
  })))
  // 容量条
  if (props.capacity && props.capacity.ok) {
    sec.push(h('div', { key: 'cap', className: 'fd-cap' },
      h('div', { className: 'fd-cap-h' }, fdSize(props.capacity.used) + ' / ' + fdSize(props.capacity.total)),
      h('div', { className: 'fd-progress' }, h('i', { style: { width: props.capacity.pct + '%' } })),
      h('div', { className: 'fd-side-hint' }, '剩余 ' + fdSize(props.capacity.free))))
  }
  return h('nav', { className: 'fd-rail fd-rail-new' }, sec)
}

// ---- 第 7 轮 VSCode 布局：目录树 / 右栏 / AI 对话 ----
// FF_PRESET_FALLBACK：client 侧兜底清单。
// 为什么需要：预设的权威实现在 host（src/presets.js），但 host 半片要等插件树 recomposition 才生效，
// 而 client bundle 一次刷新就能换。没有这份兜底，用户看到的是空预设条（第 15 轮真机实测遇到）。
// 点击仍走 POST /flowfile/preset，规则执行永远在 host —— 这里只有「名字与说明」。
var FF_PRESET_FALLBACK = [
  { id: 'by-type', name: '按类型归档', desc: '图片 / 文档 / 视频等各归一个子目录' },
  { id: 'by-month', name: '按年月归档', desc: '按修改时间落到 YYYY·MM 子目录' },
  { id: 'big-files', name: '挑出大文件', desc: '大于 100MB 的移到 _大文件，只搬不删' },
  { id: 'old-installers', name: '清理旧安装包', desc: '90 天前的 dmg / pkg / iso / zip 进回收站' },
  { id: 'empty-names', name: '整理重复后缀', desc: '把「副本」「copy」「(1)」挑出来' }
]

// ---- 目录树 v2（第 24 轮 m11235 诉求 4「文件树需要重新实现」）----
// 旧实现四个真缺陷：
//   ① 单击裸行 = 导航 + 自动展开，用户想「只看一下」就直接改了树形；
//   ② 没有独立折叠箭头，只能双击整行收起，与单击导航抢事件；
//   ③ 展开状态不持久，切目录回来树全塌，等于每次从零点；
//   ④ 当前路径不会自动 reveal，深目录里根本看不出自己在哪一支。
// 新实现：caret 独立按钮（导航与折叠彻底分离）+ 缩进引导线 + 展开态写 localStorage +
//          路径变化时自动展开父链（reveal）+ 键盘 ←/→ 折叠、Enter 打开。
var FF_TREE_KEY = 'flowfile.tree.open.v1'
var FF_TREE_MAX_OPEN = 240

function ffTreeStore() { try { return window.localStorage } catch (e) { return null } }

function ffTreeReadOpen(store) {
  var out = {}
  try {
    var raw = store && store.getItem(FF_TREE_KEY)
    if (!raw) return out
    var arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return out
    arr.slice(0, FF_TREE_MAX_OPEN).forEach(function (p) { if (typeof p === 'string' && p) out[p] = true })
  } catch (e) { /* 隐私模式/坏数据一律当空 */ }
  return out
}

function ffTreeWriteOpen(store, open) {
  try {
    if (!store) return
    var arr = Object.keys(open || {}).filter(function (k) { return open[k] }).slice(0, FF_TREE_MAX_OPEN)
    store.setItem(FF_TREE_KEY, JSON.stringify(arr))
  } catch (e) { /* 写不进去就当没记忆，不阻塞渲染 */ }
}

// 把当前路径拆成「卷根 → … → 父级」的展开链；最后一项（当前目录本身）不展开。
function ffTreeChain(path, volumes) {
  var p = String(path || '').replace(/\/+$/, '')
  if (!p) return []
  var root = ''
  ;(volumes || []).forEach(function (v) {
    var vp = String((v && v.path) || '').replace(/\/+$/, '')
    if (!vp) return
    if (p === vp || p.indexOf(vp + '/') === 0) { if (vp.length > root.length) root = vp }
  })
  if (!root) return []
  var rest = p.slice(root.length).split('/').filter(Boolean)
  var chain = [root]
  for (var i = 0; i < rest.length; i++) chain.push(chain[chain.length - 1] + '/' + rest[i])
  // 停在卷根本身时也要展开它（否则落在一个卷上，树是一片缩起的死行，看不出下面有什么）；
  // 停在子目录时才丢掉「当前目录自己」那一层，只展开父链。
  if (chain.length > 1) chain.pop()
  return chain
}

// FF_Tree：懒加载目录树。props { path, volumes, onGo, listDir, onFold }
// listDir(p) 返回 Promise<子目录名[]>；组件只缓存，不写文件。
function FF_Tree(props) {
  var store = ffTreeStore()
  var openState = React.useState(function () { return ffTreeReadOpen(store) })
  var open = openState[0], setOpen = openState[1]
  // 子树缓存与在途标记放 ref：既避免 setState 竞态，也避免闭包读到旧值重复请求。
  var cacheRef = React.useRef({ kids: {}, busy: {} })
  var tickState = React.useState(0), bump = tickState[1]
  var revealedRef = React.useRef('')

  function remember(next) {
    setOpen(next)
    ffTreeWriteOpen(store, next)
  }

  function load(p) {
    var c = cacheRef.current
    if (c.kids[p] || c.busy[p]) return
    c.busy[p] = true
    bump(function (n) { return n + 1 })
    props.listDir(p).then(function (names) {
      c.kids[p] = names || []
    }).catch(function () {
      c.kids[p] = []
    }).then(function () {
      delete c.busy[p]
      bump(function (n) { return n + 1 })
    })
  }

  function toggle(p) {
    var next = Object.assign({}, open)
    if (next[p]) delete next[p]
    else { next[p] = true; load(p) }
    remember(next)
  }

  // reveal：路径变了就把父链打开并加载。没有这一步，深目录里树永远停在卷根。
  React.useEffect(function () {
    var p = String(props.path || '')
    if (!p || p === revealedRef.current) return
    revealedRef.current = p
    var chain = ffTreeChain(p, props.volumes)
    if (!chain.length) return
    var next = Object.assign({}, open)
    var changed = false
    chain.forEach(function (c) { if (!next[c]) { next[c] = true; changed = true } })
    if (changed) remember(next)
    chain.forEach(load)
  }, [props.path, props.volumes && props.volumes.length])

  var kids = cacheRef.current.kids
  var busy = cacheRef.current.busy

  function node(p, name, depth, smb) {
    var isOpen = !!open[p]
    var isCur = props.path === p
    var children = kids[p]
    var loading = !!busy[p]
    var pad = 6 + depth * 13
    return h('div', { key: p },
      h('div', {
        className: 'tn-row' + (isCur ? ' is-on' : ''),
        style: { paddingLeft: pad + 'px' },
        role: 'treeitem', tabIndex: 0, title: p,
        'aria-expanded': isOpen, 'aria-selected': isCur,
        onClick: function () { props.onGo(p) },
        onKeyDown: function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onGo(p) }
          else if (e.key === 'ArrowRight') { e.preventDefault(); if (!isOpen) toggle(p) }
          else if (e.key === 'ArrowLeft') { e.preventDefault(); if (isOpen) toggle(p) }
        }
      },
      loading
        ? h('span', { className: 'tn-load' }, h('i', null))
        : h('button', {
            className: 'tn-caret' + (isOpen ? ' open' : ''),
            'aria-label': (isOpen ? '收起 ' : '展开 ') + name,
            title: isOpen ? '收起' : '展开',
            onClick: function (e) { e.stopPropagation(); toggle(p) }
          }, h(FF_Lucide, { nodes: FD_LUCIDE_UI.chevronR, size: 10, strokeWidth: 2.2 })),
      h('span', { className: 'tn-ico' + (smb ? ' smb' : '') },
        h(FF_Lucide, { nodes: smb ? FD_LUCIDE_FILE.cloud : FD_LUCIDE_FILE.folder, size: 13, strokeWidth: 1.8 })),
      h('span', { className: 'tn-name' }, name)),
      isOpen
        ? h('div', { className: 'tn-kids', style: { '--tn-guide': (pad + 7) + 'px' } },
            !children ? h('div', { className: 'tn-empty' }, '读取中…')
              : children.length
                ? children.map(function (n) { return node(joinPath(p, n), n, depth + 1, false) })
                : h('div', { className: 'tn-empty' }, '空文件夹'))
        : null)
  }

  var vols = props.volumes || []
  var sec = [h('div', { key: 'h', className: 'fd-tree-h' },
    h('span', null, '目录'),
    h('span', { className: 'cnt' }, String(vols.length) + ' 卷'),
    props.onFold ? h('button', { className: 'fd-tree-fold', title: '收起目录树', 'aria-label': '收起目录树',
      onClick: function (e) { e.stopPropagation(); props.onFold() } }, h(FF_Lucide, { nodes: FD_LUCIDE_UI.foldLeft, size: 11, strokeWidth: 2 })) : null)]
  vols.forEach(function (v) {
    var isSmb = String((v && v.type) || '').toLowerCase().indexOf('smb') >= 0
    sec.push(node(v.path, v.name || v.path, 0, isSmb))
  })
  if (!vols.length) sec.push(h('div', { key: 'none', className: 'tn-empty' }, '正在读取卷…'))
  var tagWrap = props.tagBar ? h('div', { className: 'fd-tree-tags' },
    h('div', { className: 'fd-tree-tags-h' }, '标签'),
    props.tagBar) : null
  return h('nav', { className: 'fd-tree' }, sec, tagWrap)
}

// FF_TaskRail：第 18 轮 A 方案「右侧任务栏」——把已执行过的批次常驻在右栏上半段。
// 数据走真实 /ops/batches（api.js ffBatches），只展示有执行痕迹的批次（status=done/failed/rolled_back）；
// 计划中但未执行的批次不混进来（它们不是「已执行任务」，另有预览计划卡片显示）。
// 提供撤销入口 ffUndo：只撤销 done/failed 批次，与后端 undo 门一致；撤销后刷新列表 + 刷新当前目录。
function FF_TaskRail(props) {
  var st = React.useState({ loading: true, batches: [], error: '' })
  var data = st[0], setData = st[1]
  var exState = React.useState(null), expanded = exState[0], setExpanded = exState[1]
  var busyState = React.useState(null), busy = busyState[0], setBusy = busyState[1]

  function load() {
    setData(function (d) { return Object.assign({}, d, { loading: true, error: '' }) })
    ffBatches(40).then(function (r) {
      var all = (r && r.batches) || []
      var done = all.filter(function (b) { return b && ['done', 'failed', 'rolled_back'].indexOf(b.status) >= 0 })
      setData({ loading: false, batches: done, error: '' })
    }).catch(function (e) { setData({ loading: false, batches: [], error: e.message || '任务历史加载失败' }) })
  }
  React.useEffect(function () { load() }, [])

  function labelOf(b) {
    try {
      var p = typeof b.plan_json === 'string' ? JSON.parse(b.plan_json || '{}') : (b.plan_json || {})
      return p.reply || p.intent || ('批次 ' + String(b.id).slice(0, 8))
    } catch (e) { return '批次 ' + String(b.id).slice(0, 8) }
  }
  function countLabel(b, status) {
    if (status === 'rolled_back') return '已撤销'
    if (status === 'failed') return '有失败项'
    var n = b.item_count
    if (n === undefined || n === null) return '已执行'
    return n + ' 项完成'
  }
  function timeLabel(ts) {
    // ops_batches.created_at 是秒级 epoch（db.js now()）；fdTime 接受 ISO 或毫秒。
    var n = Number(ts)
    return n ? fdTime(n * 1000) : (ts ? fdTime(ts) : '')
  }
  function doUndo(b) {
    if (!b || busy || b.status === 'rolled_back') return
    if (!window.confirm('撤销「' + labelOf(b) + '」已执行的操作？删除项会从回收站还原，不覆盖已存在文件。')) return
    setBusy(b.id)
    ffUndo(b.id).then(function () {
      setBusy(null); setExpanded(null); load()
      if (props.onChanged) props.onChanged()
    }).catch(function (e) { setBusy(null); if (props.onError) props.onError(e.message || '撤销失败') })
  }
  function toggle(b) { setExpanded(expanded === b.id ? null : b.id) }

  var rows = data.batches.map(function (b) {
    var status = b.status
    var isOpen = expanded === b.id
    var undoable = status === 'done' || status === 'failed'
    return h('div', { key: b.id, className: 'fd-taskrow' },
      h('b', { title: labelOf(b) }, '#' + String(b.id).slice(0, 8) + ' ' + labelOf(b)),
      h('div', { className: 'fd-task-meta' },
        timeLabel(b.created_at) + ' · ' + countLabel(b, status) + ' · ' + (b.actor || 'user')),
      h('div', null,
        h('button', { className: 'fd-btn', onClick: function () { toggle(b) },
          title: isOpen ? '收起明细' : '展开明细' }, isOpen ? '收起' : '明细'),
        undoable ? h('button', { className: 'fd-btn fd-task-und', disabled: busy === b.id,
          onClick: function () { doUndo(b) }, title: '撤销整批（删除项从回收站还原）' },
          busy === b.id ? '撤销中…' : '撤销') : null),
      isOpen ? h('div', { className: 'fd-task-meta', style: { whiteSpace: 'normal' } },
        '状态：' + status + (b.note ? ' · ' + b.note : ''),
        h('br'), '完整批次：' + b.id) : null)
  })

  return h('div', { className: 'fd-rail-tasks' },
    h('div', { className: 'fd-rail-tasks-h' },
      h('span', null, '任务历史'),
      h('span', { className: 'fd-rail-num' }, String(data.batches.length)),
      h('button', { className: 'fd-btn fd-ico-btn', title: '刷新任务历史', 'aria-label': '刷新任务历史',
        onClick: load }, h(FF_UiIco, { k: 'rf', icon: 'refresh', size: 12 }))),
    h('div', { className: 'fd-rail-tasks-body' },
      data.loading ? h('div', { className: 'fd-rail-empty' }, '加载中…')
        : data.error ? h('div', { className: 'fd-rail-empty' }, data.error)
        : rows.length ? rows
        : h('div', { className: 'fd-rail-empty' }, '还没有执行过的任务。执行一批整理后，这里会留下可翻看、可撤销的记录。')))
}

// FF_AiDock：第 18 轮 A 方案起常驻右栏下半段（任务历史之上改为右栏内双段）。
// 历史：第 13 轮曾搬到整幅底栏，用户反馈「看不到上下文」，现搬回右栏并独立滚动。
// 第 15 轮（m07306 ③⑤）：① 计划卡片顶部写明「作用目录 + 扫描了几项」，不再让用户猜 AI 在哪个目录上动手；
// ② 输入行上方加一排预设 chip（纯规则枚举，点一下立刻出计划，不需要等模型）。
// 结构：拖拽把手 → 标题行（含模型下拉与收起）→ 预设条 → 对话流 + 计划卡片 → 输入行。
// 气泡读 m.content（DB 字段就是 content；旧代码读 m.text 导致气泡全空）。
function FF_AiDock(props) {
  var open = props.open !== false
  var msgs = props.messages || []
  var planProps = props.planProps || {}
  var routes = (props.models && props.models.routes) || []
  var presets = props.presets || []
  var bubbles = msgs.map(function (m, i) {
    var isUser = m.role === 'user'
    var plan = m.payload && m.payload.kind === 'plan' && m.payload.plan ? m.payload.plan : null
    var bid = m.batch_id || (plan && plan.batchId)
    return h('div', { key: m.id || i, className: 'fd-bubble ' + (isUser ? 'user' : 'ai') },
      m.content || '',
      plan ? h(FF_PlanCard, Object.assign({ plan: plan }, planProps[bid] || {})) : null)
  })
  var modelOpts = [h('option', { key: 'auto', value: 'auto' }, (props.models && props.models.autoLabel) || '跟随宿主默认')]
  routes.forEach(function (r) {
    if (r.available) (r.models || []).forEach(function (m) {
      modelOpts.push(h('option', { key: r.provider + '/' + m, value: r.provider + '/' + m }, r.provider + ' · ' + m))
    })
    else modelOpts.push(h('option', { key: r.provider + '/off', value: r.provider + '/off', disabled: true }, r.provider + ' · 不可用'))
  })
  var presetBar = presets.length ? h('div', { className: 'fd-preset' },
    h('span', { className: 'fd-preset-h' }, '预设'),
    presets.map(function (p) {
      return h('button', { key: p.id, className: 'fd-preset-chip', disabled: props.busy,
        title: p.desc + '（只出计划，勾选并确认后才执行）',
        onClick: function () { props.onPreset && props.onPreset(p.id) } }, p.name)
    }),
    h('span', { className: 'fd-preset-note' }, '点了只出计划，不会直接动文件')) : null
  return h('div', { className: 'fd-dock' + (open ? '' : ' is-folded') },
    h('div', { className: 'fd-dock-grip', title: '拖动调整对话区高度，双击复原',
      onPointerDown: function (e) { props.onGripDown && props.onGripDown(e) },
      onDoubleClick: function () { props.onGripReset && props.onGripReset() } }),
    h('div', { className: 'fd-dock-h' },
      h('button', { className: 'fd-btn fd-ico-btn', onClick: props.onToggle,
        title: open ? '收起对话区' : '展开对话区', 'aria-label': open ? '收起对话区' : '展开对话区' }, h(FF_UiIco, { k: 'tg', icon: open ? 'chevronD' : 'chevronR', size: 12 })),
      h('b', null, 'FlowFile 对话'),
      h('select', { className: 'fd-model', value: (props.models && props.models.currentKey) || 'auto',
        disabled: !props.models || props.models.busy,
        onChange: function (e) { props.onModel && props.onModel(e.target.value) },
        title: '选择对话/整理计划使用的模型' }, modelOpts),
      h('span', { className: 'fd-dock-scope', title: props.path || '' }, '作用目录：' + (props.path || '未选择')),
      h('span', { className: 'fd-dock-note' }, 'AI 只出计划，勾选并确认后才执行，删除一律进回收站')),
    open ? h('div', { className: 'fd-dock-body' },
      presetBar,
      h('div', { className: 'fd-chat-log' },
        bubbles.length ? bubbles : h('div', { className: 'fd-msg', style: { padding: '8px 0', textAlign: 'left' } },
          '说点什么，例如「把大于 100MB 的挑出来」「按类型分好」；或者直接点上面的预设。'),
        props.busy ? h('div', { className: 'fd-bubble ai' }, '…思考中') : null),
      props.currentPlan ? h('div', { className: 'fd-dock-plan' },
        h(FF_PlanCard, Object.assign({ plan: props.currentPlan, path: props.path }, planProps[props.currentPlan.batchId] || {}))) : null,
      h('div', { className: 'fd-dock-in' },
        h('input', { value: props.input || '', placeholder: '写下你想怎么整理「' + (props.path || '当前目录') + '」…',
          onChange: function (e) { props.onInput(e.target.value) },
          onKeyDown: function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); props.onSend() } } }),
        h('button', { className: 'fd-dock-send', onClick: props.onSend, disabled: props.busy,
          title: '发送（只出计划，不直接动文件）', 'aria-label': '发送' }, props.busy ? h(FF_UiIco, { k: 'bs', icon: 'more', size: 13 }) : h(FF_UiIco, { k: 'sd', icon: 'send', size: 14 })))
    ) : null)
}
// ---- QuickLook（空格预览）----
function FF_QuickLook(props) {
  var e = props.entry
  if (!e) return null
  var body = props.thumb
    ? h('img', { className: 'fd-ql-img', src: props.thumb, alt: e.name })
    : h('div', { className: 'fd-ql-ph' }, h(FF_FileIcon, { entry: e, size: 64 }))
  return h('div', { className: 'fd-modal-mask fd-ql-mask', onClick: props.onClose },
    h('div', { className: 'fd-ql', onClick: function (ev) { ev.stopPropagation() } },
      h('div', { className: 'fd-ql-h' }, h('b', null, e.name), h('button', { className: 'fd-btn', onClick: props.onClose }, '关闭 ✕')),
      h('div', { className: 'fd-ql-body' }, body),
      h('div', { className: 'fd-ql-meta' },
        h('span', null, fdSize(e.size)), h('span', null, fdTime(e.mtime)), h('span', { title: e.path }, fdBase(e.path)))))
}

// ---- Toast（L2 反馈）----
function FF_Toast(props) {
  if (!props.text) return null
  return h('div', { className: 'fd-toast ' + (props.tone || 'info'), role: 'status', 'aria-live': 'polite' }, props.text)
}

// FlowFile · Tahoe 26 结构层组件（第 20 轮 m09643）
// 真源：flowfile/docs/flowfile-design-tahoe.html 的 DOM 骨架。
// 这些组件只负责「长什么样」，状态与回调全部由 FD_App 传入（同 client-browse.js 的约定）。
// 与旧 client-browse.js 的分工：旧组件保留给能力面板复用（FF_Tree 的展开逻辑、FF_TagEditor 等），
// 新骨架用 FF_T* 前缀，零命名冲突。
var h = React.createElement

function fdFicoKind(entry) {
  if (!entry) return 'other'
  if (entry.isDir) return 'folder'
  var n = String(entry.name || '').toLowerCase()
  var ext = n.indexOf('.') >= 0 ? n.slice(n.lastIndexOf('.') + 1) : ''
  if (/^(png|jpg|jpeg|gif|webp|bmp|tiff?|heic|svg|sketch|psd|ai)$/.test(ext)) return 'img'
  if (/^(pdf|docx?|txt|md|rtf|pages|epub)$/.test(ext)) return 'doc'
  if (/^(xlsx?|csv|numbers)$/.test(ext)) return 'xls'
  if (/^(pptx?|key)$/.test(ext)) return 'slide'
  if (/^(zip|rar|7z|dmg|iso|tar|gz|bz2|xz)$/.test(ext)) return 'archive'
  if (/^(js|ts|tsx|jsx|py|rs|go|java|c|cc|cpp|h|hpp|swift|sh|json|ya?ml|toml|xml|html|css)$/.test(ext)) return 'code'
  return 'other'
}

// 类型 → Lucide 图标键（与 FD_LUCIDE_FILE 对齐），颜色沿用 Tahoe 语义色
var FD_FICO_ICON = { folder: 'folder', img: 'image', doc: 'document', xls: 'spreadsheet',
  slide: 'presentation', archive: 'archive', code: 'code', other: 'unknown' }
var FD_FICO_LABEL = { folder: 'F', img: 'IMG', doc: 'DOC', xls: 'XLS', slide: 'PPT', archive: 'ZIP', code: '</>', other: '·' }

// 行内 / 网格 / 底坞统一用这个：淡色底 + 类型色 Lucide 图标（不再是字母方块）
function FF_Fico(props) {
  var kind = fdFicoKind(props.entry)
  var key = FD_FICO_ICON[kind] || 'unknown'
  var size = props.size || 18
  return h('span', { className: 'fico ' + kind, style: { width: size, height: size, flexBasis: size }, 'aria-hidden': 'true' },
    h(FF_Lucide, { nodes: FD_LUCIDE_FILE[key] || FD_LUCIDE_FILE.unknown, size: Math.round(size * 0.66),
      className: 'fico-ico', strokeWidth: 2 }))
}

// ---- 玻璃侧栏：品牌 + 卷卡 + 智能文件夹 + 标签筛选 + 独立工具（+ 目录树） ----
function FF_TSidebar(props) {
  var vols = props.volumes || []
  var groups = props.groups || []
  var cards = vols.slice(0, 6).map(function (v, i) {
    var isSmb = String(v.type || '').toLowerCase().indexOf('smb') >= 0
    // 容量：优先用卷对象自带（host 新版 statfs 写入），否则用 client 补拉的 capacity，
    // 都没有就整条不画——旧实现用 (18 + i*22)% 按索引编造使用率，那是假数据。
    var cap = (props.volCaps && props.volCaps[v.path]) || null
    var pct = v.usedPct !== undefined && v.usedPct !== null ? v.usedPct : (cap ? cap.pct : null)
    var free = v.free !== undefined && v.free !== null ? v.free : (cap ? cap.free : null)
    return h('div', { key: v.path, className: 'vol-card' + (props.path === v.path || (props.path || '').indexOf(v.path) === 0 ? ' on' : ''),
      role: 'button', tabIndex: 0, 'aria-label': '打开卷 ' + (v.name || v.path) + (pct === null ? '' : '，已用 ' + pct + '%'),
      onClick: function () { props.onGo(v.path) },
      onKeyDown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onGo(v.path) } } },
      h('div', { className: 'vol-l1' },
        h('span', { className: 'sb-ico ' + (i % 2 ? 'ic-indigo' : 'ic-blue') }, h(FF_UiIco, { k: 'vol' + i, icon: isSmb ? 'cloud' : 'hdd', size: 11 })),
        (v.name || v.path)),
      h('div', { className: 'vol-l2' },
        h('span', null, isSmb ? 'SMB' + (v.fsType ? ' · ' + String(v.fsType).toUpperCase() : ' · 已挂载') : String(v.fsType || v.type || '磁盘').toUpperCase()),
        h('span', { title: free === null ? '容量未知' : '剩余 ' + fdSize(free) }, free === null ? '—' : fdSize(free) + ' 可用')),
      pct === null ? null
        : h('div', { className: 'vol-meter', role: 'img', 'aria-label': '已用 ' + pct + '%' },
            h('i', { style: { width: Math.max(2, Math.min(100, pct)) + '%', background: pct >= 90 ? 'var(--danger)' : 'var(--accent)' } })))
  })

  var tagChips = groups.length ? groups.slice(0, 8).map(function (g) {
    var on = props.tagFilter === g.name
    return h('span', { key: g.name, className: 'tagchip' + (on ? ' on' : ''), role: 'button', tabIndex: 0,
      'aria-label': '按标签筛选 ' + g.name, 'aria-pressed': on,
      onClick: function () { props.onTag(on ? '' : g.name) },
      onKeyDown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onTag(on ? '' : g.name) } } },
      h('i', { style: { background: g.color || '#8e8e93' } }), g.name)
  }) : [h('span', { key: 'none', className: 'tagchip', style: { opacity: .6 } }, '当前目录无标签')]

  var tree = props.tree ? h('div', { className: 'tree-wrap' }, props.tree) : null

  return h('aside', { className: 'sidebar' },
    h('div', { className: 'sb-brand' },
      h('span', { className: 'sb-name' }, 'FlowFile'),
      // 第 26 轮：这里原写死 'v1.0'。发版后就会变成一句假话（版本号是 package.json 里的 0.1.1）。
      // 顶栏不承担版本号展示，改成中性的产线标识；真实版本在 设置 里读 package.json。
      h('span', { className: 'sb-tag' }, '本地优先')),
    h('div', { className: 'sb-scroll' },
      h('div', { className: 'sb-group' }, '位置'),
      cards.length ? cards : h('div', { className: 'sb-row', style: { color: 'var(--ink-400)', fontSize: 11.5 } }, '读取中…'),
      // 第 25 轮：这一组原先是死入口——onQuick 从未由 client-app 传入，点了什么都不发生；
      // 而计数又数的是「当前目录里的文件数」，不是「最近修改」。两处一起改：
      // 语义收窄成「本目录的快速筛选器」，标题写明范围，点击即过滤列表并高亮。
      h('div', { className: 'sb-group' }, '本目录筛选'),
      h('button', { className: 'sb-row' + (props.quick === 'recent' ? ' on' : ''), 'aria-pressed': props.quick === 'recent',
        onClick: function () { props.onQuick && props.onQuick(props.quick === 'recent' ? '' : 'recent') } },
        h('span', { className: 'sb-ico ic-orange' }, h(FF_UiIco, { k: 'q1', icon: 'clock', size: 11 })), '近 7 天修改',
        h('span', { className: 'cnt' }, String((props.counts && props.counts.recent) || 0))),
      h('button', { className: 'sb-row' + (props.quick === 'large' ? ' on' : ''), 'aria-pressed': props.quick === 'large',
        onClick: function () { props.onQuick && props.onQuick(props.quick === 'large' ? '' : 'large') } },
        h('span', { className: 'sb-ico ic-rose' }, h(FF_UiIco, { k: 'q2', icon: 'spark', size: 11 })), '大于 100 MB',
        h('span', { className: 'cnt' }, String((props.counts && props.counts.large) || 0))),
      h('button', { className: 'sb-row' + (props.quick === 'tagged' ? ' on' : ''), 'aria-pressed': props.quick === 'tagged',
        onClick: function () { props.onQuick && props.onQuick(props.quick === 'tagged' ? '' : 'tagged') } },
        h('span', { className: 'sb-ico ic-green' }, h(FF_UiIco, { k: 'q3', icon: 'copy', size: 11 })), '已有标签',
        h('span', { className: 'cnt' }, String((props.counts && props.counts.tagged) || 0))),
      tree),
    h('div', { className: 'tagsec' },
      h('div', { className: 'lbl' }, '标签筛选'),
      tagChips),
    h('div', { className: 'sb-ws' },
      h('div', { className: 't' }, '独立工具 · 全库'),
      h('button', { className: 'tool-item' + (props.activeTool === 'dup' ? ' on' : ''), onClick: function () { props.onTool('dup') } },
        h(FF_UiIco, { k: 'td', icon: 'copy', size: 13 }), '文件查重',
        h('span', { className: 'badge' }, props.dupBadge || '—')),
      h('button', { className: 'tool-item' + (props.activeTool === 'clean' ? ' on' : ''), onClick: function () { props.onTool('clean') } },
        h(FF_UiIco, { k: 'tc', icon: 'trash', size: 13 }), '清理',
        h('span', { className: 'badge' }, props.cleanBadge || '—')),
      // 设置入口：旧 v4 的 subbar 有 7 个能力 tab，新骨架里 dup/clean 在侧栏、
      // sim/timeline/recognize 在检查器，settings 必须单独留一个入口，否则设置页无处可开。
      h('button', { className: 'tool-item' + (props.activeTool === 'settings' ? ' on' : ''), onClick: function () { props.onTool('settings') } },
        h(FF_UiIco, { k: 'ts', icon: 'settings', size: 13 }), '设置')))
}

// ---- 全局协调栏：前进后退 + 面包屑 + 搜索 + 外观/密度/AI ----
function FF_TCoord(props) {
  var trail = props.trail || []
  var crumbs = []
  trail.forEach(function (t, i) {
    if (i) crumbs.push(h('span', { key: 'sep' + i, className: 'sep' }, '›'))
    crumbs.push(h('button', { key: 'c' + i, className: 'n' + (i === trail.length - 1 ? ' cur' : ''),
      onClick: function () { props.onGo(t.path) } }, t.name))
  })
  return h('div', { className: 'coord' },
    h('div', { className: 'coord-l' },
      h('button', { className: 'nav-sq', disabled: !props.canBack, onClick: props.onBack, 'aria-label': '后退' }, h(FF_UiIco, { k: 'bk', icon: 'back', size: 13 })),
      h('button', { className: 'nav-sq', disabled: !props.canForward, onClick: props.onForward, 'aria-label': '前进' }, h(FF_UiIco, { k: 'fw', icon: 'forward', size: 13 })),
      h('div', { className: 'crumb' }, crumbs.length ? crumbs : h('span', { className: 'n cur' }, '未选择位置'))),
    h('div', { className: 'coord-r' },
      h('div', { className: 'spot' },
        h(FF_UiIco, { k: 'sc', icon: 'search', size: 13 }),
        h('input', { value: props.query, placeholder: '聚焦搜索 · 筛选当前目录', 'aria-label': '筛选当前目录',
          onChange: function (e) { props.onQuery(e.target.value) } }),
        h('kbd', null, '⌘K')),
      h('button', { className: 'glass-chip', onClick: props.onDensity, 'aria-label': '切换列表密度',
        title: '切换密度（宽松 / 标准 / 紧凑）' }, h(FF_UiIco, { k: 'dn', icon: 'list', size: 12 }), '密度'),
      h('button', { className: 'glass-chip' + (props.inspOpen ? '' : ' off'), onClick: props.onInsp,
        'aria-pressed': !!props.inspOpen, 'aria-label': props.inspOpen ? '隐藏检查器' : '显示检查器',
        title: props.inspOpen ? '隐藏检查器（⌥⌘I）' : '显示检查器（⌥⌘I）' },
        h(FF_Lucide, { nodes: FD_LUCIDE_UI.panelRight, size: 12, strokeWidth: 1.9 }), '检查器'),
      h('button', { className: 'glass-chip pri', onClick: props.onAi, 'aria-label': '打开 AI 助手',
        title: '打开 AI 助手（⌘⇧K）' }, h(FF_UiIco, { k: 'ai', icon: 'sparkle', size: 12 }), 'AI 助手')))
}

// ---- 工作区标签条 ----
function FF_TTabstrip(props) {
  var tabs = props.tabs || []
  if (!tabs.length) return null
  return h('div', { className: 'tabstrip' },
    tabs.map(function (t) {
      return h('div', { key: t.path, className: 'tab' + (props.path === t.path ? ' on' : ''), role: 'button', tabIndex: 0,
        onClick: function () { props.onGo(t.path) },
        onKeyDown: function (e) { if (e.key === 'Enter') props.onGo(t.path) } },
        h('span', { className: 'dot', style: { background: '#007aff' } }),
        h('span', null, t.name || fdBase(t.path)),
        h('button', { className: 'x', title: '关闭标签', 'aria-label': '关闭标签 ' + (t.name || fdBase(t.path)),
          onClick: function (e) { e.stopPropagation(); props.onClose(t.path) } }, '×'))
    }),
    h('button', { className: 'tab-add', title: '把当前目录固定为新标签', 'aria-label': '新建标签',
      onClick: props.onAdd }, '+'))
}

// ---- 文件空间卡：hero + 列头 + 行 ----
function FF_THero(props) {
  return h('div', { className: 'hero' },
    h('div', { className: 'hero-l' },
      h('div', { className: 'hero-t' },
        h('b', null, props.title || '—'),
        h('span', { className: 'cnt' }, props.countText || '')),
      h('div', { className: 'hero-crumb' },
        h('span', null, props.where || '本机'),
        h('span', null, '›'),
        h('span', { className: 'cur' }, props.title || '—'))),
    h('div', { className: 'hero-r' },
      h('input', { className: 'filter', value: props.query, placeholder: '筛选当前目录', 'aria-label': '筛选当前目录',
        onChange: function (e) { props.onQuery(e.target.value) } }),
      h('div', { className: 'viewseg', role: 'group', 'aria-label': '视图模式' },
        h('button', { className: props.viewMode === 'list' ? 'on' : '', 'aria-label': '列表视图', title: '列表视图',
          onClick: function () { props.onView('list') } }, h(FF_Lucide, { nodes: FD_LUCIDE_UI.list, size: 12, strokeWidth: 1.9 })),
        h('button', { className: props.viewMode === 'grid' ? 'on' : '', 'aria-label': '网格视图', title: '网格视图',
          onClick: function () { props.onView('grid') } }, h(FF_Lucide, { nodes: FD_LUCIDE_UI.grid, size: 12, strokeWidth: 1.9 })),
        h('button', { className: props.viewMode === 'columns' ? 'on' : '', 'aria-label': '分栏视图（Finder 式）',
          title: '分栏视图（Finder 式）', onClick: function () { props.onView('columns') } },
          h(FF_Lucide, { nodes: FD_LUCIDE_UI.columns3, size: 12, strokeWidth: 1.9 })))))
}

// 第 25 轮：列头原本是 5 个死 span——旧骨架 FF_Head 有排序，换到新骨架后忘了接。
// 顺序沿用 Finder：名称 / 修改日期 / 大小 可排，标签与来源是派生展示列，不参与排序。
function FF_THead(props) {
  var sort = props.sort || {}
  var cells = [
    { k: 'name', label: '名称' },
    { k: 'mtime', label: '修改日期' },
    { k: 'size', label: '大小' },
    { k: null, label: '标签' },
    { k: null, label: '来源' }
  ]
  var flags = props.flags || {}
  var cls = 'colhead' + (flags.hasTags ? '' : ' no-tags') + (flags.hasSrc ? '' : ' no-src')
  return h('div', { className: cls, role: 'row' },
    cells.map(function (c) {
      if (!c.k) return h('span', { key: c.label, role: 'columnheader' }, c.label)
      var on = sort.key === c.k
      return h('button', {
        key: c.k, role: 'columnheader', className: 'colhead-btn' + (on ? ' on' : ''),
        'aria-sort': on ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none',
        title: '点击排序，再点反向，第三下复原',
        onClick: function () { props.onSort && props.onSort(c.k) }
      }, c.label, h('span', { className: 'colhead-ar', 'aria-hidden': 'true' },
        on ? (sort.dir === 'desc' ? '↓' : '↑') : '↕'))
    }))
}

function FF_TRow(props) {
  var e = props.entry
  var tags = e.tags || []
  var first = tags[0]
  return h('div', { className: 'row' + (props.selected ? ' on' : ''), role: 'row', tabIndex: 0,
    'aria-selected': !!props.selected, 'aria-label': (e.isDir ? '文件夹 ' : '文件 ') + e.name,
    onClick: function (ev) { props.onPick(e, ev) },
    onDoubleClick: function (ev) { props.onOpen && props.onOpen(e, ev) },
    onContextMenu: function (ev) { props.onContext(e, ev) },
    onKeyDown: function (ev) { props.onKey && props.onKey(e, ev) } },
    // 列表行也出缩略图（20px 小图，取不到才回落类型图标）——用户默认就在列表视图，
    // 只给网格出图等于「看不见缩略图」。
    h('div', { className: 'cell' },
      props.thumb
        ? h('span', { className: 'fico thumb', 'aria-hidden': 'true' }, h('img', { src: props.thumb, alt: '' }))
        : h(FF_Fico, { entry: e }),
      h('span', { className: 'fname', title: e.path }, e.name)),
    h('div', { className: 'meta' }, fdTime(e.mtime)),
    h('div', { className: 'meta' }, e.isDir ? '—' : fdSize(e.size)),
    // 第 25 轮：这一列原来把「类型标签」画成 pill——于是 20 个文件夹行整整齐齐写着 20 个「文件夹」，
    // 20 个文件行写着「文档 / 图片 / 归档」。一个每行都相同值的列不携带任何信息，只是噪声。
    // 类型已经由左侧图标 + 底坞表达，列里只留「我打的标签」与「识别派生的标签」（source != extension）。
    // entry.tags 是扩展名规则分类（每行都相同：文件夹 / 文档 / 图片…），不是「这个文件有什么特别」。
    // 真正有信息量的是 entry.userTags（用户手打 + 识别写入），列里只显示它。
    h('div', { className: 'rowtags' }, (function () {
      var mine = e.userTags || []
      if (!mine.length) return null
      return [h('span', { key: 'p0', className: 'tpill' }, mine[0])]
        .concat(mine.slice(1, 4).map(function (t, i) {
          return h('span', { key: 'd' + i, className: 'tpill ghost' }, t)
        }))
    })()),
    // 来源列同理：本机是默认值，每行都印「本机」等于什么都没说。
    // 只给非本机项加标记（SMB / 外置卷），本机留空。
    h('div', { className: 'srccell' }, (function () {
      var p = String(e.path || '')
      if (p.indexOf('/Volumes/') !== 0) return ''
      var seg = p.split('/')[2] || ''
      return /^(QuickSwap|000_)/.test(seg) || true ? 'SMB' : ''
    })()))
}

// ---- 灵动底坞：idle / selected / expanded 三档 ----
// idle     = 无选中，只有目录概览 + 三个工具动作
// selected = 选中但收起，文件名 + 元信息 + 操作，右侧一个展开把手
// expanded = 选中且展开，向下长出属性网格（高度由内容决定，不写死）
function FF_TDock(props) {
  var sel = props.selected
  var open = !!props.dockOpen && !!sel
  var tier = !sel ? 'idle' : (open ? 'expanded' : 'selected')
  var meta = props.meta
  var kind = sel ? fdFicoKind(sel) : 'other'
  var thumbBg = 'linear-gradient(140deg,' + ({ folder: '#007aff', img: '#387ff5', doc: '#2563eb', xls: '#16a34a', slide: '#d97706', archive: '#d97706', code: '#6d28d9', other: '#6b7284' }[kind] || '#007aff') + ',#5b6780)'
  var acts = sel
    ? [
        h('button', { key: 'open', className: 'pill', onClick: function () { props.onOpen && props.onOpen(sel) } }, '打开'),
        h('button', { key: 'sim', className: 'pill', onClick: function () { props.onSim && props.onSim(sel) } }, '查找相似'),
        h('button', { key: 'org', className: 'pill pri', onClick: function () { props.onOrganize && props.onOrganize(sel) } }, '整理')
      ]
    : [
        h('button', { key: 'dup', className: 'pill', onClick: function () { props.onTool('dup') } }, '查重扫描'),
        h('button', { key: 'cln', className: 'pill', onClick: function () { props.onTool('clean') } }, '清理'),
        h('button', { key: 'org', className: 'pill pri', onClick: function () { props.onAi() } }, '智能整理')
      ]
  // 展开区：顶部已有一个 34px 类型图标，这里不再重复放大图标，
  // 把整行宽度让给属性网格（4 列两行），信息密度更高、也不挤。
  var tagNames = (sel && sel.tags || []).map(function (t) { return t.name })
  var kindName = (tagNames[0]) || (sel && sel.isDir ? '文件夹' : '文件')
  // 标签与「类型」重复时只显示差异部分，避免同一行文字出现两次
  var tagOnly = tagNames.filter(function (t) { return t !== kindName })
  var drawer = sel ? h('div', { className: 'dock-drawer' },
    h('div', { className: 'mgrid' },
      h('div', { className: 'kvline' }, h('b', null, '类型'), h('span', null, kindName)),
      h('div', { className: 'kvline' }, h('b', null, '大小'), h('span', null, sel.isDir ? '—' : fdSize(sel.size))),
      h('div', { className: 'kvline' }, h('b', null, '修改时间'), h('span', null, fdTime(sel.mtime))),
      h('div', { className: 'kvline' }, h('b', null, '来源'), h('span', null, /^\/Volumes\//i.test(sel.path || '') ? 'SMB 挂载卷' : '本机磁盘')),
      h('div', { className: 'kvline wide' }, h('b', null, '位置'), h('span', { title: sel.path }, fdParent(sel.path))),
      h('div', { className: 'kvline wide' }, h('b', null, '标签'), h('span', null, tagOnly.length ? tagOnly.join('、') : '无额外标签')))) : null
  return h('div', { className: 'dock', 'data-tier': tier },
    h('div', { className: 'dock-top' },
      sel ? (props.thumb
        // 有真实预览图就直接用图（图片本体 / 文件夹拼图 / PDF 首页），没有才退回类型色块。
        ? h('div', { className: 'dthumb dthumb-img' },
            h('img', { src: props.thumb, alt: '', draggable: false }))
        : h('div', {
            className: 'dthumb',
            style: { background: thumbBg },
            // 首帧先给类型色块，同时补拉一次；拿到后才亮图。缺图（无预览能力）就保持色块，不闪。
            // 目录不在这里补拉：34px 的拼图看不清，但代价是 host 要 readdir 整个目录去找图片子项，
            // 实测会把 /flowfile/list 挤到 4 秒以上（表现为「双击进目录一直转圈」）。
            ref: function (el) { if (el && props.onThumb && sel && !sel.isDir && canThumb(sel)) props.onThumb(sel.path, 96) }
          },
            h(FF_Lucide, { nodes: FD_LUCIDE_FILE[FD_FICO_ICON[kind] || 'unknown'], size: 18, strokeWidth: 2 }))) : null,
      h('div', { className: 'dinfo' },
        h('div', { className: 't' }, sel ? sel.name : (props.countText || '当前目录')),
        h('div', { className: 's' }, sel ? (fdTime(sel.mtime) + ' · ' + (sel.isDir ? '文件夹' : fdSize(sel.size)))
          : (props.subText || '选中文件后这里会出现属性与操作'))),
      sel ? h('button', {
        className: 'dpull', type: 'button',
        'aria-expanded': open, 'aria-label': open ? '收起详情' : '展开详情',
        title: open ? '收起详情' : '展开详情',
        onClick: function () { props.onDockToggle && props.onDockToggle(!open) }
      }, h(FF_Lucide, { nodes: FD_LUCIDE_UI[open ? 'chevronD' : 'chevronR'], size: 14, strokeWidth: 2 })) : null,
      h('div', { className: 'dacts' }, acts)),
    drawer)
}

// ---- 检查器 v2（第 24 轮 m11235 诉求 2/3）----
// 旧检查器的问题：它复述了底坞（类型 / 大小 / 修改时间 / 来源 / 标签全在底坞已有一份），
// 却把真正独有的东西（智能识别结论、变更时间线、相似文件）藏进三个折叠按钮，
// 「打开面板」又把用户甩到另一个 tab —— 于是右边这一整列 282px 只显示重复信息。
// 新分工：底坞 = 一眼看你是谁（身份与基本属性）；检查器 = 你不知道的事（来路、历史、相似、风险）。
// 诉求 3 的可隐藏由 client-app 的 inspHidden 控制，这里只提供收起入口与更紧凑的空态。
function FF_TInspector(props) {
  var sel = props.selected
  var meta = props.meta
  var m = meta || sel
  var head = h('div', { className: 'insp-h' },
    h('span', null, '上下文检查器'),
    h('button', {
      className: 'insp-x', title: '隐藏检查器（⌥⌘I）', 'aria-label': '隐藏检查器',
      onClick: function () { props.onHide && props.onHide() }
    }, h(FF_Lucide, { nodes: FD_LUCIDE_UI.panelRight, size: 12, strokeWidth: 1.9 })))

  if (!sel) {
    return h('aside', { className: 'pane insp' }, head,
      h('div', { className: 'insp-empty' },
        h(FF_Lucide, { nodes: FD_LUCIDE_UI.info, size: 20, strokeWidth: 1.5, className: 'ie-ico' }),
        h('p', null, '选中一个项目'),
        h('small', null, '这里显示底坞放不下的东西：来路、历史、相似文件')))
  }

  var tags = (sel.tags || []).map(function (t) { return t.name })
  var userTags = (m && m.userTags) || []
  var finder = (m && m.finderTags) || []
  var autoTags = (m && m.autoTags) || []
  var recCard = props.rec && props.rec.card ? props.rec.card : null
  var tlEvents = (props.tl && props.tl.events) || []
  var simItems = (props.sim && props.sim.items) || []
  var busy = !!props.panelBusy

  // 底坞已有：类型 / 大小 / 修改时间 / 来源 / 位置 / 标签 —— 这里一律不重复。
  // 只留底坞没有的：创建时间、索引与哈希状态、下载来源、用户与 Finder 标签、完整路径。
  var rows = []
  if (m && m.birthtime) rows.push(['创建时间', fdTime(m.birthtime)])
  if (m && m.whereFrom) rows.push(['下载来源', m.whereFrom])
  rows.push(['索引状态', m && m.indexed ? '已索引' : '未扫描'])
  if (m && m.hashState) rows.push(['内容指纹', m.hashState === 'full' ? '完整哈希' : (m.hashState === 'partial' ? '部分哈希' : m.hashState)])

  var kvNode = h('div', { className: 'ikv' }, rows.map(function (r) {
    return h('div', { key: r[0], className: 'ikv-r' }, h('span', null, r[0]), h('b', { title: String(r[1]) }, String(r[1])))
  }))

  var tagBlock = (userTags.length || finder.length || autoTags.length || tags.length)
    ? h('div', { className: 'itags' },
        tags.length ? h('div', { className: 'itags-r' },
          h('span', { className: 'itags-h' }, '类型标签'),
          h('div', { className: 'itags-w' }, tags.map(function (t) {
            return h('span', { key: 't' + t, className: 'ichip' }, t)
          }))) : null,
        userTags.length ? h('div', { className: 'itags-r' },
          h('span', { className: 'itags-h' }, '我的标签'),
          h('div', { className: 'itags-w' }, userTags.map(function (t) {
            return h('span', { key: 'u' + t, className: 'ichip on' }, t)
          }))) : null,
        autoTags.length ? h('div', { className: 'itags-r' },
          h('span', { className: 'itags-h' }, '识别派生'),
          h('div', { className: 'itags-w' }, autoTags.map(function (t) {
            return h('span', { key: 'a' + t, className: 'ichip dash' }, t)
          }))) : null,
        finder.length ? h('div', { className: 'itags-r' },
          h('span', { className: 'itags-h' }, 'Finder'),
          h('div', { className: 'itags-w' }, finder.map(function (t) {
            return h('span', { key: 'f' + t, className: 'ichip' }, t)
          }))) : null)
    : null

  var pathBlock = h('button', {
    className: 'ipath', title: '点击复制完整路径',
    onClick: function () { props.onCopyPath && props.onCopyPath(sel.path) }
  }, h(FF_Lucide, { nodes: FD_LUCIDE_UI.copy, size: 11, strokeWidth: 1.8 }), h('span', null, sel.path))

  // 三段真实内容：识别 = 结论卡；时间线 = 事件流；相似 = 候选清单。
  // 没数据时给「为什么没有」而不是一行灰字，避免用户以为功能坏了。
  var recNode = h('section', { className: 'isec' },
    h('div', { className: 'isec-h' },
      h(FF_Lucide, { nodes: FD_LUCIDE_UI.sparkle, size: 12, strokeWidth: 1.8, className: 'isec-i' }),
      h('b', null, '智能识别'),
      recCard ? h('span', { className: 'isec-b' }, recCard.cleanable === 'safe' ? '可清理' : '需保留') : null),
    recCard
      ? h('div', { className: 'irec' },
          h('div', { className: 'irec-what' }, recCard.what || '未识别出用途'),
          h('div', { className: 'irec-r' }, h('span', null, '从哪来'), h('b', null, recCard.sourceUnknown ? '来源未知' : (recCard.from || '—'))),
          h('div', { className: 'irec-r' }, h('span', null, '怎么用'), h('b', null, recCard.usage === 'unknown' ? '证据不足' : (recCard.usage || '—'))),
          h('div', { className: 'irec-r' }, h('span', null, '可清理'), h('b', null, recCard.cleanable === 'unknown' ? '不确定' : (recCard.cleanable || '—'))))
      : h('div', { className: 'isec-empty' }, busy ? '正在识别…' : '选中文件后自动识别来源与用法',
          h('button', { className: 'ipill', onClick: function () { props.onTool('recognize') } }, '打开识别面板')))

  var tlNode = h('section', { className: 'isec' },
    h('div', { className: 'isec-h' },
      h(FF_Lucide, { nodes: FD_LUCIDE_UI.history, size: 12, strokeWidth: 1.8, className: 'isec-i' }),
      h('b', null, '变更时间线'),
      tlEvents.length ? h('span', { className: 'isec-b' }, tlEvents.length + ' 条') : null),
    tlEvents.length
      ? h('div', { className: 'itl' }, tlEvents.slice(0, 8).map(function (e, i) {
          return h('div', { key: i, className: 'itl-r' },
            h('i', { className: 'itl-dot' }),
            h('span', { className: 'itl-k' }, e.kind || '变更'),
            h('time', null, fdTime(e.at)))
        }))
      : h('div', { className: 'isec-empty' }, busy ? '正在读取…' : '暂无变更事件',
          h('button', { className: 'ipill', onClick: function () { props.onTool('timeline') } }, '打开变更时间线')))

  var simNode = h('section', { className: 'isec' },
    h('div', { className: 'isec-h' },
      h(FF_Lucide, { nodes: FD_LUCIDE_UI.columns3, size: 12, strokeWidth: 1.8, className: 'isec-i' }),
      h('b', null, '相似文件'),
      simItems.length ? h('span', { className: 'isec-b' }, simItems.length + ' 个') : null),
    simItems.length
      ? h('div', { className: 'isim' }, simItems.slice(0, 6).map(function (it, i) {
          var p = it.path || it
          var pct = typeof it.score === 'number' ? Math.round(it.score * (it.score <= 1 ? 100 : 1)) : null
          return h('button', { key: i, className: 'isim-r', title: String(p),
            onClick: function () { props.onGoPath && props.onGoPath(p) } },
            h('span', { className: 'isim-n' }, fdBase(String(p))),
            pct === null ? null : h('span', { className: 'isim-p' }, pct + '%'))
        }))
      : h('div', { className: 'isec-empty' }, '以当前文件为基准找内容相近的其它文件',
          h('button', { className: 'ipill', onClick: function () { props.onTool('sim') } }, '开始比对')))

  return h('aside', { className: 'pane insp' }, head,
    h('div', { className: 'insp-body' },
      h('div', { className: 'ititle' },
        h('b', { title: sel.name }, sel.name),
        h('span', { className: 'ititle-k' }, sel.isDir ? '文件夹' : (fdKind(sel) || '文件'))),
      kvNode,
      tagBlock,
      pathBlock,
      h('div', { className: 'idiv' }),
      recNode, tlNode, simNode))
}

// ---- 分栏视图（Finder 式级联栏，第 24 轮 m11235 诉求 5）----
// 与标签条不是一回事：标签条是「多个工作区位置」，分栏是「同一个位置的多层下钻」。
// 交互契约：点文件夹 = 往右推一栏（不改变当前目录），点文件 = 选中并回调 onPick；
// 双击文件夹 = 真正进入（onGo），把这一栏变成新的首栏 —— 与 Finder 的习惯一致。
// 每一栏自己拉 ffList，因为父目录与子目录可能都还没在 FD_App 的 listing 里。
function FF_TColView(props) {
  var anchor = props.path || ''
  var st = React.useState({ cols: [], sel: {}, busy: {} })
  var s = st[0], setS = st[1]
  var seqRef = React.useRef(0)

  function loadCol(dir) {
    var id = dir
    var cur = st
    return ffList(dir).then(function (d) {
      setS(function (prev) {
        var cols = (prev.cols || []).filter(function (c) { return c.dir !== dir })
        cols.push({ dir: dir, entries: (d.entries || []), count: d.count || 0 })
        cols.sort(function (a, b) { return depthOf(a.dir) - depthOf(b.dir) })
        var busy = Object.assign({}, prev.busy); delete busy[id]
        return { cols: cols, sel: prev.sel, busy: busy }
      })
    }).catch(function () {
      setS(function (prev) {
        var cols = (prev.cols || []).filter(function (c) { return c.dir !== dir })
        cols.push({ dir: dir, entries: [], error: true, count: 0 })
        cols.sort(function (a, b) { return depthOf(a.dir) - depthOf(b.dir) })
        return { cols: cols, sel: prev.sel, busy: prev.busy }
      })
    })
  }

  function depthOf(p) { return String(p || '').split('/').filter(Boolean).length }

  // 首栏跟随当前路径；路径换了就把所有「不是它祖先」的栏裁掉，避免残留别处下钻的栏。
  React.useEffect(function () {
    if (!anchor) return
    var seq = ++seqRef.current
    setS(function (prev) {
      var keep = (prev.cols || []).filter(function (c) {
        return c.dir === anchor || c.dir.indexOf(anchor.replace(/\/+$/, '') + '/') === 0
      })
      var busy = {}; busy[anchor] = true
      return { cols: keep, sel: prev.sel, busy: busy }
    })
    loadCol(anchor)
  }, [anchor])

  function pick(e) {
    if (e.isDir) {
      var next = Object.assign({}, s.sel)
      next[dirOf(e.path)] = e.path
      setS(function (prev) {
        var keep = (prev.cols || []).filter(function (c) {
          return c.dir === anchor || e.path.indexOf(c.dir.replace(/\/+$/, '') + '/') === 0 || c.dir === dirOf(e.path)
        })
        var busy = Object.assign({}, prev.busy); busy[e.path] = true
        return { cols: keep, sel: next, busy: busy }
      })
      loadCol(e.path)
    } else {
      props.onPick && props.onPick(e)
    }
  }

  var cols = s.cols || []
  if (!cols.length) return h('div', { className: 'colview' }, h('div', { className: 'col-loading' }, '读取中…'))
  var total = cols.reduce(function (n, c) { return n + (c.entries || []).length }, 0)
  return h('div', { className: 'colview', 'data-cols': cols.length, 'data-total': total },
    cols.map(function (c) {
      var sel = s.sel[c.dir]
      return h('div', { key: c.dir, className: 'col', 'data-dir': c.dir },
        h('div', { className: 'col-h', title: c.dir }, fdBase(c.dir) || c.dir),
        h('div', { className: 'col-body' },
          (c.entries || []).map(function (e) {
            var on = sel === e.path
            return h('div', {
              key: e.path, className: 'col-row' + (on ? ' on' : '') + (e.isDir ? ' dir' : ''),
              role: 'option', tabIndex: 0, 'aria-selected': on, title: e.path,
              onClick: function () { pick(e) },
              onDoubleClick: function () { e.isDir ? props.onGo(e.path) : (props.onOpen && props.onOpen(e)) }
            },
            h(FF_Fico, { entry: e, size: 15 }),
            h('span', { className: 'col-n' }, e.name),
            e.isDir ? h('span', { className: 'col-ar' }, '›') : h('span', { className: 'col-sz' }, fdSize(e.size)))
          }),
          !c.entries || !c.entries.length
            ? h('div', { className: 'col-empty' }, c.error ? '读不到这一层' : '空文件夹')
            : null),
        s.busy[c.dir] ? h('div', { className: 'col-spin' }, h('i', null)) : null)
    }))
}

// ---- AI 抽屉：对话 + 任务两 tab ----
function FF_TDrawer(props) {
  var tab = props.drawerTab || 'chat'
  var msgs = props.messages || []
  var bubbles = msgs.map(function (m, i) {
    var isUser = m.role === 'user'
    var plan = m.payload && m.payload.kind === 'plan' && m.payload.plan ? m.payload.plan : null
    var bid = m.batch_id || (plan && plan.batchId)
    return h('div', { key: m.id || i, className: 'chat-msg ' + (isUser ? 'me' : 'ai') },
      h('div', { className: 'bub' }, m.content || ''),
      plan ? h(FF_PlanCard, Object.assign({ plan: plan }, (props.planProps || {})[bid] || {})) : null)
  })
  var presetBar = (props.presets || []).length ? h('div', { style: { display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 10 } },
    (props.presets || []).map(function (p) {
      return h('button', { key: p.id, className: 'pill', disabled: props.busy, title: p.desc + '（只出计划，勾选确认后才执行）',
        onClick: function () { props.onPreset && props.onPreset(p.id) } }, p.name)
    })) : null
  // 任务历史：接真实 /ops/batches，每条带真实撤销入口（ffUndo），不是只读列表。
  var ST = { planned: '待确认', approved: '已批准', done: '已执行', failed: '失败', rolled_back: '已撤销', cancelled: '已取消' }
  var taskList = (props.tasks || []).length
    ? (props.tasks || []).map(function (t, i) {
        var st = String(t.status || 'planned')
        var canUndo = st === 'done' || st === 'failed'
        return h('div', { key: t.id || i, className: 'task' },
          h('b', null, t.title || t.kind || ('批次 ' + (t.id || i))),
          h('time', null, fdTime(t.at || t.created_at || t.createdAt)),
          h('p', null, (t.summary || t.reply || '') + (st === 'done' ? ' · 可撤销' : '')),
          h('p', null,
            h('span', { className: 'st' + (st === 'done' ? '' : ' muted'), style: { marginRight: 8 } }, ST[st] || st),
            canUndo
              ? h('button', { className: 'pill', style: { height: 22, fontSize: 10.5 },
                  onClick: function () { props.onUndo && props.onUndo(t.id) } }, '撤销')
              : null))
      })
    : h('div', { className: 'insp-empty', style: { padding: '30px 10px' } },
        h('p', null, '还没有执行过的批次', h('br'), 'AI 出的计划在你勾选确认后执行，执行记录会留在这里'))

  return h('div', null,
    h('div', { className: 'scrim', onClick: function () { props.onAi(false) } }),
    h('div', { className: 'drawer' },
      h('div', { className: 'dr-h' },
        h('div', { className: 'dr-ic' }, h(FF_UiIco, { k: 'dri', icon: 'sparkle', size: 13 })),
        h('div', null,
          h('b', null, 'AI 助手'),
          h('div', { className: 'sub' }, '作用目录：' + (props.path || '未选择'))),
        h('select', { className: 'model-sel', value: props.modelKey || 'auto',
          disabled: !props.models || props.models.busy,
          title: '选择对话与整理计划使用的模型', 'aria-label': '选择模型',
          onChange: function (e) { props.onModel && props.onModel(e.target.value) } },
          props.modelOpts || [h('option', { key: 'auto', value: 'auto' }, '跟随宿主默认')]),
        h('button', { className: 'dr-x', 'aria-label': '关闭 AI 抽屉', onClick: function () { props.onAi(false) } },
          h(FF_UiIco, { k: 'drx', icon: 'close', size: 12 }))),
      h('div', { className: 'dr-tabs' },
        h('button', { className: 'dr-tab' + (tab === 'chat' ? ' on' : ''), onClick: function () { props.onDrawerTab('chat') } }, '对话'),
        h('button', { className: 'dr-tab' + (tab === 'task' ? ' on' : ''), onClick: function () { props.onDrawerTab('task') } }, '任务历史')),
      tab === 'chat'
        ? h('div', { className: 'dr-body' },
            presetBar,
            bubbles.length ? bubbles : h('div', { className: 'bub' }, '说点什么，例如「把大于 100MB 的挑出来」「按类型分好」。AI 只出计划，勾选并确认后才执行，删除一律进回收站。'),
            props.busy ? h('div', { className: 'chat-msg ai' }, h('div', { className: 'bub' }, '…思考中')) : null)
        : h('div', { className: 'dr-body' }, taskList),
      tab === 'chat' ? h('div', { className: 'dr-input' },
        h('textarea', { className: 'ipt', value: props.input, rows: 2, placeholder: '描述你想怎么整理…（Enter 发送，Shift+Enter 换行）',
          'aria-label': '给 AI 的指令',
          onChange: function (e) { props.onInput(e.target.value) },
          onKeyDown: function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); props.onSend() } } }),
        h('div', { className: 'ipt-row' },
          h('span', null, props.modelLabel || 'AI 只出计划，勾选并确认后才执行'),
          h('button', { className: 'send', disabled: props.busy || !String(props.input || '').trim(),
            onClick: props.onSend }, props.busy ? '思考中…' : '发送'))) : null))
}

// FlowFile 清理面板（第 6 个 tab）。
// 铁律：候选来自 GET clean/candidates 的规则枚举，面板自己不编路径、不枚举目录、不执行删除。
// 两道默认不勾：① 候选清单默认全不勾 ② 生成的清理计划项也默认全不勾（hookPlan defaultChecked:false）。
// 删除一律走 FF_PlanCard 的既有执行门：勾选 → dry-run → 二次确认 → trash -v → 可撤销。
// 纯脚本 + React.createElement，不用 JSX、不用模板字符串，由 scripts/build.mjs 拼进 client bundle。

var FF_CLEAN_RISK_LABEL = { low: "低风险", medium: "需留意" }

function ffCleanTone(c) {
  if (c && c.risk === "medium") return "warm"
  if (c && c.category === "duplicate") return "cool"
  return "neutral"
}

function FF_CleanPanel(props) {
  var data = props.data, loading = props.loading, error = props.error
  var onRescan = props.onRescan, onPlan = props.onPlan, onClearPlan = props.onClearPlan
  var cleanPlan = props.cleanPlan, planProps = props.planProps
  var pickedState = React.useState({}), picked = pickedState[0] || {}, setPicked = pickedState[1]

  if (loading) return h("div", { className: "fd-panel" }, h(FF_Msg, { text: "正在按规则枚举可清理候选…" }))
  if (error) return h("div", { className: "fd-panel" },
    h("div", { className: "fd-err fd-msg" }, error),
    h("div", { className: "fd-actions" }, h("button", { className: "fd-btn", onClick: onRescan }, "重新枚举")))
  if (!data) return h("div", { className: "fd-panel" },
    h("div", { className: "fd-panel-h" }, "清理"),
    h(FF_Msg, { text: "点「重新枚举」按规则列出可清理候选。清理只覆盖本机用户目录，不碰网络卷。" }),
    h("div", { className: "fd-actions" }, h("button", { className: "fd-btn", onClick: onRescan }, "重新枚举")))

  var candidates = data.candidates || []
  var summary = data.summary || { count: 0, bytes: 0, byCategory: {} }
  var chosenPaths = candidates.filter(function (c) { return !!picked[c.path] }).map(function (c) { return c.path })
  function toggle(p) { var n = Object.assign({}, picked); n[p] = !n[p]; setPicked(n) }

  var catChips = Object.keys(summary.byCategory || {}).map(function (k) {
    var c = summary.byCategory[k]
    return h("span", { key: k, className: "fd-chip neutral", style: { marginRight: 6, marginBottom: 4 } },
      (FF_CLEAN_CATEGORY_LABEL[k] || k) + " " + c.count + " 项 · " + fdSize(c.bytes))
  })

  var rows = candidates.length ? candidates.map(function (c) {
    return h("label", { key: c.path, className: "fd-check" },
      h("input", { type: "checkbox", checked: !!picked[c.path], onChange: function () { toggle(c.path) } }),
      h("span", null,
        h("b", null, c.name), " ",
        h("span", { className: "fd-chip " + ffCleanTone(c) }, FF_CLEAN_CATEGORY_LABEL[c.category] || c.category), " ",
        h("span", { className: "fd-chip " + (c.risk === "medium" ? "warm" : "neutral") }, FF_CLEAN_RISK_LABEL[c.risk] || c.risk), " ",
        h("span", { className: "fd-num" }, fdSize(c.size)),
        h("div", { className: "fd-note" }, c.reason),
        h("div", { className: "fd-note" }, c.path)
      )
    )
  }) : [h(FF_Msg, { key: "empty", text: "没有符合规则的可清理候选（大文件 / 久未使用 / 重复副本 / 旧安装包）。" })]

  var planCard = cleanPlan && cleanPlan.batchId
    ? h(FF_PlanCard, Object.assign({ plan: cleanPlan }, planProps || {}))
    : null

  return h("div", { className: "fd-panel" },
    h("div", { className: "fd-panel-h" }, "清理 · " + summary.count + " 项候选 · 合计 " + fdSize(summary.bytes),
      h("button", { className: "fd-btn", onClick: onRescan }, "重新枚举")),
    h("p", { className: "fd-note" }, "只列本机用户目录（homedir）内的已索引文件与 ~/Downloads 旧安装包；明确排除 /Volumes 与 SMB 卷，跳过凭据、模型权重、锁文件、记忆配置与隐藏目录。规则只负责「找出来」，删除一律进回收站且可逐字节撤销，永不永久删除。"),
    h("div", { style: { margin: "6px 0" } }, catChips),
    h("div", { className: "fd-card" },
      h("h4", null, "候选清单 · 默认全部不勾选"),
      rows,
      h("div", { className: "fd-actions" },
        h("button", { className: "fd-btn", disabled: !chosenPaths.length,
          onClick: function () { if (onPlan) onPlan(chosenPaths); setPicked({}) } }, "生成清理计划（" + chosenPaths.length + " 项）"),
        cleanPlan && cleanPlan.batchId ? h("button", { className: "fd-btn", onClick: onClearPlan }, "放弃这次计划") : null
      )
    ),
    planCard ? h("div", { style: { marginTop: 10 } },
      h("p", { className: "fd-note" }, "下方是刚生成的清理计划：请逐项勾选，预检后二次确认再执行，执行结果可撤销。计划项默认不勾选；若扫描后文件发生变化，预检会拦下该项。"),
      planCard) : null
  )
}

// FlowFile 主界面：左侧工作台入口 + 全幅主视图。
// 布局：顶栏 / 导航行 / 左栏侧栏分区 / 中栏文件表或网格 / 右栏属性 / 状态栏 / 六个能力 tab / 对话抽屉。
// 第 2 轮 ② P0：历史栈、可输入地址栏、面包屑卷根跳转、多选状态机、列排序/显隐、右键菜单、
//               网格缩略图 + QuickLook、六态状态栏、标签编辑、侧栏分区与容量条、快捷键模型。
// 安全边界：所有写操作都经右键菜单 → 结构化批次 → 勾选 → dry-run → 人确认 → 执行 → 可撤销。
// 纯脚本，由 scripts/build.mjs 拼进 window.__ModuleLoader__.load 包装；React 由宿主提供。
var FD_ID = 'flowfile'
var h = React.createElement

var FF_TABS = [
  { id: 'manage', label: '文件管理' },
  { id: 'dup', label: '文件查重' },
  { id: 'sim', label: '相似文件' },
  { id: 'timeline', label: '变更时间线' },
  { id: 'recognize', label: '智能识别' },
  { id: 'clean', label: '清理' },
  { id: 'settings', label: '设置' }
]

function fdStore() { try { return window.localStorage } catch (e) { return null } }
// ---- 可调布局（m06434 → 第 13 轮 v4）：左树宽 / 右栏宽 / 底部对话 dock 高 ----
// 第 13 轮起对话不再占右栏，右栏只放属性与预览；dock 独立在 .fd-body 下方、横跨整幅。
var FD_LAYOUT_KEY = 'flowfile.layout'
var FD_LAYOUT_DEF = { treeW: 210, rightW: 380, dockH: 300 }
var FD_LAYOUT_MIN = { treeW: 120, rightW: 220, dockH: 96 }
var FD_LAYOUT_MAX = { treeW: 620, rightW: 900, dockH: 760 }

function fdClamp(v, lo, hi) { var n = Number(v); return isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : lo }

function fdLoadLayout(store) {
  var out = { treeW: FD_LAYOUT_DEF.treeW, rightW: FD_LAYOUT_DEF.rightW, dockH: FD_LAYOUT_DEF.dockH }
  try {
    var raw = store ? store.getItem(FD_LAYOUT_KEY) : null
    if (!raw) return out
    var o = JSON.parse(raw)
    out.treeW = fdClamp(o.treeW, FD_LAYOUT_MIN.treeW, FD_LAYOUT_MAX.treeW)
    out.rightW = fdClamp(o.rightW, FD_LAYOUT_MIN.rightW, FD_LAYOUT_MAX.rightW)
    out.dockH = fdClamp(o.dockH, FD_LAYOUT_MIN.dockH, FD_LAYOUT_MAX.dockH)
    return out
  } catch (e) { return out }
}

function fdSaveLayout(store, v) { try { if (store) store.setItem(FD_LAYOUT_KEY, JSON.stringify(v)) } catch (e) {} }

// axis: 'tree' | 'right' | 'dock'；交给 pointermove 按指针位置换算
// dock 用「距底高度」而不是百分比：dock 高度是绝对值，页面变高时不会被拉成半个屏。
// 第 20 轮 Tahoe：列表密度（宽松/标准/紧凑），与设计稿 html[data-density] 对齐。
var FD_DENSITY_KEY = 'flowfile.density'
var FD_DENSITY_CYCLE = ['regular', 'compact', 'cozy']
function fdLoadDensity(store) {
  try {
    var v = store && store.getItem(FD_DENSITY_KEY)
    return FD_DENSITY_CYCLE.indexOf(v) >= 0 ? v : 'regular'
  } catch (e) { return 'regular' }
}
function fdNextDensity(cur) {
  var i = FD_DENSITY_CYCLE.indexOf(cur)
  return FD_DENSITY_CYCLE[(i < 0 ? 0 : i + 1) % FD_DENSITY_CYCLE.length]
}
function fdSaveDensity(store, v) {
  try { if (store) store.setItem(FD_DENSITY_KEY, v) } catch (e) {}
  return v
}
function fdLayoutFrom(axis, box, next) {
  if (axis === 'tree') return { treeW: fdClamp(next.x - box.left, FD_LAYOUT_MIN.treeW, FD_LAYOUT_MAX.treeW) }
  if (axis === 'right') return { rightW: fdClamp(box.right - next.x, FD_LAYOUT_MIN.rightW, FD_LAYOUT_MAX.rightW) }
  return { dockH: fdClamp(box.bottom - next.y, FD_LAYOUT_MIN.dockH, FD_LAYOUT_MAX.dockH) }
}


// 第 26 轮：卷列表完全以 host 的 /flowfile/volumes 为准，客户端不再自行补项。
// 曾经试过在客户端补一张「系统盘」卡，但宿主进程未重载时点它只会拿到 403 ——
// 在界面上摆一个点了就报错的入口，比暂时少一个入口更差。
function FD_App() {
  var volState = React.useState([]), volumes = volState[0], setVolumes = volState[1]
  var pathState = React.useState(''), path = pathState[0], setPath = pathState[1]
  var listState = React.useState(null), listing = listState[0], setListing = listState[1]
  var selState = React.useState(null), selected = selState[0], setSelected = selState[1]
  var metaState = React.useState(null), meta = metaState[0], setMeta = metaState[1]
  var qState = React.useState(''), query = qState[0], setQuery = qState[1]
  var tagState = React.useState(''), tagFilter = tagState[0], setTagFilter = tagState[1]
  var errState = React.useState(''), error = errState[0], setError = errState[1]
  var loadState = React.useState(false), loading = loadState[0], setLoading = loadState[1]
  var tabState = React.useState('manage'), activeTab = tabState[0], setActiveTab = tabState[1]
  // 甲方案：能力抽屉开关（切到非 manage 的 tab 即开，关=回 manage）
  // ---- 第 7 轮 VSCode 布局状态 ----
  var tabStackState = React.useState(null), fdTabs = tabStackState[0], setFdTabs = tabStackState[1]
  var lastChatPlanState = React.useState(null), lastChatPlan = lastChatPlanState[0], setLastChatPlan = lastChatPlanState[1]
  // ---- 可调布局（m06434）----
  var layoutState = React.useState(function () { return fdLoadLayout(fdStore()) })
  var layout = layoutState[0], setLayout = layoutState[1]
  // 对话 dock 展开/收起（收起后只留一行标题，把高度还给文件表）
  var dockState = React.useState(true), dockOpen = dockState[0], setDockOpen = dockState[1]
  // 第 18 轮 A 方案：右栏预览段默认折叠，把高度让给任务历史 + 对话双段常驻。
  var previewState = React.useState(false), previewOpen = previewState[0], setPreviewOpen = previewState[1]
  // ---- 第 15 轮（m07306 ①②）：左树 / 右栏可折叠 + 低分辨率自适应 ----
  var foldState = React.useState(function () { return loadUiFold(fdStore()) }), folds = foldState[0], setFolds = foldState[1]
  var availState = React.useState({ w: 1640, h: 1080 }), avail = availState[0], setAvail = availState[1]
  var presetState = React.useState([]), presetList = presetState[0], setPresetList = presetState[1]
  // fitLayout 把用户设的尺寸按当前可用宽高收敛：低分辨率下自动收树、收/藏右栏、压 dock。
  var fit = fitLayout(layout, avail.w, avail.h)
  var effRight = (folds.right && !fit.rightHidden) ? fit.rightW : 0
  function fdToggleFold(axis) {
    var next = { tree: folds.tree, right: folds.right }
    if (axis === 'tree') next.tree = !next.tree
    else next.right = !next.right
    setFolds(saveUiFold(fdStore(), next))
  }
  var rootRef = React.useRef(null)
  var dragRef = React.useRef(null)
  function fdApplyVars(root, v) {
    if (!root) return
    var f = fitLayout(v, avail.w, avail.h)
    var tw = (folds.tree ? f.treeW : 0) + 'px'
    var rw = ((folds.right && !f.rightHidden) ? f.rightW : 0) + 'px'
    root.style.setProperty('--fd-tree-w', tw)
    root.style.setProperty('--fd-right-w', rw)
    root.style.setProperty('--fd-dock-h', f.dockH + 'px')
    root.setAttribute('data-tree-fold', folds.tree ? 'off' : 'on')
    root.setAttribute('data-right-fold', (folds.right && !f.rightHidden) ? 'off' : 'on')
    if (f.compact) root.setAttribute('data-compact', 'on')
    else root.removeAttribute('data-compact')
  }
  function fdStartDrag(axis, ev) {
    if (ev.button !== undefined && ev.button !== 0) return
    ev.preventDefault()
    var root = rootRef.current
    if (!root) return
    var box = root.getBoundingClientRect()
    root.setAttribute('data-dragging', axis)
    dragRef.current = { axis: axis, box: box, patch: null }
    var onMove = function (e) {
      var d = dragRef.current
      if (!d) return
      var patch = fdLayoutFrom(d.axis, d.box, { x: e.clientX, y: e.clientY })
      d.patch = Object.assign(d.patch || {}, patch)
      fdApplyVars(root, { treeW: d.patch.treeW !== undefined ? d.patch.treeW : layout.treeW,
        rightW: d.patch.rightW !== undefined ? d.patch.rightW : layout.rightW,
        dockH: d.patch.dockH !== undefined ? d.patch.dockH : layout.dockH })
    }
    var onUp = function () {
      root.removeAttribute('data-dragging')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      var d = dragRef.current
      dragRef.current = null
      var merged = { treeW: layout.treeW, rightW: layout.rightW, dockH: layout.dockH }
      if (d && d.patch) Object.assign(merged, d.patch)
      fdApplyVars(root, merged)
      setLayout(merged)
      fdSaveLayout(fdStore(), merged)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // 首次挂载把持久化的布局值写到 root（CSS 变量默认值只是出厂态）
  React.useEffect(function () { fdApplyVars(rootRef.current, layout) }, [layout.treeW, layout.rightW, layout.dockH, folds.tree, folds.right, avail.w, avail.h])
  // 自适应：量 .fd-root 的真实可用宽高（不是视口——宿主左侧导航会吃掉约 280px），随窗口变化重算。
  React.useEffect(function () {
    function measure() {
      var el = rootRef.current
      if (!el) return
      var w = el.clientWidth || 0
      var h = el.clientHeight || 0
      if (w > 0 && h > 0) setAvail(function (prev) { return (prev.w === w && prev.h === h) ? prev : { w: w, h: h } })
    }
    measure()
    window.addEventListener('resize', measure)
    var ro = (typeof window.ResizeObserver === 'function') ? new window.ResizeObserver(measure) : null
    if (ro && rootRef.current) ro.observe(rootRef.current)
    return function () { window.removeEventListener('resize', measure); if (ro) ro.disconnect() }
  }, [])
  function fdResetAxis(axis) {
    var next = { treeW: layout.treeW, rightW: layout.rightW, dockH: layout.dockH }
    if (axis === 'tree') next.treeW = FD_LAYOUT_DEF.treeW
    else if (axis === 'right') next.rightW = FD_LAYOUT_DEF.rightW
    else next.dockH = FD_LAYOUT_DEF.dockH
    fdApplyVars(rootRef.current, next)
    setLayout(next)
    fdSaveLayout(fdStore(), next)
  }

  function openTab(p) {
    var tabs = fdTabs || []
    if (tabs.some(function (t) { return t.path === p })) { go(p, { track: false }); return }
    var t = { path: p, name: nameOf(p) || p }
    var next = tabs.concat([t]).slice(-8)
    setFdTabs(next); go(p, { track: false })
  }
  function closeTab(p) {
    var tabs = fdTabs || []
    var next = tabs.filter(function (t) { return t.path !== p })
    setFdTabs(next)
    if (p === path && next.length) go(next[next.length - 1].path, { track: false })
  }
  function listDirForTree(p) {
    return ffList(p).then(function (d) {
      return (d.entries || []).filter(function (e) { return e.isDir }).map(function (e) { return fdBase(e.path) })
    })
  }

  // 扫描
  var scanState = React.useState(null), scan = scanState[0], setScan = scanState[1]
  // 各能力面板数据
  var dupState = React.useState(null), dup = dupState[0], setDup = dupState[1]
  var simState = React.useState(null), sim = simState[0], setSim = simState[1]
  var tlState = React.useState(null), tl = tlState[0], setTl = tlState[1]
  var recState = React.useState(null), rec = recState[0], setRec = recState[1]
  var cleanState = React.useState(null), clean = cleanState[0], setClean = cleanState[1]
  var cleanPlanState = React.useState(null), cleanPlan = cleanPlanState[0], setCleanPlan = cleanPlanState[1]
  // m07634 顺带修：原来 setPanelBusy 是布尔开关，timeline/recognize 两个请求各写一次 false，
  // 先回来的那个会把 busy 关掉 → 右栏在识别还没回来时就显示「选中文件后自动识别…」，看着像没生效。
  // 改成计数：>0 就是还有活在跑。
  var panelBusyState = React.useState(0), panelBusyCount = panelBusyState[0], setPanelBusyCount = panelBusyState[1]
  var panelBusy = panelBusyCount > 0
  function panelBusyAdd(n) { setPanelBusyCount(function (c) { return Math.max(0, c + n) }) }
  // 对话
  // 第 20 轮：原「对话 dock 展开」语义升级为「AI 抽屉开关」（设计稿 .app.ai-open）
  var chatOpenState = React.useState(false), drawerOpen = chatOpenState[0], setDrawerOpen = chatOpenState[1]
  var setChatOpen = setDrawerOpen
  var chatMsgsState = React.useState([]), chatMsgs = chatMsgsState[0], setChatMsgs = chatMsgsState[1]
  var chatInputState = React.useState(''), chatInput = chatInputState[0], setChatInput = chatInputState[1]
  var chatBusyState = React.useState(false), chatBusy = chatBusyState[0], setChatBusy = chatBusyState[1]
  var planState = React.useState({}), planProps = planState[0], setPlanProps = planState[1]
  var modelState = React.useState(null), models = modelState[0], setModels = modelState[1]
  // 第 17 轮（m07721）：设置（默认关闭识别）+ 当前上传策略
  var setState = React.useState(null), settings = setState[0], setSettings = setState[1]
  var setUplinkState = React.useState(null), uplink = setUplinkState[0], setUplink = setUplinkState[1]
  var setDraftState = React.useState(null), settingsDraft = setDraftState[0], setSettingsDraft = setDraftState[1]
  function loadSettingsUi() {
    ffGetSettings().then(function (d) { setSettings(d.settings); setUplink(d.uplink); setSettingsDraft(d.settings) })
      .catch(function (e) { setError(e.message) })
  }
  function saveSettingsUi() {
    if (!settingsDraft) return
    setPanelBusyAdd(1)
    ffSetSettings(settingsDraft).then(function (d) {
      setSettings(d.settings); setUplink(d.uplink); setSettingsDraft(d.settings); panelBusyAdd(-1)
      toast('设置已保存：' + (d.uplink && d.uplink.reason ? d.uplink.reason : ''))
    }).catch(function (e) { setError(e.message); panelBusyAdd(-1) })
  }

  // ---- 第 2 轮 ② 新状态 ----
  var histState = React.useState(createHistory()), hist = histState[0], setHist = histState[1]
  var addrState = React.useState(''), address = addrState[0], setAddress = addrState[1]
  var multiState = React.useState(FF_SEL_CLEAR), multi = multiState[0], setMulti = multiState[1]
  var sortState = React.useState(null), sort = sortState[0], setSort = sortState[1]
  // 第 25 轮：侧栏「本目录筛选」的当前值（'' | recent | large | tagged）。不持久化——
  // 它描述的是「我现在想在这个目录里看什么」，换了目录再带着过滤会让人以为文件丢了。
  var quickState = React.useState(''), quick = quickState[0], setQuick = quickState[1]
  var colsState = React.useState(loadColumns(fdStore())), columns = colsState[0], setColumns = colsState[1]
  var viewState = React.useState(loadViewMode(fdStore())), viewMode = viewState[0], setViewMode = viewState[1]
  var favState = React.useState(loadFavorites(fdStore())), favorites = favState[0], setFavorites = favState[1]
  var tagListState = React.useState([]), allTags = tagListState[0], setAllTags = tagListState[1]
  var capState = React.useState(null), capacity = capState[0], setCapacity = capState[1]
  var clipState = React.useState({ mode: 'copy', paths: [] }), clipboard = clipState[0], setClipboard = clipState[1]
  var ctxState = React.useState(null), context = ctxState[0], setContext = ctxState[1]
  var colPanelState = React.useState(false), colPanel = colPanelState[0], setColPanel = colPanelState[1]
  var conflictState = React.useState(null), conflict = conflictState[0], setConflict = conflictState[1]
  var inputDlgState = React.useState(null), inputDialog = inputDlgState[0], setInputDialog = inputDlgState[1]
  var tagEditState = React.useState(null), tagEditor = tagEditState[0], setTagEditor = tagEditState[1]
  var qlState = React.useState(null), quicklook = qlState[0], setQuicklook = qlState[1]
  var toastState = React.useState(null), toast = toastState[0], showToast = toastState[1]
  var thumbState = React.useState({}), thumbs = thumbState[0], setThumbs = thumbState[1]
  // 预览大缩略图（m07634）：右栏顶部只放当前选中项的一张，独立于网格小图缓存。
  var prevThumbState = React.useState(null), previewThumb = prevThumbState[0], setPreviewThumb = prevThumbState[1]
  // 底坞缩略图「已请求过」记录（含失败）：只防重复请求，不参与渲染。
  var triedRef = React.useRef({})
  var menuPlanState = React.useState(null), menuPlan = menuPlanState[0], setMenuPlan = menuPlanState[1]
  var offlineState = React.useState(false), offline = offlineState[0], setOffline = offlineState[1]
  // ---- 第 20 轮（m09643）Tahoe 结构层：密度 / AI 抽屉 tab / 检查器展开项 / 批次历史 ----
  var densityState = React.useState(function () { return fdLoadDensity(fdStore()) }), density = densityState[0], setDensity = densityState[1]
  var drawerTabState = React.useState('chat'), drawerTab = drawerTabState[0], setDrawerTab = drawerTabState[1]
  // 底坞展开态：选中文件后默认收起（selected 档），用户点把手才展开属性（expanded 档）
  var dockOpenState = React.useState(false), dockOpen = dockOpenState[0], setDockOpen = dockOpenState[1]
  var ctxOpenState = React.useState(''), ctxOpen = ctxOpenState[0], setCtxOpen = ctxOpenState[1]
  // 第 24 轮（m11235 诉求 3）：检查器可手动隐藏。与断点自动让位分开存，
  // 用户点一次收起就一直是收起，不因为窗口变宽又自己弹回来。
  var inspState = React.useState(function () { return loadInspOpen(fdStore()) }), inspOpen = inspState[0], setInspOpen = inspState[1]
  function toggleInsp(on) {
    var v = (on === undefined) ? !inspOpen : !!on
    setInspOpen(saveInspOpen(fdStore(), v))
  }
  var batchesState = React.useState([]), batches = batchesState[0], setBatches = batchesState[1]

  var toastTimer = React.useRef(null)
  function toast(text, tone) {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    showToast({ text: text, tone: tone || 'info' })
    toastTimer.current = setTimeout(function () { showToast(null) }, 3200)
  }
  React.useEffect(function () { return function () { if (toastTimer.current) clearTimeout(toastTimer.current) } }, [])
  // 任务历史：抽屉的「任务历史」tab 读真实 /ops/batches（既有接口，不新开写路径）。
  function loadBatches() {
    ffBatches(40).then(function (d) { setBatches((d && d.batches) || []) }).catch(function () { setBatches([]) })
  }
  React.useEffect(function () { loadBatches() }, [])
  React.useEffect(function () { loadSettingsUi() }, [])

  function setPlan(bid, patch) {
    setPlanProps(function (prev) {
      var cur = prev[bid] || { checked: {}, dry: null, execResult: null, busy: false }
      return Object.assign({}, prev, { [bid]: Object.assign({}, cur, patch) })
    })
  }

  // ---- 导航 ----
  function loadCapacity(p) {
    if (!p) return
    ffCapacity(p).then(setCapacity).catch(function () { setCapacity(null) })
  }
  function go(p, opts) {
    var o = opts || {}
    setError(''); setOffline(false); setListing(null); setSelected(null); setMeta(null); setDockOpen(false)
    setMulti(FF_SEL_CLEAR); setContext(null); setColPanel(null)
    setDup(null); setSim(null); setTl(null); setRec(null)
    setLoading(true)
    ffList(p).then(function (data) {
      setPath(data.path); setListing(data); setLoading(false)
      setAddress(data.path)
      if (o.track !== false) setHist(function (hh) { return historyPush(hh, data.path) })
      loadCapacity(data.path)
    }).catch(function (e) {
      setError(e.message); setLoading(false)
      if (/卷|断连|挂载|unmount|EIO|ENOTCONN/i.test(e.message)) setOffline(true)
    })
  }
  function navBack() { var r = historyBack(hist); if (!r) return; setHist(r.hist); go(r.path, { track: false }) }
  function navForward() { var r = historyForward(hist); if (!r) return; setHist(r.hist); go(r.path, { track: false }) }
  function goAddress() {
    var v = normalizeAddress(address)
    if (!isSafeAddress(v)) return toast('请输入以 / 开头的绝对路径，且不含 .. 或 ~', 'error')
    go(v)
  }
  function goUp() { if (listing && listing.parent) go(listing.parent) }

  // 第 13 轮（m06568 ③）：双击原地导航；⌘/Ctrl 双击或右键「在新标签页中打开」才开新标签。
  // 原实现每次下钻都新开 tab，标签条被撑满、历史和标签两套模型互相打架。
  function openEntry(e, ev) {
    if (!e) return
    var mod = !!(ev && (ev.metaKey || ev.ctrlKey))
    if (e.isDir) return mod ? openTab(e.path) : go(e.path)
    ffOpen(e.path, false).catch(function (er) { toast('打开失败：' + er.message, 'error') })
  }
  function showMeta(e) {
    setSelected(e.path); setMeta(null); setSim(null); setTl(null); setRec(null)
    ffMeta(e.path).then(setMeta).catch(function (er) { setError(er.message) })
    // 第 7 轮 m05624：智能识别与时间线自动执行，结果在右栏预览显示
    // 预览缩略图：只有能缩的真图片才去取（canThumb 复用网格那套扩展名表），非图片给占位，不假装有图。
    setPreviewThumb(null)
    if (canThumb(e)) {
      ffThumb(e.path, 480).then(function (t) { if (t && t.ok) setPreviewThumb({ path: e.path, dataUrl: t.dataUrl }) }).catch(function () {})
    }
    loadTimeline(e.path)
    loadRecognize(e.path)
    if (activeTab === 'recognize') loadRecognize(e.path)
  }

  // ---- 多选行点击 ----
  function rowPick(e, ev) {
    ev && ev.stopPropagation && ev.stopPropagation()
    var act = (ev && (ev.metaKey || ev.ctrlKey)) ? 'cmd' : (ev && ev.shiftKey ? 'shift' : 'click')
    setMulti(reduceSelection(multi, { type: act, path: e.path, order: shownPaths }))
    if (act === 'click' || act === 'shift') showMeta(e)
  }
  function rowKeyDown(e, ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); openEntry(e) }
  }
  function blankContext(ev) {
    ev.preventDefault()
    setContext({ x: ev.clientX, y: ev.clientY, isBlank: true, target: null })
  }
  function rowContext(e, ev) {
    ev.preventDefault(); ev.stopPropagation()
    if (multi.selected.indexOf(e.path) < 0) setMulti({ selected: [e.path], anchor: e.path })
    setContext({ x: ev.clientX, y: ev.clientY, isBlank: false, target: e })
  }

  // ---- 菜单计划 → 既有执行门（不新开写路径）----
  function runMenuPlan(action, extra) {
    var paths = multi.selected.length ? multi.selected.slice() : (selected ? [selected] : [])
    var body = Object.assign({
      action: action, path: path, selection: paths,
      clipboard: { mode: clipboard.mode, paths: clipboard.paths.slice() },
      entries: entries, conflict: 'keep'
    }, extra || {})
    ffMenuPlan(body).then(function (r) {
      hookPlan(r.plan)
      setMenuPlan(r.plan)
      setActiveTab('manage')
      toast('已生成计划：' + (r.plan.reply || action) + ' · 勾选后先预检，再确认执行（可撤销）')
      if (action === 'paste') setClipboard({ mode: 'copy', paths: [] })
    }).catch(function (er) { setError(er.message) })
  }
  function doPaste(choice) {
    if (!clipboard.paths.length) return toast('剪贴板是空的', 'warning')
    var c = conflictsFor(clipboard, path, entries)
    if (c.length && !choice) { setConflict({ conflicts: c }); return }
    setConflict(null)
    runMenuPlan('paste', { conflict: choice || 'keep' })
  }
  function copyPath(p) {
    try { navigator.clipboard.writeText(p); toast('已拷贝路径') }
    catch (e) { toast('拷贝失败：' + (e && e.message ? e.message : e), 'error') }
  }
  function onMenuAction(id) {
    var t = context && context.target
    setContext(null)
    if (id === 'refresh') return go(path, { track: false })
    if (id === 'selectAll') return setMulti(reduceSelection(multi, { type: 'selectAll', order: shownPaths }))
    if (id === 'open') return openEntry(t)
    if (id === 'openTab') {
      if (!t) return
      if (t.isDir) return openTab(t.path)
      return openEntry(t)
    }
    if (id === 'copy' || id === 'cut') {
      var paths = multi.selected.length ? multi.selected.slice() : (t ? [t.path] : [])
      if (!paths.length) return
      setClipboard({ mode: id === 'cut' ? 'cut' : 'copy', paths: paths })
      return toast((id === 'cut' ? '已剪切 ' : '已复制 ') + paths.length + ' 项，到目标目录右键「粘贴」')
    }
    if (id === 'copyPath') return copyPath(t ? t.path : path)
    if (id === 'paste') return doPaste()
    if (id === 'newFolder') return setInputDialog({ title: '新建文件夹', value: '新建文件夹', action: 'newFolder', error: '' })
    if (id === 'rename') return setInputDialog({ title: '重命名', value: t ? nameOf(t.path) : '', action: 'rename', error: '' })
    if (id === 'tag') return openTagEditor()
    if (id === 'trash') return runMenuPlan('trash')
    if (id === 'findDup') {
      setActiveTab('dup'); return loadDup()
    }
    if (id === 'findSim') {
      var sp = t ? t.path : (multi.selected.length === 1 ? multi.selected[0] : null)
      if (!sp) return toast('先选中一个文件再查找相似', 'warning')
      setActiveTab('sim'); return loadSim(sp)
    }
  }
  function submitInput() {
    var d = inputDialog
    if (!d) return
    var v = String(d.value || '').trim()
    if (!v) return setInputDialog(Object.assign({}, d, { error: '名称不能为空' }))
    if (/[\/]/.test(v)) return setInputDialog(Object.assign({}, d, { error: '名称不能包含斜杠' }))
    setInputDialog(null)
    runMenuPlan(d.action, { newName: v })
  }

  // ---- 标签编辑 ----
  function openTagEditor() {
    var target = selected || (context && context.target ? context.target.path : null)
    if (!target) return toast('先点选一个文件', 'warning')
    setTagEditor({ path: target, current: (meta && meta.userTags) ? meta.userTags.slice() : [], newName: '' })
  }
  function applyTags() {
    if (!tagEditor) return
    var paths = multi.selected.length ? multi.selected.slice() : [tagEditor.path]
    Promise.all(paths.map(function (p) { return ffTags(p, tagEditor.current, 'user') })).then(function () {
      toast('已给 ' + paths.length + ' 项应用标签')
      setTagEditor(null)
      ffTagList().then(function (d) { setAllTags(d.tags || []) }).catch(function () {})
      if (selected) ffMeta(selected).then(setMeta).catch(function () {})
    }).catch(function (er) { setError(er.message) })
  }

  // ---- 快捷键（window 级，输入框内不劫持）----
  var hotkeyRef = React.useRef(null)
  hotkeyRef.current = function (ev) {
    var a = matchHotkey({ key: ev.key, metaKey: ev.metaKey, ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey, altKey: ev.altKey,
      targetTag: ev.target && ev.target.tagName, isContentEditable: ev.target && ev.target.isContentEditable })
    if (!a) return
    if (a === 'inspector') { ev.preventDefault(); return toggleInsp() }
    if (a === 'search') {
      ev.preventDefault()
      var box = document.querySelector('.fd-root .spot input')
      if (box) { box.focus(); box.select() }
      return
    }
    if (a === 'ai') { ev.preventDefault(); return setDrawerOpen(true) }
    if (a === 'viewList' || a === 'viewGrid' || a === 'viewColumns') {
      ev.preventDefault()
      var m = a === 'viewList' ? 'list' : (a === 'viewGrid' ? 'grid' : 'columns')
      return setViewMode(saveViewMode(fdStore(), m))
    }
    if (a === 'selectAll' || a === 'deselectAll') { ev.preventDefault(); return setMulti(reduceSelection(multi, { type: a, order: shownPaths })) }
    if (a === 'escape') { setContext(null); setColPanel(null); setConflict(null); setInputDialog(null); setQuicklook(null); return setMulti(FF_SEL_CLEAR) }
    if (a === 'back') { ev.preventDefault(); return navBack() }
    if (a === 'forward') { ev.preventDefault(); return navForward() }
    if (a === 'up') { ev.preventDefault(); return goUp() }
    if (a === 'selectAll') return
    var focus = selected
    if (a === 'quicklook' && focus) { ev.preventDefault(); var fe = entries.filter(function (x) { return x.path === focus })[0]; if (fe) { setQuicklook(fe); ffThumb(fe.path, 512).then(function (t) { if (t.ok) setThumbs(function (p) { return Object.assign({}, p, { [fe.path]: t.dataUrl }) }) }).catch(function () {}) } return }
    if (a === 'open' && focus) return openEntry(entries.filter(function (x) { return x.path === focus })[0])
    if (a === 'rename' && focus) return setInputDialog({ title: '重命名', value: nameOf(focus), action: 'rename', error: '' })
    if (a === 'trash' && multi.selected.length) return runMenuPlan('trash')
    if (a === 'copy' || a === 'cut') {
      if (!multi.selected.length) return
      ev.preventDefault()
      setClipboard({ mode: a === 'cut' ? 'cut' : 'copy', paths: multi.selected.slice() })
      return toast((a === 'cut' ? '已剪切 ' : '已复制 ') + multi.selected.length + ' 项')
    }
    if (a === 'paste') { ev.preventDefault(); return doPaste() }
  }
  React.useEffect(function () {
    var fn = function (e) { hotkeyRef.current && hotkeyRef.current(e) }
    window.addEventListener('keydown', fn)
    return function () { window.removeEventListener('keydown', fn) }
  }, [])

  // ---- 模型下拉 ----
  function applyModels(s) {
    var pinned = s.override && s.overrideAvailable && s.override.provider && s.override.model
    var key = pinned ? (s.override.provider + '/' + s.override.model) : 'auto'
    setModels({ autoLabel: s.autoLabel, routes: s.routes || [], currentKey: key, overrideAvailable: s.overrideAvailable, busy: false })
  }
  function loadModels() {
    setModels(function (prev) { return Object.assign({}, prev || {}, { busy: true }) })
    ffModels().then(applyModels).catch(function () { setModels(function (prev) { return Object.assign({}, prev || {}, { busy: false }) }) })
  }
  function chooseModel(v) {
    var sel = v === 'auto' ? { auto: true } : null
    if (!sel) { var i = String(v).indexOf('/'); sel = { provider: v.slice(0, i), model: v.slice(i + 1) } }
    setModels(function (prev) { return Object.assign({}, prev || {}, { busy: true }) })
    ffSetModel(sel).then(applyModels).catch(function (e) { setError('模型切换失败：' + e.message); loadModels() })
  }

  React.useEffect(function () {
    loadModels()
    ffTagList().then(function (d) { setAllTags(d.tags || []) }).catch(function () {})
    ffGetVolumes().then(function (data) {
      setVolumes(data.volumes || [])
      if (data.volumes && data.volumes.length) go(data.volumes[0].path)
    }).catch(function (e) { setError('卷列表加载失败：' + e.message) })
    ffChatHistory(100).then(function (d) {
      var ms = d.messages || []
      setChatMsgs(ms)
      ms.forEach(function (m) {
        var p = m.payload && m.payload.kind === 'plan' && m.payload.plan
        if (p && p.batchId) hookPlan(p)
      })
    }).catch(function () {})
  }, [])

  // ---- 扫描 ----
  var scanTimer = React.useRef(null)
  function pollScan(id) {
    if (scanTimer.current) clearInterval(scanTimer.current)
    scanTimer.current = setInterval(function () {
      ffScanStatus(id).then(function (st) {
        setScan(st)
        if (st.state !== 'running' && st.state !== 'queued') {
          clearInterval(scanTimer.current); scanTimer.current = null
          if (st.state === 'done') loadDup()
        }
      }).catch(function () {})
    }, 700)
  }
  React.useEffect(function () { return function () { if (scanTimer.current) clearInterval(scanTimer.current) } }, [])
  function startScan(p) {
    setError('')
    ffScan(p || path, {}).then(function (d) { pollScan(d.scanId); ffScanStatus(d.scanId).then(setScan).catch(function () {}) })
      .catch(function (e) { setError(e.message) })
  }
  function cancelScan(id) { ffScanCancel(id).then(function () { if (scanTimer.current) clearInterval(scanTimer.current); ffScanStatus(id).then(setScan).catch(function () {}) }).catch(function (e) { setError(e.message) }) }

  // ---- 能力面板 ----
  function rootOf(p) { return String(p).split('/').slice(0, 3).join('/') }
  function loadDup() {
    panelBusyAdd(1); setDup(null)
    ffDuplicates(rootOf(path)).then(function (d) { setDup(d); panelBusyAdd(-1) }).catch(function (e) { setError(e.message); panelBusyAdd(-1) })
  }
  function loadSim(p) {
    panelBusyAdd(1); setSim(null)
    ffSimilar(p).then(function (d) { setSim(d); panelBusyAdd(-1) }).catch(function (e) { setError(e.message); panelBusyAdd(-1) })
  }
  function loadTimeline(p) {
    panelBusyAdd(1); setTl(null)
    ffTimeline(p, 60).then(function (d) { setTl(d); panelBusyAdd(-1) }).catch(function (e) { setError(e.message); panelBusyAdd(-1) })
  }
  function loadTimelineAll() {
    panelBusyAdd(1); setTl(null)
    ffTimeline(null, 100).then(function (d) { setTl(d); panelBusyAdd(-1) }).catch(function (e) { setError(e.message); panelBusyAdd(-1) })
  }
  function loadRecognize(p) {
    panelBusyAdd(1); setRec(null)
    ffRecognizeCached(p).then(function (d) {
      setRec(d); panelBusyAdd(-1)
      // 识别结果里的派生标签立刻反映到右栏，不必再拉一次 meta。
      if (d && d.tags && d.tags.length) setMeta(function (prev) { return prev ? Object.assign({}, prev, { autoTags: d.tags }) : prev })
    }).catch(function (e) { setError(e.message); panelBusyAdd(-1) })
  }
  function loadClean() {
    panelBusyAdd(1); setClean(null)
    ffCleanCandidates().then(function (d) { setClean(d); panelBusyAdd(-1) }).catch(function (e) { setError(e.message); panelBusyAdd(-1) })
  }
  function makeCleanPlan(paths) {
    if (!paths || !paths.length) return
    panelBusyAdd(1); setError('')
    ffCleanPlan(paths).then(function (d) {
      panelBusyAdd(-1)
      if (!d || !d.batchId) { toast('没有生成批次：没有勾选任何有效候选'); return }
      hookPlan(d, { defaultChecked: false })
      setCleanPlan(d)
      toast('已生成清理计划（默认全不勾）：勾选后先预检，再确认执行（可撤销）')
    }).catch(function (e) { setError(e.message); panelBusyAdd(-1) })
  }
  function clearCleanPlan() { setCleanPlan(null) }
  function switchTab(id) {
    setActiveTab(id); setError('')
    if (id === 'dup') loadDup()
    else if (id === 'sim' && selected) loadSim(selected)
    else if (id === 'timeline') (selected ? loadTimeline(selected) : loadTimelineAll())
    else if (id === 'recognize' && selected) loadRecognize(selected)
    else if (id === 'clean') loadClean()
  }
  // 多标签条
  var tabbar = (fdTabs && fdTabs.length) ? h('div', { className: 'fd-tabbar' }, fdTabs.map(function (t) {
    return h('div', { key: t.path, className: 'fd-tab' + (path === t.path ? ' is-on' : ''),
      onClick: function () { go(t.path, { track: false }) }, title: t.path },
      h('span', { className: 'nm' }, t.name),
      h('button', { className: 'x', onClick: function (e) { e.stopPropagation(); closeTab(t.path) }, 'aria-label': '关闭标签' }, h(FF_UiIco, { k: 'cx', icon: 'close', size: 11 })))
  })) : null

  // ---- 计划执行链（既有资产，不重写）----
  function hookPlan(plan, opts) {
    if (!plan || !plan.batchId) return
    var bid = plan.batchId
    var checked = {}
    var def = !(opts && opts.defaultChecked === false)
    ;(plan.items || []).forEach(function (it) { checked[it.id] = def })
    setPlanProps(function (prev) {
      if (prev[bid]) return prev
      return Object.assign({}, prev, { [bid]: { checked: checked, dry: null, execResult: null, busy: false } })
    })
  }
  function onPlanToggle(bid, id) {
    var cur = planProps[bid] || { checked: {} }
    var checked = Object.assign({}, cur.checked)
    checked[id] = !checked[id]
    setPlan(bid, { checked: checked })
  }
  function onPlanDry(bid) {
    setPlan(bid, { busy: true })
    ffDryRun(bid).then(function (d) { setPlan(bid, { dry: d, busy: false }) })
      .catch(function (e) { setError(e.message); setPlan(bid, { busy: false }) })
  }
  function onPlanExec(bid, chosen) {
    var cur = planProps[bid] || {}
    var flags = {}
    var dryItems = (cur.dry && cur.dry.items) || []
    if (dryItems.some(function (d) { return d.crossVolume })) flags.confirmExdev = true
    var hasTrash = dryItems.some(function (d) { return d.requiresExplicitTrash })
    if (hasTrash) {
      if (!window.confirm('这一批包含「删除到回收站」操作。确认要执行吗？（可撤销，绝不硬删）')) return
      flags.confirmTrash = true
    }
    if (flags.confirmExdev) {
      if (!window.confirm('这一批包含跨卷移动。将采用「复制 → SHA-256 校验 → 源进回收站」的降级方案，确认执行？')) return
    }
    setPlan(bid, { busy: true })
    ffExecute(bid, chosen, flags).then(function (d) {
      setPlan(bid, { execResult: d, busy: false })
      go(path, { track: false })   // 执行后刷新目录，让结果可见
    }).catch(function (e) { setError(e.message); setPlan(bid, { busy: false }) })
  }
  function onPlanUndo(bid) {
    if (!window.confirm('确认撤销这一批的所有操作？会按反序恢复并逐字节校验。')) return
    setPlan(bid, { busy: true })
    ffUndo(bid).then(function (d) { setPlan(bid, { execResult: d, busy: false }); go(path, { track: false }) })
      .catch(function (e) { setError(e.message); setPlan(bid, { busy: false }) })
  }

  var chatPlanProps = {}
  Object.keys(planProps).forEach(function (bid) {
    var p = planProps[bid]
    chatPlanProps[bid] = {
      checked: p.checked, dry: p.dry, execResult: p.execResult, busy: p.busy,
      onToggle: function (id) { onPlanToggle(bid, id) },
      onDry: function () { onPlanDry(bid) },
      onExec: function (b, chosen) { onPlanExec(b, chosen) },
      onUndo: function () { onPlanUndo(bid) }
    }
  })

  // ---- 对话 ----
  // ---- 第 15 轮（m07306 ⑤）：预设整理方案（纯规则枚举，不调模型）----
  React.useEffect(function () {
    ffPresets().then(function (d) { setPresetList((d.presets && d.presets.length) ? d.presets : FF_PRESET_FALLBACK) }).catch(function () { setPresetList(FF_PRESET_FALLBACK) })
  }, [])
  function runPreset(id) {
    if (!path) { toast('先选一个目录'); return }
    setChatBusy(true)
    ffPresetPlan(id, path).then(function (r) {
      setChatBusy(false)
      if (!r.batchId) { toast(r.reply || '这个目录没有可套用的文件'); return }
      hookPlan(r, { defaultChecked: false })
      setLastChatPlan(r)
      toast('已套用「' + (r.reply || id) + '」· ' + (r.items || []).length + ' 项，勾选后请先预检')
    }).catch(function (e) { setChatBusy(false); setError(e.message) })
  }

  function sendChat() {
    var msg = String(chatInput || '').trim()
    if (!msg || chatBusy) return
    setChatBusy(true); setError(''); setChatInput('')
    var optimistic = { id: 'tmp-' + Date.now(), role: 'user', kind: 'text', content: msg, payload: null }
    setChatMsgs(function (prev) { return prev.concat([optimistic]) })
    ffChat(msg, path, selected ? [selected] : []).then(function (r) {
      if (r.batchId && r.payload && r.payload.plan) { hookPlan(r.payload.plan); setLastChatPlan(r.payload.plan) }
      ffChatHistory(100).then(function (d) { setChatMsgs(d.messages || []); setChatBusy(false) }).catch(function () { setChatBusy(false) })
    }).catch(function (e) { setError(e.message); setChatBusy(false) })
  }

  // ---- 文件表数据（过滤 → 排序）----
  var entries = listing ? listing.entries : []
  // entry.mtime 是 ISO 字符串（如 "2026-06-19T02:11:49.706Z"），不是毫秒数；
  // 直接 Number() 会得到 NaN，把它当成「很久以前」——所以统一走 fdTimeMs 归一。
  var weekAgo = Date.now() - 7 * 24 * 3600 * 1000
  var filtered = entries.filter(function (e) {
    if (query && e.name.toLowerCase().indexOf(query.toLowerCase()) < 0) return false
    if (tagFilter && !e.tags.some(function (t) { return t.name === tagFilter })) return false
    if (quick === 'recent' && !(fdTimeMs(e.mtime) >= weekAgo)) return false
    if (quick === 'large' && !(!e.isDir && Number(e.size) > 100 * 1024 * 1024)) return false
    if (quick === 'tagged' && !(e.tags || []).length) return false
    return true
  })
  var shown = sortEntries(filtered, sort)
  var shownPaths = shown.map(function (e) { return e.path })
  var groups = listing ? listing.groups : []
  var selMap = {}
  multi.selected.forEach(function (p) { selMap[p] = true })
  var cutting = {}
  if (clipboard.mode === 'cut') clipboard.paths.forEach(function (p) { cutting[p] = true })

  // 缩略图异步预取：列表和网格都取（用户默认在列表视图，只给网格出图等于看不见缩略图）。
  // 列表用 64px 小图（行高 30px，再大也没意义还费带宽），网格用 256px。
  // 一轮最多 60 张：后端有 2 并发 + 磁盘缓存限流，前端只负责别一次全压上去。
  React.useEffect(function () {
    var want = viewMode === 'grid' ? 256 : 64
    // 第 26 轮修：目录缩略图很贵（要 readdir + 找图片子项 + 拼图），列表视图里每个目录行只有 20px，
    // 为它扫一遍 Library/Applications 这种大目录会把 host 的缩略图队列占满，
    // 后续的 list 请求全排在后面 —— 实测表现为「双击进目录后转圈不出来」。
    // 所以列表只给文件出图，目录拼图只在网格视图（96px 以上，看得见）才取。
    var todo = shown.filter(function (e) {
      return want >= 96 ? (canThumb(e) || canDirThumb(e)) : canThumb(e)
    }).filter(function (e) { return !thumbs[e.path] }).slice(0, want >= 96 ? 60 : 40)
    if (!todo.length) return
    var alive = true
    todo.forEach(function (e) {
      ffThumb(e.path, want).then(function (t) {
        if (!alive || !t.ok) return
        setThumbs(function (prev) {
          // 同一条目在另一档宽度下已有图时，只在更高清时替换（避免列表小图覆盖网格大图）
          if (prev[e.path] && want < 256) return prev
          return Object.assign({}, prev, { [e.path]: t.dataUrl })
        })
      }).catch(function () {})
    })
    return function () { alive = false }
  }, [viewMode, listing, sort])

  var head = h(FF_Head, { columns: columns, sort: sort, onSort: function (k) { setSort(nextSort(sort, k)) } })
  var rows = [head]
  shown.forEach(function (e) {
    rows.push(h(FF_Row, { key: e.path, entry: e, columns: columns,
      selected: !!selMap[e.path], cutting: !!cutting[e.path],
      onPick: rowPick, onOpen: openEntry, onContext: rowContext, onKeyDown: rowKeyDown }))
  })
  if (loading) rows.push(h('div', { key: 'sk1', className: 'fd-skeleton', 'aria-hidden': 'true' }),
    h('div', { key: 'sk2', className: 'fd-skeleton', 'aria-hidden': 'true' }),
    h('div', { key: 'sk3', className: 'fd-skeleton', 'aria-hidden': 'true' }))
  if (!loading && listing && !shown.length) rows.push(h('div', { key: 'empty', className: 'fd-empty' },
    h('b', null, '这里没有匹配的文件'), h('span', null, query || tagFilter ? '换个关键词，或清除标签筛选试试' : '这个目录是空的，或隐藏项已被跳过')))

  // 第 20 轮：标签筛选已上移到侧栏 .tagsec（见 client-tahoe-ui.js 的 FF_TSidebar），
  // 中栏不再需要标签横带。

  // ---- 右栏属性 ----
  var kv = []
  function addKV(k, v) { kv.push(h('div', { key: k, className: 'fd-kv' }, h('span', null, k), h('span', null, v))) }
  if (meta) {
    addKV('名称', meta.name); addKV('类型', fdKind(meta)); addKV('大小', meta.isDir ? '—' : fdSize(meta.size))
    addKV('修改时间', fdTime(meta.mtime)); addKV('创建时间', fdTime(meta.birthtime)); addKV('位置', meta.path)
    addKV('下载来源', meta.whereFrom || '来源未知')
    addKV('索引状态', meta.indexed ? '已索引' : '未扫描')
  }

  // ---- 预览区（m07634：顺序 = 缩略图 → 智能识别 → 变更时间线 → 属性与标签）----
  // 用户原话：「智能识别应该放置在预览的最上方，在缩略图下方」。
  // 改前右栏只有「属性与标签 → 智能识别 → 时间线」，而且根本没有缩略图 —— 所谓预览其实只有键值对。
  var previewExtra = null
  if (selected) {
    var selEntry = (shown || []).filter(function (x) { return x.path === selected })[0] ||
      (listing && (listing.entries || []).filter(function (x) { return x.path === selected })[0]) || null
    var recCard = rec && rec.card ? rec.card : null
    var tlEvents = tl && tl.events ? tl.events : []
    var thumbSrc = previewThumb && previewThumb.path === selected ? previewThumb.dataUrl : null
    var thumbNode = h('div', { className: 'fd-prev-thumb' },
      thumbSrc
        ? h('img', { className: 'fd-prev-img', src: thumbSrc, alt: fdBase(selected) })
        : h('div', { className: 'fd-prev-thumb-ph' },
            h(FF_FileIcon, { entry: selEntry || { path: selected, name: fdBase(selected) }, size: 44 }),
            h('span', null, selEntry && canThumb(selEntry) ? '缩略图生成中…' : '此类文件没有缩略图')))
    var recNode = h('div', { className: 'fd-prev-sec' },
      h('h4', { className: 'fd-preview-h' }, '智能识别'),
      recCard
        ? h('div', { className: 'fd-card' },
            h('div', { className: 'fd-prev-line' }, h('b', null, recCard.what || '未知')),
            h('div', { className: 'fd-kv' }, h('span', null, '从哪来'), h('span', null, recCard.sourceUnknown ? '来源未知' : (recCard.from || '—'))),
            h('div', { className: 'fd-kv' }, h('span', null, '怎么用'), h('span', null, recCard.usage === 'unknown' ? '证据不足' : (recCard.usage || '—'))),
            h('div', { className: 'fd-kv' }, h('span', null, '可清理'), h('span', null, recCard.cleanable === 'unknown' ? '不确定' : (recCard.cleanable || '—'))))
        : h('div', { className: 'fd-msg fd-prev-empty' }, panelBusy ? '正在识别…' : '选中文件后自动识别来源与用法'))
    var tlNode = h('div', { className: 'fd-prev-sec' },
      h('h4', { className: 'fd-preview-h' }, '变更时间线'),
      tlEvents.length
        ? h('div', { className: 'fd-prev-tl' }, tlEvents.slice(0, 12).map(function (e, i) {
            return h('div', { key: i, className: 'fd-prev-tl-row' },
              h('span', { className: 'fd-prev-tl-time' }, fdTime(e.at)),
              h('span', { className: 'fd-prev-tl-kind' }, e.kind))
          }))
        : h('div', { className: 'fd-msg fd-prev-empty' }, panelBusy ? '正在读取…' : '暂无变更事件'))
    previewExtra = h('div', { className: 'fd-preview-more' }, thumbNode, recNode, tlNode)
  }

  var right = h('aside', { className: 'fd-aside' },
    h('h4', null, '属性与标签'),
    meta ? kv : h('div', { className: 'fd-msg', style: { padding: 0 } }, '点一个文件看属性'),
    meta ? h('div', { className: 'fd-tags', style: { marginTop: 10 } }, meta.tags.map(function (t) { return h(FF_Tag, { key: t.name, name: t.name, color: t.color }) })) : null,
    // 第 17 轮（m07721 ①）：识别派生标签用虚线 chip，与用户手打的实线标签区分开。
    meta && (meta.autoTags || []).length ? h('div', { className: 'fd-tags fd-auto-tags', style: { marginTop: 8 } },
      meta.autoTags.map(function (t) { return h('span', { key: 'auto-' + t, className: 'fd-chip cool', title: '智能识别派生' }, t) })) : null,
    meta && (meta.userTags || []).length ? h('div', { className: 'fd-tags', style: { marginTop: 6 } }, meta.userTags.map(function (t) { return h('span', { key: t, className: 'fd-chip cool' }, t) })) : null,
    meta && meta.finderTags && meta.finderTags.length ? h('div', null, h('h4', { style: { marginTop: 14 } }, 'Finder 标签'), h('div', { className: 'fd-tags' }, meta.finderTags.map(function (t) { return h('span', { key: t, className: 'fd-chip neutral' }, t) }))) : null,
    meta ? h('div', { className: 'fd-actions' },
      h('button', { className: 'fd-btn', onClick: function () { ffOpen(meta.path, false).catch(function (e) { setError(e.message) }) } }, '打开'),
      h('button', { className: 'fd-btn', onClick: function () { ffOpen(meta.path, true).catch(function (e) { setError(e.message) }) } }, '在 Finder 显示'),
      h('button', { className: 'fd-btn', onClick: openTagEditor }, '编辑标签')
    ) : null,
    tagEditor ? h(FF_TagEditor, {
      current: tagEditor.current, allTags: allTags, newName: tagEditor.newName,
      onNewName: function (v) { setTagEditor(Object.assign({}, tagEditor, { newName: v })) },
      onToggle: function (name, on) { setTagEditor(Object.assign({}, tagEditor, { current: tagAssign(tagEditor.current, name, on) })) },
      onAdd: function () { var v = String(tagEditor.newName || '').trim(); if (!v) return; setTagEditor(Object.assign({}, tagEditor, { current: tagAssign(tagEditor.current, v, true), newName: '' })) },
      onApply: applyTags
    }) : null,
    h('div', { className: 'fd-note' }, '标签来自扩展名规则引擎；「智能识别」tab 才调用宿主模型判断来源与用法。删除/移动只在计划卡片逐项勾选并二次确认后执行，且删除一律进回收站。')
  )
  // ---- 能力面板主体 ----
  var panel = null
  if (activeTab === 'manage') panel = previewExtra // 甲方案：管理即文件表本体，无重复面板
  else if (activeTab === 'dup') panel = h(FF_DupPanel, { data: dup, error: null, loading: panelBusy, onRescan: loadDup, onPlan: function (g) {
    var others = (g.items || []).filter(function (it) { return !g.keepSuggestion || it.path !== g.keepSuggestion.keep }).map(function (it) { return fdBase(it.path) })
    var msg = '把重复组里除建议保留外的 ' + others.length + ' 份移到回收站：' + others.slice(0, 6).join('、')
    setChatInput(msg); setChatOpen(true); setActiveTab('manage')
  } })
  else if (activeTab === 'sim') panel = h(FF_SimPanel, { data: sim, error: null, loading: panelBusy, target: (sim && sim.target) ? sim.target : selected })
  else if (activeTab === 'timeline') panel = h(FF_TimelinePanel, { data: tl, error: null, loading: panelBusy, target: selected, onAll: loadTimelineAll })
  else if (activeTab === 'recognize') panel = h(FF_RecognizePanel, { data: rec, error: null, loading: panelBusy, target: selected })
  else if (activeTab === 'settings') panel = h(FF_SettingsPanel, {
    offline: !settings,
    settings: settingsDraft, busy: panelBusy, uplink: uplink,
    onChange: function (next) { setSettingsDraft(next) },
    onSave: saveSettingsUi, onReload: loadSettingsUi })
  else if (activeTab === 'clean') panel = h(FF_CleanPanel, { data: clean, error: null, loading: panelBusy,
    cleanPlan: cleanPlan, planProps: (cleanPlan && chatPlanProps[cleanPlan.batchId]) || {},
    onRescan: loadClean, onPlan: makeCleanPlan, onClearPlan: clearCleanPlan })

  var partition = partitionVolumes(volumes)
  var isFav = favorites.some(function (f) { return f.path === path })
  var status = statusFor({ loading: loading, error: error, offline: offline,
    partial: listing && listing.truncated, readOnly: false, listing: listing,
    shownCount: shown.length, selectedCount: multi.selected.length, totalCount: listing ? listing.count : 0 })

  // ===== 第 20 轮（m09643）：按 docs/flowfile-design-tahoe.html 结构重排 =====
  // 旧 v4 骨架（顶栏 + 能力 tab 条 + 三栏 + 右栏对话）整体替换为
  // 玻璃侧栏 / 协调栏 / 工作区标签条 / 文件空间卡 + 灵动底坞 / 检查器 / AI 抽屉。
  // 状态与回调全部沿用既有实现，只换 DOM 树与类名，能力面板仍走原 FF_*Panel。
  var volName = '本机'
  ;(volumes || []).some(function (v) { if (path && (path === v.path || path.indexOf(v.path + '/') === 0)) { volName = v.name || v.path; return true } return false })
  var hereName = fdBase(path) || volName
  // SMB 判定走卷表（volumeType 是 host 侧 modules/volumes.js 的函数，client bundle 里没有）
  var isSmb = false
  ;(volumes || []).some(function (v) {
    if (path && (path === v.path || path.indexOf(v.path + '/') === 0)) { isSmb = String(v.type || '').toLowerCase().indexOf('smb') >= 0; return true }
    return false
  })

  var trail = crumbTrail(path, volumes).map(function (t) { return { name: t.label, path: t.path } })
  if (!trail.length) trail = [{ name: '未选择位置', path: path }]

  // 第 25 轮：卷容量。host 新版已把 free/total/usedPct 直接放进卷对象；
  // 若宿主仍是旧代码（字段缺失），这里用既有 capacity 接口逐卷补一次——
  // 无论如何都不再让容量条用 (18 + i*22)% 这种按索引捏的数字。拿不到就整条不画。
  var volCapState = React.useState({}), volCaps = volCapState[0], setVolCaps = volCapState[1]
  React.useEffect(function () {
    var need = (volumes || []).filter(function (v) { return v && v.usedPct === undefined && v.path })
    if (!need.length) return
    var alive = true
    Promise.all(need.map(function (v) {
      return ffCapacity(v.path).then(function (c) { return { path: v.path, c: c } }).catch(function () { return { path: v.path, c: null } })
    })).then(function (rows) {
      if (!alive) return
      var m = {}
      rows.forEach(function (r) { if (r.c && r.c.ok) m[r.path] = r.c })
      setVolCaps(m)
    })
    return function () { alive = false }
  }, [volumes])

  var loadedState = React.useState(''), lastLoadedAt = loadedState[0], setLastLoadedAt = loadedState[1]
  React.useEffect(function () {
    if (!listing) return
    var d = new Date()
    setLastLoadedAt(new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(d))
  }, [listing])

  var entryCount = listing ? (listing.count || 0) : 0
  var weekAgoCount = Date.now() - 7 * 24 * 3600 * 1000
  var counts = {
    recent: (entries || []).filter(function (e) { return fdTimeMs(e.mtime) >= weekAgoCount }).length,
    large: (entries || []).filter(function (e) { return !e.isDir && e.size > 100 * 1024 * 1024 }).length,
    tagged: (entries || []).filter(function (e) { return (e.tags || []).length }).length
  }

  var selEntry = null
  if (selected) {
    selEntry = (entries || []).filter(function (x) { return x.path === selected })[0] || { path: selected, name: fdBase(selected), isDir: false }
  }

  var toolTitle = '文件管理', toolNote = ''
  ;(FF_TABS || []).forEach(function (t) { if (t.id === activeTab) toolTitle = t.label })
  if (activeTab === 'dup') toolNote = dup ? ('共 ' + ((dup.groups || []).length) + ' 组重复 · 可回收 ' + fdSize(dup.reclaimable || 0)) : '正在扫描重复文件…'
  else if (activeTab === 'sim') toolNote = '以「' + fdBase((sim && sim.target) ? (sim.target.path || sim.target) : (selected || '')) + '」为基准，按内容相似度排序'
  else if (activeTab === 'timeline') toolNote = '按时间倒序列出该文件的创建 / 修改 / 同步事件'

  var fileRows = shown.map(function (e) {
    return h(FF_TRow, { key: e.path, entry: e, selected: !!selMap[e.path], thumb: thumbs[e.path] || '',
      onPick: rowPick, onOpen: openEntry, onContext: rowContext, onKey: rowKeyDown })
  })
  if (loading) fileRows = [h('div', { key: 'sk1', className: 'skeleton' }), h('div', { key: 'sk2', className: 'skeleton' }), h('div', { key: 'sk3', className: 'skeleton' })]
  if (!loading && listing && !shown.length) {
    var anyFilter = !!(query || tagFilter || quick)
    fileRows = [h('div', { key: 'empty', className: 'empty' },
      h('b', null, anyFilter ? '这里没有匹配的文件' : '这个目录是空的'),
      h('span', null, anyFilter ? '换个关键词，或清除筛选试试' : '隐藏项（. 开头）不会列出'),
      anyFilter ? h('button', {
        className: 'ipill', style: { marginTop: '8px' },
        onClick: function () { setQuery(''); setTagFilter(''); setQuick('') }
      }, '清除全部筛选') : null)]
  }

  var gridTiles = shown.map(function (e) {
    return h('div', { key: e.path, className: 'tile' + (selMap[e.path] ? ' on' : ''), role: 'gridcell',
      tabIndex: 0, 'aria-selected': !!selMap[e.path], title: e.path,
      onClick: function (ev) { rowPick(e, ev) }, onDoubleClick: function (ev) { openEntry(e, ev) },
      onContextMenu: function (ev) { rowContext(e, ev) } },
      h('div', { className: 'th' }, thumbs[e.path]
        ? h('img', { src: thumbs[e.path], alt: e.name })
        : h(FF_Fico, { entry: e, size: 34 })),
      h('div', { className: 'nm' }, e.name))
  })

  var panelBody = activeTab === 'manage' ? null : h('div', { className: 'toolview on' },
    h('div', { className: 'tvhead' },
      h('span', { className: 'role' }, '工作台'),
      h('b', null, toolTitle),
      h('button', { className: 'back', onClick: function () { switchTab('manage') } }, '← 返回文件浏览')),
    h('div', { className: 'tvbody' }, toolNote ? h('div', { className: 'tvnote' }, toolNote) : null, panel))

  var allVols = volumes
  var treeNode = folds.tree ? h(FF_Tree, { path: path, volumes: allVols, onGo: go, listDir: listDirForTree,
    onFold: function () { fdToggleFold('tree') } }) : null

  var toastNode = toast ? h(FF_Toast, { text: toast.text, tone: toast.tone }) : null

  return h('div', { className: 'fd-root' + (drawerOpen ? ' ai-open' : ''), ref: rootRef, tabIndex: 0,
    'data-density': density, onClick: function () { setContext(null); setColPanel(null) } },
    h('style', null, FD_CSS),
    h('style', null, FD_TAHOE),
    h('style', null, fdGridCSS(columns)),
    h('div', { className: 'desk' },
      h('div', { className: 'desk-inner' },
        h(FF_TSidebar, {
          volumes: allVols, path: path, onGo: go, groups: groups, tagFilter: tagFilter,
          onTag: function (t) { setTagFilter(t) }, counts: counts, tree: treeNode,
          quick: quick, onQuick: function (k) { setQuick(k || '') }, volCaps: volCaps,
          activeTool: activeTab === 'manage' ? '' : activeTab, onTool: function (id) { switchTab(id) },
          dupBadge: dup ? ((dup.groups || []).length + ' 组') : '—',
          cleanBadge: clean ? fdSize((clean.candidates || []).reduce(function (s, c) { return s + (c.size || 0) }, 0)) : '—'
        }),
        h('div', { className: 'main' },
          h(FF_TCoord, {
            trail: trail, onGo: go, canBack: !!canBack(hist), canForward: !!canForward(hist),
            onBack: navBack, onForward: navForward, query: query, onQuery: setQuery,
            onDensity: function () { setDensity(fdSaveDensity(fdStore(), fdNextDensity(density))) },
            inspOpen: inspOpen,
            onInsp: function () { toggleInsp() },
            onAi: function () { setDrawerOpen(!drawerOpen) }
          }),
          h(FF_TTabstrip, { tabs: fdTabs || [], path: path, onGo: function (p) { go(p, { track: false }) },
            onClose: closeTab, onAdd: function () { openTab(path) } }),
          h('div', { className: 'stage' },
            h('section', { className: 'pane focused', 'data-dock': !selEntry ? 'idle' : (dockOpen ? 'expanded' : 'selected') },
              h(FF_THero, { title: hereName, countText: (entryCount || shown.length) + ' 个项目' + (capacity && capacity.free ? ' · ' + fdSize(capacity.free) + ' 可用' : ''),
                where: isSmb ? 'SMB 网络卷' : '本机磁盘', query: query, onQuery: setQuery,
                viewMode: viewMode, onView: function (m) { setViewMode(saveViewMode(fdStore(), m)) } }),
              activeTab === 'manage'
                ? (viewMode === 'grid'
                    ? h('div', { className: 'gridview' }, gridTiles)
                    : viewMode === 'columns'
                      ? h(FF_TColView, {
                          path: path, onPick: function (e) { showMeta(e) }, onOpen: openEntry,
                          onGo: function (p) { go(p) }
                        })
                      : (function () {
                    // 第 25 轮：没有用户标签 / 没有跨卷来源时，那两列整列收掉（不再用 0 宽占位撑出空白）。
                    var flags = {
                      hasTags: shown.some(function (e) { return (e.userTags || []).length }),
                      hasSrc: shown.some(function (e) { return String(e.path || '').indexOf('/Volumes/') === 0 })
                    }
                    var rc = 'rows' + (flags.hasTags ? '' : ' no-tags') + (flags.hasSrc ? '' : ' no-src')
                    return [h(FF_THead, { key: 'hd', sort: sort, flags: flags, onSort: function (k) { setSort(nextSort(sort, k)) } }),
                      h('div', { key: 'rows', className: rc, onContextMenu: blankContext }, fileRows)]
                  })())
                : null,
              h(FF_TDock, {
                selected: selEntry, dockOpen: dockOpen, onDockToggle: setDockOpen,
                countText: (entryCount || shown.length) + ' 个项目' + (capacity && capacity.free ? ' · ' + fdSize(capacity.free) + ' 可用' : ''),
                // 第 25 轮：原本文案写死 "...· 已同步"——这个插件根本没有同步功能，
                // 底坞却对每个目录都宣称已同步。改成目录自身可核实的事实（刷新时间）。
                subText: hereName + ' · ' + (isSmb ? 'SMB 挂载卷' : '本机磁盘') + (lastLoadedAt ? ' · 读取于 ' + lastLoadedAt : ''),
                onOpen: function (e) { openEntry(e) }, onSim: function (e) { setSelected(e.path); switchTab('sim') },
                onTool: function (id) { switchTab(id) }, onOrganize: function () { setDrawerOpen(true) },
                onAi: function () { setDrawerOpen(true) }, meta: meta,
                // 第 26 轮：底坞的缩略图。优先用列表/网格已预取的那张（零额外请求），
                // 没有就按当前选中项补拉一次 96px（行高 34px，2 倍图足够清晰又不费带宽）。
                thumb: (selEntry && thumbs[selEntry.path]) || (previewThumb && previewThumb.path === selected ? previewThumb.dataUrl : null),
                onThumb: function (p, w) {
                  // 缺图时只补一次。ref 回调在每次渲染都会重跑，所以必须用「已试过」的集合去重：
                  // 只判断 thumbs[p] 不够——取不到图（没有预览能力的目录/文件）时 thumbs 永远是空的，
                  // 于是每次渲染都再发一次请求，形成请求洪水，界面直接被拖死。
                  if (!p) return
                  if (thumbs[p] || triedRef.current[p]) return
                  triedRef.current[p] = true
                  ffThumb(p, w).then(function (t) {
                    if (!t || !t.ok) return
                    setThumbs(function (prev) { return prev[p] ? prev : Object.assign({}, prev, { [p]: t.dataUrl }) })
                  }).catch(function () {})
                } }),
              panelBody),
            inspOpen ? h(FF_TInspector, {
              selected: selEntry, meta: meta, rec: rec, tl: tl, sim: sim, panelBusy: panelBusy,
              onTool: function (id) { switchTab(id) },
              onHide: function () { toggleInsp(false) },
              onCopyPath: copyPath,
              onGoPath: function (p) { go(dirOf(p)) }
            }) : null),
          h(FF_TDrawer, {
            path: path, drawerTab: drawerTab, onDrawerTab: setDrawerTab, onAi: setDrawerOpen,
            messages: chatMsgs, input: chatInput, onInput: setChatInput, onSend: sendChat, busy: chatBusy,
            presets: presetList, onPreset: runPreset, planProps: chatPlanProps,
            tasks: batches, models: models, modelKey: (models && models.currentKey) || 'auto',
            modelOpts: [
              h('option', { key: 'auto', value: 'auto' }, (models && models.autoLabel) || '跟随宿主默认')
            ].concat(((models && models.routes) || []).map(function (r) {
              return r.available
                ? h('optgroup', { key: r.provider, label: r.provider }, (r.models || []).map(function (m) {
                    return h('option', { key: r.provider + '/' + m, value: r.provider + '/' + m }, m)
                  }))
                : h('option', { key: r.provider + '/off', value: r.provider + '/off', disabled: true }, r.provider + ' · 不可用')
            })),
            onModel: chooseModel,
            onUndo: function (id) {
              ffUndo(id).then(function () { loadBatches(); go(path, { track: false }); toast('已撤销该批次') })
                .catch(function (e) { toast('撤销失败：' + e.message, 'error') })
            },
            modelLabel: 'AI 只出计划，勾选并确认后才执行'
          })),
        null),
      null),
    context ? h(FF_ContextMenu, { x: context.x, y: context.y,
      items: menuFor({ isBlank: context.isBlank, target: context.target, selectedCount: multi.selected.length,
        clipCount: clipboard.paths.length, readOnly: false }), onAction: onMenuAction }) : null,
    colPanel ? h(FF_ColPanel, { columns: columns,
      onToggle: function (k) { setColumns(saveColumns(fdStore(), toggleColumn(columns, k))) },
      onWidth: function (k, w) { setColumns(saveColumns(fdStore(), setColumnWidth(columns, k, w))) },
      onReset: function () { setColumns(saveColumns(fdStore(), defaultColumns())) } }) : null,
    conflict ? h(FF_ConflictDialog, { conflicts: conflict.conflicts,
      onChoose: function (c) { doPaste(c) }, onCancel: function () { setConflict(null) } }) : null,
    inputDialog ? h(FF_InputDialog, { title: inputDialog.title, value: inputDialog.value, error: inputDialog.error,
      onChange: function (v) { setInputDialog(Object.assign({}, inputDialog, { value: v, error: '' })) },
      onSubmit: submitInput, onCancel: function () { setInputDialog(null) } }) : null,
    quicklook ? h(FF_QuickLook, { entry: quicklook, thumb: thumbs[quicklook.path],
      onClose: function () { setQuicklook(null) } }) : null,
    toastNode
  )
}

var FD_INJECT = ['slots']

function fdApply(ctx) {
  ctx.slots.inject('main', function () { return ctx.slots.register({ name: 'main', key: FD_ID }, FD_App) })
  ctx.effect(function () {
    var dispose = null
    var register = function () {
      if (dispose) dispose()
      dispose = ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({ name: 'sidebar.panellist', id: FD_ID, order: 6, label: function () { return 'FlowFile' } }, FF_Icon)
      })
    }
    register()
    return function () { if (dispose) dispose() }
  }, 'FlowFile: sidebar entry')
}


var __ff={apply:fdApply,inject:FD_INJECT};
module.exports=Object.assign(Object.defineProperty({},"__esModule",{value:true}),__ff);
return module.exports}});