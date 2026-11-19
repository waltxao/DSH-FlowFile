// 工作台内自建对话区：消息落 SQLite，意图分派到查重/相似/识别/计划。
// AI 只出计划，不执行；执行门在 ops.js。
import { addChat, chatHistory } from './db.js'
import { callModel, extractJson } from './llm.js'
import { makePlan, validatePlan } from './plan.js'

export function chatSystem() {
  return [
    '你是「FlowFile」工作台里的对话助手。用户会针对「当前目录 + 选中文件」说话。',
    '只输出一个 JSON 对象，不要输出别的内容：',
    '{"reply":"自然语言的回复","intent":"chat|dedup|similar|search|recognize|plan",',
    ' "groups":[{"label":"分组名","paths":["候选清单里的绝对路径"],"reason":"为什么",',
    ' "op":"move|rename|copy|tag|trash|none","dst":"目标目录绝对路径或空"}]}',
    '硬性规则：',
    '1. 用户给出「移动/复制/删除/重命名/整理/归类」这类整理指令时，intent 必须是 plan，',
    '   groups 必须非空且每个 path 都来自候选清单；不要反问「是否确认」，也不要用自然语言描述动作代替计划。',
    '2. paths 只能用候选清单里出现的绝对路径，禁止编造、禁止用 .. 或通配符；op 只能是上列值。',
    '3. 只产出计划，绝对不要执行任何操作、不要声称已经移动或删除了文件；用户稍后会在卡片上逐项勾选确认。',
    '4. 纯问答/搜索/查重/识别类问题 groups 填空数组 []。',
    '5. 看不懂就 {"reply":"我没看懂，换个说法试试","intent":"chat","groups":[]}。'
  ].join('\n')
}

export function chatUser(message, context, entries) {
  const rows = entries.slice(0, 120).map(e => ({ path: e.path, name: e.name, size: e.size, tags: (e.tags || []).map(t => typeof t === 'string' ? t : t.name) }))
  return '用户说：' + String(message || '').trim() +
    '\n当前目录：' + (context && context.path ? context.path : '未知') +
    '\n候选清单（JSON）：\n' + JSON.stringify(rows)
}

/** 处理一条用户消息：落库 → 模型 → 白名单 → 落库 → 返回。 */
export async function handleChat(ctx, db, message, context, entries, opts) {
  const msg = String(message || '').trim()
  if (!msg) throw Object.assign(new Error('消息不能为空'), { status: 400 })
  const userMsgId = addChat(db, 'user', 'text', msg, null, null)
  let reply = '', intent = 'chat', payload = null, batchId = null
  try {
    const text = await callModel(ctx, {
      system: chatSystem(),
      user: chatUser(msg, context, entries),
      maxTokens: 1200,
      signal: AbortSignal.timeout(90000)
    })
    let parsed
    try { parsed = extractJson(text) }
    catch (e) { parsed = { reply: text.slice(0, 600), intent: 'chat', groups: [] } }
    reply = typeof parsed.reply === 'string' ? parsed.reply.slice(0, 600) : ''
    intent = ['chat', 'dedup', 'similar', 'search', 'recognize', 'plan'].includes(parsed.intent) ? parsed.intent : 'chat'
    const allowed = entries.map(e => e.path)
    const guard = opts && opts.guard
    const plan = validatePlan({ reply, intent, groups: parsed.groups }, allowed, { guard, roots: guard ? guard.roots : null })
    if (plan.groups.length) {
      payload = { kind: 'plan', plan: { ...plan, readOnly: false } }
      // 计划批次由 ops 层创建；这里只回显，不写 ops_batches（避免 AI 自行开批次）
    } else if (intent === 'dedup' || intent === 'similar' || intent === 'recognize' || intent === 'search') {
      payload = { kind: 'action', intent }
    }
  } catch (e) {
    reply = '模型这次没能回复（' + (e.message || '未知错误') + '）。你可以直接点下面的能力面板，不用等对话。'
    intent = 'chat'
  }
  const assistantId = addChat(db, 'assistant', payload ? payload.kind : 'text', reply, payload, batchId)
  return { messageId: assistantId, userMessageId: userMsgId, reply, intent, payload, batchId }
}

export function getHistory(db, limit) { return chatHistory(db, limit || 100) }

// 生成整理计划（复用 plan.js 的 LLM 范式），返回校验后的计划对象，不落 chat。
export async function makeChatPlan(ctx, message, entries, context, guard) {
  const raw = await makePlan(ctx, message, entries, context)
  if (raw.fallback) return { ...raw, readOnly: false }
  return { ...validatePlan(raw, entries.map(e => e.path), { guard, roots: guard ? guard.roots : null }), readOnly: false }
}
