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
      // 不写具体版本号：写死的 'v1.0' 会在发版后变成假话。
      // 但「测试版」是稳定语义——只要还是预发布阶段，这句话就一直成立。
      h('span', { className: 'sb-tag sb-tag-beta' }, '测试版')),
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
