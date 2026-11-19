// 智能识别：可观测信号 → 模型 → 白名单卡片 → 派生标签 → 缓存。
// 第 17 轮（m07721）三条硬约束都落在这里：
// ① 默认关闭：uploadPolicy() 返回 allowed:false 时根本不碰模型，只给规则卡片；
// ② 未经允许不上传：只有 local（loopback）或 host+allowCloud 才会发数据；
// ③ 结果缓存：key = path|size|mtime|mode，命中就不再请求（既省也避免重复上传）。
// 「来源未知」是一等状态；模型输出永远是不可信输入。
import { collectSignals } from './meta.js'
import { callModel, extractJson } from './llm.js'
import { statSync } from 'node:fs'
import { loadSettings, uploadPolicy, deriveTags, cacheKeyFor, isLocalEndpoint } from './settings.js'
import { getRecognizeCache, putRecognizeCache } from './db.js'

const ALLOWED = ['what', 'from', 'usage', 'cleanable', 'confidence', 'evidence']

export function recognizeSystem() {
  return [
    '你是「FlowFile」的文件识别助手。只根据下面给出的「已知信号」判断，不要编造。',
    '只输出一个 JSON 对象，格式：',
    '{"what":"这是什么","from":"从哪来|unknown","usage":"通常怎么用",',
    ' "cleanable":"yes|no|unknown","confidence":0..1,"evidence":["信号名:值",...]}',
    '硬性规则：',
    '1. from 只能来自 where_from 字段原文；值为空或 null 时必须写 unknown，禁止推断 URL、应用名、人名、日期。',
    '2. 证据不足的字段写 unknown；禁止编造网址、软件名、来源、日期。',
    '3. evidence 最多 8 条，必须来自已知信号表里的真实字段。',
    '4. cleanable 只有能明确判断时才写 yes/no，否则 unknown。'
  ].join('\n')
}

export function buildSignalsUser(signals) {
  const rows = []
  for (const [k, v] of Object.entries(signals)) {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue
    rows.push(k + ': ' + (Array.isArray(v) ? v.join(' | ') : String(v)))
  }
  return '已知信号（只能引用这些，不得补充）：\n' + rows.join('\n')
}

/** 白名单校验：只取 7 字段；from 非已知来源一律 unknown；confidence 钳 0..1。 */
export function validateCard(card, signals) {
  const c = (card && typeof card === 'object') ? card : {}
  const knownFrom = signals.where_from || null
  let from = typeof c.from === 'string' ? c.from.slice(0, 300) : 'unknown'
  if (!knownFrom || from !== knownFrom) from = 'unknown'
  const clean = ['yes', 'no', 'unknown'].includes(c.cleanable) ? c.cleanable : 'unknown'
  let conf = Number(c.confidence)
  if (!Number.isFinite(conf)) conf = 0
  conf = Math.max(0, Math.min(1, conf))
  const evidence = Array.isArray(c.evidence) ? c.evidence.filter(e => typeof e === 'string').slice(0, 8).map(e => e.slice(0, 120)) : []
  const out = {}
  for (const k of ALLOWED) out[k] = null
  out.what = typeof c.what === 'string' ? c.what.slice(0, 300) : 'unknown'
  out.from = from
  out.usage = typeof c.usage === 'string' ? c.usage.slice(0, 400) : 'unknown'
  out.cleanable = clean
  out.confidence = conf
  out.evidence = evidence
  out.knownFrom = knownFrom
  out.sourceUnknown = !knownFrom
  return out
}

/** 关闭识别时的规则卡片：只用扩展名与大小，不联网、不调模型。 */
export function ruleCard(signals) {
  const ext = String(signals.ext || '').replace(/^\./, '')
  const size = Number(signals.size) || 0
  const what = ext ? (String(ext).toUpperCase() + ' 文件') : '文件'
  return validateCard({ what: what, from: 'unknown', usage: 'unknown', cleanable: 'unknown', confidence: 0,
    evidence: ['ext:' + (ext || '无'), 'size:' + size] }, signals)
}

