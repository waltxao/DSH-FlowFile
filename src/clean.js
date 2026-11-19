// FlowFile 清理 P0 · Host 侧编排（候选枚举 + 定向安装包扫描 + 建批次 + AI 解释文案）
// 铁律：本文件不写任何业务文件；只枚举（fs/promises 只读）+ 写插件自有 SQLite（经 ops.js）。
// 安全：根只 homedir()、排除 /Volumes 与 SMB；AI 只写解释文案、只收摘要文本、不接触路径。
import { readdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { allFiles } from './db.js'
import { createBatchFromPlan } from './ops.js'
import { callModel } from './llm.js'
import {
  cleanCandidatesFromRows, cleanDuplicateCandidates, cleanMergeCandidates,
  cleanProtect, cleanAllowedRoot, cleanScanStamp, cleanSummary,
  cleanExt, FF_CLEAN_MAX, FF_CLEAN_INSTALLER_EXT, FF_CLEAN_CATEGORY_LABEL
} from './clean-core.js'

// 定向枚举 ~/Downloads 一层的旧安装包（非隐藏、只文件），不复用 ScanManager、不递归、不碰隐藏缓存。
// 用 fs/promises 的 lstat（非 bigint）拿 mtimeMs，再用 cleanScanStamp 复刻 src/index.js:123 的口径。
async function installerRows(home) {
  const dir = join(home, 'Downloads')
  let names = []
  try { names = await readdir(dir) } catch (e) { return [] }
  const out = []
  for (const name of names) {
    if (name.charAt(0) === '.') continue
    const p = join(dir, name)
    if (FF_CLEAN_INSTALLER_EXT.indexOf(cleanExt(p)) < 0) continue
    let st
    try { st = await lstat(p) } catch (e) { continue }
    if (!st.isFile()) continue
    const stamp = cleanScanStamp(st)
    out.push({
      path: p, name: name, size: Number(st.size || 0),
      mtime_ns: stamp.mtimeNs, ctime_ns: '0',
      is_dir: 0, missing: 0, hash_full: '', hash_state: 'none'
    })
  }
  return out
}

// 只读枚举：已索引数据 + 纯内存重复候选 + 定向安装包，合并去重后按大小降序截断。
export async function cleanCandidates(db, guard) {
  const home = homedir()
  const nowMs = Date.now()
  const rows = allFiles(db)
  const fromIndex = cleanCandidatesFromRows(rows, { home, nowMs })
  const dup = cleanDuplicateCandidates(rows, { home, nowMs })
  const inst = cleanCandidatesFromRows(await installerRows(home), { home, nowMs })
  let merged = cleanMergeCandidates(fromIndex.concat(dup).concat(inst))
  merged.sort((a, b) => Number(b.size || 0) - Number(a.size || 0))
  if (merged.length > FF_CLEAN_MAX) merged = merged.slice(0, FF_CLEAN_MAX)
  // GET 侧二次过滤：逐候选过 path-guard 与清理语义保护清单（同等或更安全，绝不更宽）。
  const candidates = merged.filter(c => guard.isAllowed(c.path) && !cleanProtect(c.path, home) && cleanAllowedRoot(c.path, home))
  return { home, candidates, summary: cleanSummary(candidates) }
}

// AI 只写一句解释文案：只送摘要（各类数量 / 总字节 / 跳过数），不送任何路径、不出候选。
// 失败降级为固定文案，绝不阻断批次创建。
export async function cleanAiReply(ctx, summary) {
  const fallback = '已按规则列出可清理候选：仅限本机用户目录，排除网络卷与凭据/模型/配置/隐藏目录；默认全部不勾选，删除一律进回收站且可撤销。'
  const cats = Object.keys(summary.byCategory || {}).map(function (k) {
    const c = summary.byCategory[k]
    return (FF_CLEAN_CATEGORY_LABEL[k] || k) + ' ' + c.count + ' 项'
  }).join('、') || '无'
  const user = '候选共 ' + summary.count + ' 项，合计 ' + Math.round(summary.bytes / 1048576) + ' MB；分类：' + cats + '。请只用一句中文说明为什么这些类别可考虑清理、以及为什么默认不勾选，不要输出路径、不要输出 JSON。'
  try {
    const text = await callModel(ctx, {
      system: '你是文件清理建议助手。只写一句简体中文解释文案；不输出文件路径、不输出 JSON、不执行任何操作、不建议永久删除。',
      user: user, maxTokens: 220, purpose: 'flowfile-clean'
    })
    const t = String(text || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 200)
    return t || fallback
  } catch (e) { return fallback }
}

// 从客户端勾选的路径建「planned」批次：路径必须来自刚枚举的候选集（模型与前端都不能编路径）。
// plan_json 带 clean.scanned 锁（scanned_size + scanned_mtime），供 ops.js 的 dryRun/execute stale 门比对。
export async function cleanBuildPlan(ctx, db, guard, selectedPaths) {
  const snap = await cleanCandidates(db, guard)
  const byPath = {}
  for (const c of snap.candidates) byPath[c.path] = c
  const wanted = Array.isArray(selectedPaths) ? selectedPaths : []
  const seen = {}, chosen = []
  for (const p of wanted) {
    if (seen[p]) continue
    seen[p] = 1
    if (!byPath[p] || !guard.isAllowed(p) || cleanProtect(p, snap.home) || !cleanAllowedRoot(p, snap.home)) continue
    chosen.push(byPath[p])
  }
  const reply = await cleanAiReply(ctx, snap.summary)
  if (!chosen.length) return { batchId: null, items: [], reply: reply, scanned: 0, candidates: snap.candidates.length }

  const scanned = {}
  const byCat = {}
  for (const c of chosen) {
    scanned[c.path] = { scanned_size: Number(c.scanned_size), scanned_mtime: String(c.scanned_mtime) }
    if (!byCat[c.category]) byCat[c.category] = []
    byCat[c.category].push(c.path)
  }
  const groups = Object.keys(byCat).map(function (cat) {
    return { op: 'trash', label: FF_CLEAN_CATEGORY_LABEL[cat] || cat,
      reason: '规则命中：' + (FF_CLEAN_CATEGORY_LABEL[cat] || cat), paths: byCat[cat] }
  })
  const plan = { reply: reply, intent: 'clean', dropped: 0, groups: groups }
  const b = createBatchFromPlan(db, plan, { path: snap.home }, { clean: { scanned: scanned } })
  return { batchId: b.batchId, items: b.items, reply: reply, intent: 'clean', dropped: 0,
    groups: groups, scanned: chosen.length, candidates: snap.candidates.length }
}
