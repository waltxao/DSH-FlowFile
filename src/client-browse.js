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
