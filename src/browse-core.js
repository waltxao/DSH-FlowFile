// FlowFile 第2轮 ② P0 浏览管理：纯逻辑层。
// 本文件是 ESM（供 node --test 导入），build.mjs 会把 "export " 前缀剥掉后拼进 client bundle。
// 约束：不依赖 DOM / React / fs；所有函数输入输出可序列化；写操作只产出「结构化计划」，绝不直接改文件。
// 安全边界（规格 §2.4）：所有破坏性动作都经本层转成 plan → 宿主建批次 → dry-run → 人确认 → 执行 → 可撤销。

// ---- 导航历史栈（≤50） ----
export const FF_HISTORY_MAX = 50

export function createHistory(initial) {
  return { stack: initial ? [initial] : [], index: initial ? 0 : -1 }
}

export function historyPush(hist, path) {
  const h = hist || createHistory()
  if (!path) return h
  const cur = h.index >= 0 ? h.stack[h.index] : null
  if (cur === path) return h                       // 刷新/重复进入不产生历史
  let stack = h.stack.slice(0, h.index + 1)       // 丢弃「前进」分支
  stack.push(path)
  if (stack.length > FF_HISTORY_MAX) stack = stack.slice(stack.length - FF_HISTORY_MAX)
  return { stack, index: stack.length - 1 }
}

export function canBack(hist) { return !!hist && hist.index > 0 }
export function canForward(hist) { return !!hist && hist.index >= 0 && hist.index < hist.stack.length - 1 }

export function historyBack(hist) {
  if (!canBack(hist)) return null
  const index = hist.index - 1
  return { hist: { stack: hist.stack, index }, path: hist.stack[index] }
}

export function historyForward(hist) {
  if (!canForward(hist)) return null
  const index = hist.index + 1
  return { hist: { stack: hist.stack, index }, path: hist.stack[index] }
}

// ---- 地址栏 ----
export function isSafeAddress(text) {
  const s = String(text || '').trim()
  if (!s || s.charAt(0) !== '/') return false
  const parts = s.split('/')
  for (const p of parts) if (p === '..' || p === '~') return false
  return true
}

export function normalizeAddress(text) {
  let s = String(text || '').trim().replace(/\\/g, '/')
  if (!s) return ''
  if (s.charAt(0) !== '/') s = '/' + s
  s = s.replace(/\/+/g, '/').replace(/\/+$/,'')
  return s || '/'
}

// ---- 面包屑（修 onGo('/') 被白名单静默拦下的缺陷）----
export function nameOf(p) { return String(p || '').split('/').filter(Boolean).pop() || '/' }
export function dirOf(p) { const i = String(p || '').lastIndexOf('/'); return i <= 0 ? '/' : String(p).slice(0, i) }
export function joinPath(dir, name) {
  const d = String(dir || '/').replace(/\/+$/, '') || '/'
  return (d === '/' ? '' : d) + '/' + String(name || '').replace(/^\/+/, '')
}

