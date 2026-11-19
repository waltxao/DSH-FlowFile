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
