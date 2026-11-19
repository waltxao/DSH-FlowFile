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
