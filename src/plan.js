// 自然语言 → 结构化整理计划。AI 只出计划，绝不执行任何文件操作。
// validatePlan 在 P0 基础上加严：候选集 + 存在 + realpath 双校验 + op/dst 白名单。
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { extractJson, callModel } from './llm.js'

// mkdir 进基础集合：预设与自动补建目标目录都要用它（第 15 轮，m07306 ④）。
export const OPS = new Set(['move', 'rename', 'copy', 'tag', 'trash', 'mkdir'])

export function planSystem() {
  return [
    '你是 DeepSeek Harness「FlowFile」工作台里的文件整理助手。',
    '用户会描述想怎么整理文件。你只能产出一个「整理计划」，绝对不能执行任何操作。',
    '只输出一个 JSON 对象，不要输出别的内容，格式：',
    '{"reply":"一句话说明你打算怎么做","intent":"chat|dedup|similar|search|recognize|plan",',
    ' "groups":[{"label":"分组名","paths":["绝对路径"],"reason":"为什么","op":"move|rename|copy|tag|trash|none","dst":"目标绝对路径或空"}]}',
    '硬性规则：',
    '1. paths 只能来自下面给出的候选清单，禁止编造路径、禁止使用 .. 或通配符。',
    '2. 不要输出任何执行指令；本插件由用户逐项勾选后才会走 dry-run 与执行门。',
    '3. 分组依据只能是候选条目里真实存在的标签、类型、大小或修改时间。',
    '4. op 只能是 move/rename/copy/tag/trash/none；trash 类必须 dst 为空。',
    '5. 看不懂就返回 {"reply":"我没看懂，换个说法试试","groups":[]}。',
    '候选文件清单：'
  ].join('\n')
}

export function buildUser(message, entries, context) {
  const rows = entries.slice(0, 120).map(e => ({
    path: e.path, name: e.name, isDir: !!e.isDir || !!e.is_dir, size: e.size,
    ext: e.ext, mtime: e.mtime, tags: (e.tags || []).map(t => typeof t === 'string' ? t : t.name)
  }))
  const ctx = context && context.path ? '\n当前目录：' + context.path : ''
  return '用户说：' + String(message || '').trim() + ctx + '\n\n候选清单（JSON）：\n' + JSON.stringify(rows)
}

/** 加严白名单校验。opts = {allowedPaths, guard, existsFn, realpathFn, roots}。 */
export function validatePlan(plan, allowedPaths, opts) {
  const o = opts || {}
  const set = new Set(allowedPaths)
  const guard = o.guard
  const existsFn = o.existsFn || existsSync
  const realFn = o.realpathFn || realpathSync
  const reply = typeof plan && plan.reply === 'string' ? plan.reply.slice(0, 600) : ''
  const intent = ['chat', 'dedup', 'similar', 'search', 'recognize', 'plan'].includes(plan && plan.intent) ? plan.intent : 'plan'
  const groups = Array.isArray(plan && plan.groups) ? plan.groups : []
  const clean = []
  let dropped = 0
  const allSrc = new Set()
  for (const g of groups) {
    if (!g || typeof g !== 'object') continue
    const rawOp = typeof g.op === 'string' ? g.op : 'none'
    const op = OPS.has(rawOp) ? rawOp : 'none'
    const label = typeof g.label === 'string' ? g.label.slice(0, 40) : '未命名'
    const reason = typeof g.reason === 'string' ? g.reason.slice(0, 200) : ''
    const paths = Array.isArray(g.paths) ? g.paths : []
    const kept = []
    for (const p of paths) {
      if (typeof p !== 'string' || !set.has(p)) { dropped += 1; continue }
      try {
        if (existsFn && !existsFn(p)) { dropped += 1; continue }
        if (guard) { const real = realFn(p); if (!guard.isAllowed(real)) { dropped += 1; continue } }
      } catch (e) { dropped += 1; continue }
      kept.push(p); allSrc.add(p)
    }
    let dst = typeof g.dst === 'string' ? g.dst : ''
    if (dst) {
      if (!isAbsolute(dst) || (guard && !guard.isAllowed(resolve(dst))) || allSrc.has(dst)) dst = ''
      else if (op === 'trash') dst = ''
    }
    if (kept.length) clean.push({ label, reason, op, dst, paths: kept, requiresExplicitTrash: op === 'trash' })
  }
  return { reply, intent, groups: clean, dropped, readOnly: true }
}

export async function makePlan(ctx, message, entries, context) {
  const text = await callModel(ctx, {
    system: planSystem(),
    user: buildUser(message, entries, context),
    signal: AbortSignal.timeout(90000)
  })
  let plan
  try { plan = extractJson(text) }
  catch (e) { return { reply: '模型这次没给出结构化计划，请换个说法再试。', groups: [], dropped: 0, readOnly: true, fallback: true } }
  return plan
}
