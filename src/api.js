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