/** 本地 OpenAI 兼容端点调用（Ollama / LM Studio 等）。只允许 loopback。 */
async function callLocalModel(settings, system, user, timeoutMs) {
  const base = String(settings.ai.localBaseUrl || '').replace(/\/$/, '')
  if (!isLocalEndpoint(base)) throw new Error('本地端点必须是本机回环地址')
  const model = String(settings.ai.localModel || '').trim()
  const body = {
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    stream: false,
    temperature: 0
  }
  if (model) body.model = model
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs || 60000)
  })
  if (!res.ok) throw new Error('本地模型返回 ' + res.status)
  const data = await res.json()
  const text = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : ''
  return String(text || '')
}

function slim(signals) {
  const out = Object.assign({}, signals)
  out.text_excerpt = signals.text_excerpt ? String(signals.text_excerpt).slice(0, 200) : null
  return out
}

/**
 * 识别一个文件。opts = { db, settings, force }
 * 返回 { signals, card, modelUsed, tags, cached, uplink, policyReason }
 */
export async function recognizeFile(ctx, path, opts) {
  const o = opts || {}
  const settings = o.settings || loadSettings()
  const signals = await collectSignals(path, statSync(path))
  const policy = uploadPolicy(settings)
  const key = cacheKeyFor({ path, size: signals.size, mtime: signals.mtime }, settings.ai.mode)

  // ③ 缓存优先：命中直接返回，不发起任何请求。
  if (o.db && !o.force) {
    const hit = getRecognizeCache(o.db, key)
    if (hit && hit.card) {
      return { signals: slim(signals), card: hit.card, modelUsed: hit.mode !== 'off',
        tags: hit.tags || [], cached: true, uplink: policy.uplink, policyReason: policy.reason }
    }
  }

  let card = null
  let modelUsed = false
  if (!policy.allowed) {
    // ① 默认关闭 / 未授权：绝不碰模型，给规则卡片。
    card = ruleCard(signals)
  } else {
    let text = ''
    try {
      if (policy.uplink === 'local') {
        text = await callLocalModel(settings, recognizeSystem(), buildSignalsUser(signals), settings.ai.timeoutMs)
      } else {
        text = await callModel(ctx, { system: recognizeSystem(), user: buildSignalsUser(signals), maxTokens: 900, signal: AbortSignal.timeout(90000) })
      }
    } catch (e) {
      text = ''
    }
    let parsed = null
    try { parsed = extractJson(text) } catch (e) { parsed = null }
    if (parsed && Object.keys(parsed).length) {
      card = validateCard(parsed, signals)
      modelUsed = true
    } else {
      card = ruleCard(signals)
      modelUsed = false
    }
  }

  const tags = settings.recognize.autoTags === false ? [] : deriveTags(card, { ext: signals.ext, name: signals.name })
  if (o.db) {
    try {
      putRecognizeCache(o.db, { key, path, mode: settings.ai.mode, size: signals.size, mtime: signals.mtime, card, tags })
    } catch (e) { /* 缓存写失败不影响返回 */ }
  }
  return { signals: slim(signals), card, modelUsed, tags, cached: false, uplink: policy.uplink, policyReason: policy.reason }
}

/** 预识别：列举首层文件（默认前 N 个），逐个走 recognizeFile。未开启或未授权时直接跳过。 */
export async function preScanDir(ctx, db, dirPath, entries, settings) {
  const s = settings || loadSettings()
  if (!s.recognize.preScan) return { skipped: true, reason: '预识别未开启', items: [] }
  const policy = uploadPolicy(s)
  if (!policy.allowed) return { skipped: true, reason: policy.reason, items: [] }
  const limit = Math.max(1, Math.min(200, Number(s.recognize.preScanLimit) || 20))
  const targets = (entries || []).filter(e => e && !e.isDir).slice(0, limit)
  const items = []
  for (const e of targets) {
    try {
      const r = await recognizeFile(ctx, e.path, { db, settings: s })
      items.push({ path: e.path, what: r.card && r.card.what, tags: r.tags, cached: r.cached })
    } catch (err) {
      items.push({ path: e.path, error: err.message })
    }
  }
  return { skipped: false, uplink: policy.uplink, count: items.length, items }
}
