// 宿主模型调用封装：照抄 dsh-media-desk/src/ai.js:50-96 范式。
// 会话外调模型必须自带 sessionId，缺了会 400 MissingSessionID。
//
// 真机根因（2026-11-12 P1.6 判别性复验）：agentDefaultModel.currentSelection() 返回的是
// 主对话模型 workbuddy/hy4free，但插件 ctx.llm 的 prepareCall/stream 通道对它 90s 零块
// （diag: chunks=0, ms=90004, aborted=true）。media-desk 的可用范式是 assistantOverride
// 钉住 agnes-ai/agnes-2.5-flash。故 FlowFile 不再盲从默认选择，而是从 ctx.llm 已
// 公布的 provider/model 清单里挑一个文本模型（排除图像/视频/embedding 与 hy4*）。
// 用户可在 ~/.flowfile/model.json 写 {"provider":"...","model":"..."} 钉住模型。
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { writeFile, copyFile, stat as statAsync, mkdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { openDb, addEvent } from './db.js'

export const SESSION_ID = 'flowfile-' + randomUUID()

// hy4*（workbuddy 主对话模型）在插件通道不流式；图像/视频/嵌入模型不能当文本模型用。
const TEXT_EXCLUDE_RE = /image|video|embed|rerank|whisper|tts|audio|vision/i
// 自动选择顺序：agnes-ai 有本机 live token 且被 media-desk 实测用作助手模型，放首位。
const PREFERRED_PROVIDERS = ['agnes-ai', 'deepseek-official', 'deepseek-account', 'lobsterai', 'minimax', 'gemini', 'zcode', 'trae', 'qodercn', 'qoder', 'qoder-global', 'workbuddy']

export function isTextModel(id) {
  if (!id || typeof id !== 'string') return false
  if (TEXT_EXCLUDE_RE.test(id)) return false
  if (/^hy4/i.test(id)) return false
  return true
}

/** 纯函数：从「已公布的 provider/model 清单」里选路由。测试与运行时共用。 */
export function selectRoute({ defaultSelection, providers, override }) {
  const list = (providers || []).map(p => ({
    provider: p.provider || p.id,
    models: (p.models || []).map(m => (m && typeof m === 'object' ? m.id : m)).filter(isTextModel)
  })).filter(p => p.provider && p.models.length)
  const find = (sel) => {
    if (!sel || !sel.provider || !sel.model || !isTextModel(sel.model)) return null
    const row = list.find(p => p.provider === sel.provider)
    if (!row || !row.models.includes(sel.model)) return null
    return { provider: sel.provider, model: sel.model }
  }
  if (override) { const r = find(override); if (r) return r }
  if (defaultSelection) { const r = find(defaultSelection); if (r) return r }
  for (const pref of PREFERRED_PROVIDERS) {
    const row = list.find(p => p.provider === pref)
    if (row) return { provider: row.provider, model: row.models[0] }
  }
  if (list.length) return { provider: list[0].provider, model: list[0].models[0] }
  return null
}

export function extractJson(text) {
  const fence = String.fromCharCode(96).repeat(3)
  const re = new RegExp(fence + '(?:json)?\\s*([\\s\\S]*?)' + fence)
  const fenced = re.exec(text)
  const body = fenced ? fenced[1] : text
  const start = body.search(/[{[]/)
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'))
  if (start < 0 || end < start) throw new Error('模型没有返回 JSON')
  return JSON.parse(body.slice(start, end + 1))
}

export function currentSelection(ctx) {
  try { return ctx.get('agentDefaultModel')?.currentSelection() || null }
  catch (e) { return null }
}

export const AUTO_LABEL = '跟随宿主默认'
/** 配置路径：默认 ~/.flowfile/model.json；FLOWFILE_MODEL_PATH 仅用于测试隔离。 */
export function modelConfigPath() {
  return process.env.FLOWFILE_MODEL_PATH || join(homedir(), '.flowfile', 'model.json')
}
/** 用户钉住的模型（运行时读文件，改文件无需重启/recomposition）。 */
export function readOverride() {
  try {
    const j = JSON.parse(readFileSync(modelConfigPath(), 'utf8'))
    return j && j.provider && j.model ? { provider: String(j.provider), model: String(j.model) } : null
  } catch (e) { return null }
}
/** 把旧版 model.json 归档成 .bak（可恢复清单，绝不硬删）。返回备份路径或 null。 */
async function backupOverride(p) {
  try {
    if (!existsSync(p)) return null
    const bak = p + '.bak'
    await copyFile(p, bak)
    return bak
  } catch (e) { return null }
}
/** 写 {provider, model} 两个 id；绝不写任何文件内容、路径或密钥。 */
async function writeOverride(p, sel) {
  const dir = dirname(p)
  try { await statAsync(dir) } catch (e) { await mkdir(dir, { recursive: true }) }
  await writeFile(p, JSON.stringify({ provider: sel.provider, model: sel.model }, null, 2) + '\n', 'utf8')
}

let cachedRoutes = null
let cachedRoutesAt = 0
/** 第 2 轮 ③：模型清单与当前选择状态（GET /flowfile/models 的形状）。 */
export async function modelState(ctx) {
  // 下拉是用户主动打开的状态查询，强制刷新清单：离线 provider 要如实标「不可用」，
  // 钉住值一旦下架也要立刻显示 overrideAvailable=false，不能用 60s 缓存糊过去。
  const providers = await listChatRoutes(ctx, true)
  const override = readOverride()
  const overrideAvailable = override ? !!findRoute(providers, override) : true
  const current = selectRoute({ defaultSelection: currentSelection(ctx), providers, override: overrideAvailable ? override : null })
    || currentSelection(ctx)
  const routes = providers.map(p => ({
    provider: p.provider,
    models: (p.models || []).filter(isTextModel),
    available: (p.models || []).some(isTextModel)
  }))
  return { mode: 'flowfile', autoLabel: AUTO_LABEL, routes, current, override, overrideAvailable }
}

/** 第 2 轮 ③：写模型选择。auto=true 或空值 = 归档旧配置并回到跟随宿主默认。 */
export async function setModelOverride(ctx, body) {
  const p = modelConfigPath()
  const b = body || {}
  const wantAuto = b.auto === true || (!b.provider && !b.model)
  if (wantAuto) {
    const backupPath = await backupOverride(p)
    try { await unlink(p) } catch (e) { /* 文件不存在时无需删 */ }
    clearRouteCache()
    return { ok: true, action: 'cleared', backupPath, override: null, ...(await modelState(ctx)) }
  }
  const provider = String(b.provider || '').trim()
  const model = String(b.model || '').trim()
  if (!provider || !model || !isTextModel(model)) {
    throw Object.assign(new Error('模型参数不合法（需要文本模型的 provider + model）'), { status: 400 })
  }
  const sel = { provider, model }
  const providers = await listChatRoutes(ctx, true)
  if (!findRoute(providers, sel)) {
    throw Object.assign(new Error('所选模型不在可用清单里，请刷新后重试'), { status: 400 })
  }
  const backupPath = await backupOverride(p)
  await writeOverride(p, sel)
  clearRouteCache()
  return { ok: true, action: 'set', backupPath, override: sel, ...(await modelState(ctx)) }
}

function findRoute(providers, sel) {
  if (!sel || !isTextModel(sel.model)) return null
  const row = (providers || []).find(p => p.provider === sel.provider)
  return row && row.models.includes(sel.model) ? { provider: sel.provider, model: sel.model } : null
}

export function clearRouteCache() { cachedRoutes = null; cachedRoutesAt = 0 }
async function listChatRoutes(ctx, fresh) {
  const llm = ctx.get('llm')
  if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') return []
  const now = Date.now()
  if (!fresh && cachedRoutes && now - cachedRoutesAt < 60000) return cachedRoutes
  let providers
  try { providers = await llm.listProviders() } catch (e) { return cachedRoutes || [] }
  const out = []
  for (const p of providers || []) {
    const id = p && (p.id || p.provider)
    if (!id) continue
    try {
      const models = await llm.listModels(id)
      out.push({ provider: id, models: (models || []).map(m => (m && m.id) ? m.id : m), available: true })
    } catch (e) {
      // 离线 provider 仍保留在清单里，标 available=false + 空 models；selectRoute 会自然跳过它。
      out.push({ provider: id, models: [], available: false })
    }
  }
  cachedRoutes = out
  cachedRoutesAt = now
  return out
}

export async function resolveRoute(ctx, override) {
  const providers = await listChatRoutes(ctx)
  return selectRoute({ defaultSelection: currentSelection(ctx), providers, override: override || readOverride() })
}

/** 诊断写进插件自有 events 表（时间线能力可见），失败也不影响主流程。 */
function emitDiag(diag, phase, extra) {
  try {
    const db = openDb()
    const payload = { phase, at: Date.now(), ...(diag || {}), ...(extra || {}) }
    addEvent(db, { path: 'flowfile://llm/' + phase, kind: 'llm_diag', detail: JSON.stringify(payload).slice(0, 2000), at: Math.floor(Date.now() / 1000) })
  } catch (e) { /* 诊断落库失败不阻断模型调用 */ }
}

/**
 * 调一次模型并流式回传文本。
 * opts: { system, user, maxTokens?, signal?, diag?, purpose? }
 * diag 是可选对象，调用方可读回 { route, routeSource, reasoningEffort, defaultEffort, efforts, chunks, textLen, ms, error }。
 */
export async function callModel(ctx, opts) {
  const system = opts.system
  const user = opts.user
  const maxTokens = opts.maxTokens || 1500
  const signal = opts.signal
  const diag = opts.diag || {}
  const purpose = opts.purpose || 'generic'
  const t0 = Date.now()
  const llm = ctx.get('llm')
  if (!llm) throw Object.assign(new Error('当前没有可用模型'), { status: 503 })

  const override = readOverride()
  let route = await resolveRoute(ctx, override)
  let routeSource = override ? 'override' : 'auto'
  if (!route) {
    // 清单拿不到时兼容旧行为（离线/单测 mock）：照旧用主对话默认选择。
    route = currentSelection(ctx)
    routeSource = 'fallback-default'
  }
  if (!route) throw Object.assign(new Error('当前没有可用模型'), { status: 503 })
  diag.route = route
  diag.routeSource = routeSource

  try {
    // configure 回调：取该模型 reasoning.efforts 的第一档（最低思考档），强制结构化短调用走低思考。
    const call = await llm.prepareCall(
      { provider: route.provider, model: route.model, maxTokens },
      signal,
      (controls, model) => {
        const efforts = model && model.reasoning && Array.isArray(model.reasoning.efforts) ? model.reasoning.efforts : []
        const effort = efforts.length ? efforts[0].id : undefined
        diag.defaultEffort = model && model.reasoning ? model.reasoning.defaultEffort : null
        diag.efforts = efforts.map(e => (e && e.id) || null)
        diag.requestedEffort = effort === undefined ? null : effort
        return { ...controls, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
      }
    )
    diag.reasoningEffort = call.config && call.config.reasoningEffort !== undefined ? call.config.reasoningEffort : null
    diag.resolvedMaxTokens = call.config && call.config.maxTokens !== undefined ? call.config.maxTokens : null
    emitDiag(diag, 'start', { purpose })
    let text = ''
    let chunks = 0
    for await (const chunk of call.stream({
      ...call.config,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }], source: { kind: 'flowfile' } }],
      sessionId: SESSION_ID,
      signal
    })) {
      chunks += 1
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish' && ['error', 'aborted'].includes(chunk.reason?.kind)) {
        throw Object.assign(new Error(chunk.reason?.failure?.message || '模型调用失败'), { status: 502, reasonKind: chunk.reason?.kind })
      }
    }
    diag.chunks = chunks
    diag.textLen = text.length
    diag.ms = Date.now() - t0
    diag.aborted = signal ? signal.aborted : false
    emitDiag(diag, 'done', { purpose })
    return text
  } catch (e) {
    diag.chunks = diag.chunks || 0
    diag.ms = Date.now() - t0
    diag.aborted = signal ? signal.aborted : false
    diag.error = e && e.message ? String(e.message).slice(0, 300) : 'unknown'
    diag.reasonKind = e && e.reasonKind ? e.reasonKind : null
    diag.status = e && e.status ? e.status : null
    emitDiag(diag, 'error', { purpose })
    throw e
  }
}