export function volumeRootFor(path, volumes) {
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

export function crumbTrail(path, volumes) {
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
export const FF_SEL_CLEAR = { selected: [], anchor: null }

/** action: {type:'click'|'cmd'|'shift'|'selectAll'|'deselectAll'|'escape', path?, order?:string[]} */
export function reduceSelection(state, action) {
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
export const FF_SORT_KEYS = ['name', 'size', 'mtime', 'tags']

export function nextSort(cur, key) {
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

export function sortEntries(entries, sort) {
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

export const FF_COL_KEY = 'flowfile.columns.v1'
export function defaultColumns() {
  return [
    { key: 'name', label: '名称', visible: true, width: null },
    { key: 'size', label: '大小', visible: true, width: 96 },
    { key: 'mtime', label: '修改时间', visible: true, width: 152 },
    { key: 'tags', label: '标签', visible: true, width: 168 }
  ]
}
export function loadColumns(storage, fallback) {
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
export function saveColumns(storage, cols) {
  try { storage && storage.setItem(FF_COL_KEY, JSON.stringify((cols || []).map(c => ({ key: c.key, visible: c.visible, width: c.width })))) } catch (e) {}
  return cols
}
export function toggleColumn(cols, key) {
  if (key === 'name') return cols            // 名称列不允许隐藏
  return cols.map(c => c.key === key ? Object.assign({}, c, { visible: !c.visible }) : c)
}
export function setColumnWidth(cols, key, w) {
  const width = (w === null || w === 'auto') ? null : Math.max(60, Math.min(600, Number(w) || 0))
  return cols.map(c => c.key === key ? Object.assign({}, c, { width }) : c)
}
export function columnGrid(cols) {
  return (cols || []).filter(c => c.visible).map(c => c.width == null ? 'minmax(0,1fr)' : (c.width + 'px')).join(' ')
}

// 第 24 轮（m11235 诉求 5）：视图从二态扩成三态 list | grid | columns（Finder 式级联分栏）。
// 旧键 flowfile.view.v1 里只可能存 'grid' / 'list'，读到时按同一套白名单收敛，不会因新值报错。
export const FF_VIEW_KEY = 'flowfile.view.v1'
export const FF_VIEW_MODES = ['list', 'grid', 'columns']
export function loadViewMode(storage) {
  try {
    const v = storage && storage.getItem(FF_VIEW_KEY)
    return FF_VIEW_MODES.indexOf(v) >= 0 ? v : 'list'
  } catch (e) { return 'list' }
}
export function saveViewMode(storage, mode) {
  const v = FF_VIEW_MODES.indexOf(mode) >= 0 ? mode : 'list'
  try { storage && storage.setItem(FF_VIEW_KEY, v) } catch (e) {}
  return v
}
export function nextViewMode(mode) {
  const i = FF_VIEW_MODES.indexOf(mode)
  return FF_VIEW_MODES[(i < 0 ? 0 : i + 1) % FF_VIEW_MODES.length]
}

// ---- 检查器手动隐藏（诉求 3）：与「窗口太窄自动让位」是两码事，手动态要能压过断点 ----
export const FF_INSP_KEY = 'flowfile.insp.v1'
export function loadInspOpen(storage) {
  try {
    const v = storage && storage.getItem(FF_INSP_KEY)
    return v === 'closed' ? false : true
  } catch (e) { return true }
}
export function saveInspOpen(storage, open) {
  try { storage && storage.setItem(FF_INSP_KEY, open ? 'open' : 'closed') } catch (e) {}
  return !!open
}

// ---- 收藏（localStorage）----
export const FF_FAV_KEY = 'flowfile.favorites.v1'
export function loadFavorites(storage) {
  try {
    const raw = storage && storage.getItem(FF_FAV_KEY)
    const a = raw ? JSON.parse(raw) : []
    return Array.isArray(a) ? a.filter(x => x && x.path).slice(0, 24) : []
  } catch (e) { return [] }
}
export function toggleFavorite(storage, list, item) {
  const cur = Array.isArray(list) ? list : []
  const i = cur.findIndex(x => x && x.path === (item && item.path))
  const out = i >= 0 ? cur.filter((_, j) => j !== i) : cur.concat([{ path: item.path, name: item.name || nameOf(item.path) }]).slice(-24)
  try { storage && storage.setItem(FF_FAV_KEY, JSON.stringify(out)) } catch (e) {}
  return out
}

// ---- 状态栏 / 六态 ----
export const FF_STATE_HINTS = {
  loading: { label: '加载中', hint: '正在读取目录，稍候…', tone: 'info' },
  error: { label: '出错', hint: '点「刷新」重试，或回到上级目录。', tone: 'error' },
  offline: { label: '卷不可用', hint: 'SMB 卷可能已断连，重新挂载后点「刷新」。', tone: 'warning' },
  partial: { label: '部分失败', hint: '目录项已截断，缩小范围或扫描后查看。', tone: 'warning' },
  readonly: { label: '只读', hint: '当前目录不可写，整理动作不会执行。', tone: 'warning' },
  empty: { label: '空', hint: '这个目录是空的，或隐藏项已被跳过。', tone: 'info' },
  ready: { label: '就绪', hint: '', tone: 'ok' }
}

export function stateOf(ctx) {
  const c = ctx || {}
  if (c.loading) return 'loading'
  if (c.error) return 'error'
  if (c.offline) return 'offline'
  if (c.partial) return 'partial'
  if (c.readOnly) return 'readonly'
  if (!c.listing || !c.shownCount) return 'empty'
  return 'ready'
}

export function statusFor(ctx) {
  const c = ctx || {}
  const st = stateOf(c)
  const meta = FF_STATE_HINTS[st]
  const text = (c.shownCount || 0) + ' 项' + (c.selectedCount ? ' · 已选 ' + c.selectedCount : '') + (c.totalCount && c.totalCount !== c.shownCount ? ' / 共 ' + c.totalCount : '')
  return { text, state: st, label: meta.label, hint: c.hint || meta.hint, tone: meta.tone }
}

// ---- 快捷键模型 ----
export function matchHotkey(e) {
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
export function menuFor(ctx) {
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
export const FF_TAG_COLORS = [
  { id: 'gray', name: '灰', hex: '#8E8E93' },
  { id: 'red', name: '红', hex: '#FF453A' },
  { id: 'orange', name: '橙', hex: '#FF9F0A' },
  { id: 'yellow', name: '黄', hex: '#FFD60A' },
  { id: 'green', name: '绿', hex: '#30D158' },
  { id: 'blue', name: '蓝', hex: '#0A84FF' },
  { id: 'purple', name: '紫', hex: '#BF5AF2' }
]
export function isTagColor(hex) { return FF_TAG_COLORS.some(c => c.hex === hex || c.id === hex) }
export function tagAssign(current, name, on) {
  const cur = Array.isArray(current) ? current.slice() : []
  const i = cur.indexOf(name)
  if (on && i < 0) cur.push(name)
  if (!on && i >= 0) cur.splice(i, 1)
  return cur
}

// ---- 冲突三选 ----
export function uniqueDst(dst, taken) {
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
export function resolveConflicts(items, existingPaths, choice) {
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

export function conflictsFor(clipboard, dir, entries) {
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
export function buildMenuPlan(action, ctx) {
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
export const FF_THUMB_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.tiff', '.tif', '.heic', '.heif', '.svg']
// 明确不试的后缀（会拖慢 UI 且几乎没有可用预览）
export const FF_THUMB_SKIP_EXT = ['.iso', '.dmg', '.img', '.vmdk', '.pkg', '.mpkg', '.toast', '.sparsebundle', '.part', '.tmp']
export function canThumb(entry) {
  if (!entry || entry.isDir) return false
  const ext = String(entry.ext || nameOf(entry.path).replace(/^.*\./, '.') || '').toLowerCase()
  return FF_THUMB_SKIP_EXT.indexOf(ext) < 0
}
// 目录缩略图（2×2 图片子项拼图）：与文件缩略图分开判据——
// 目录可能一张图都没有，出不来就回落文件夹图标，属于正常情况不是缺陷。
// 深度 0 就取的顶层层级也放开：只要有 >0 个子项就值得试一次（超过 3 个才拼）。
export function canDirThumb(entry) {
  if (!entry || !entry.isDir) return false
  // 已知的重目录类型（.app 包 / 版本库 / 缓存）不值得递归探测
  const name = String(entry.name || nameOf(entry.path) || '')
  if (/\.(app|bundle|framework|photoslibrary|lrdata|sparsebundle)$/i.test(name)) return false
  return true
}
export function isRasterImage(entry) {
  if (!entry || entry.isDir) return false
  const ext = String(entry.ext || nameOf(entry.path).replace(/^.*\./, '.') || '').toLowerCase()
  return FF_THUMB_EXT.indexOf(ext) >= 0
}
export function partitionVolumes(volumes) {
  const local = [], smb = []
  for (const v of volumes || []) (v && v.isSmb ? smb : local).push(v)
  return { local, smb }
}

// ---- 第 15 轮（m07306 ①）：低分辨率自适应 ----
// 真机实测的病灶：1920 下中栏 1078px 很好，但 1024x768 下 root 只有 744px，
// 左树 210 + 右栏 340 固定吃掉 550，中栏只剩 182px —— 文件表被挤成一条缝，
// 这就是「低分辨率下没法看」。所以尺寸必须按可用宽度收敛，而不是只让用户手拖。
// 参数是「可用宽度」（.fd-root 的 clientWidth），不是视口宽度：宿主左侧导航会吃掉 280px。
export const FF_LAYOUT_BREAKS = { wide: 1360, mid: 1080, narrow: 860, tiny: 700, rightHide: 1080 }

function clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

/** 把用户设的布局按当前可用宽高收敛。返回 {treeW, rightW, dockH, rightHidden, compact}。 */
export function fitLayout(layout, availW, availH) {
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
export const FF_FOLD_KEY = 'flowfile.fold.v1'
export function loadUiFold(storage) {
  const def = { tree: true, right: true }
  try {
    const raw = storage && storage.getItem(FF_FOLD_KEY)
    if (!raw) return def
    const o = JSON.parse(raw)
    return { tree: o.tree !== false, right: o.right !== false }
  } catch (e) { return def }
}
export function saveUiFold(storage, fold) {
  const v = { tree: !(fold && fold.tree === false), right: !(fold && fold.right === false) }
  try { if (storage && storage.setItem) storage.setItem(FF_FOLD_KEY, JSON.stringify(v)) } catch (e) { /* 隐私模式忽略 */ }
  return v
}
