// FlowFile host 半片：/flowfile/* 前缀路由。契约照抄 dsh-media-desk/src/host.js:29-34,445-495。
// 铁律：本文件不写任何业务文件；业务文件写操作全部封装在 src/ops.js，由 /ops/* 路由调用。
// 写 SQLite（db.js）属插件自有元数据存储，不是业务文件改写。
import { readdir, stat, lstat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, basename, extname, dirname, resolve } from 'node:path'
import { createGuard, defaultRoots } from './path-guard.js'
import { listVolumes } from './volumes.js'
import { classifyEntry, allGroups } from './rules.js'
import { finderTags, attributesFor } from './tags.js'
import { openDb, getFile, tagsFor, setTags, addEvent, timelineFor, recentEvents, updateChatPayload } from './db.js'
import { ScanManager } from './index.js'
import { duplicatesFromDb } from './dedup.js'
import { similarFromDb } from './similar.js'
import { recognizeFile, preScanDir } from './recognize.js'
import { loadSettings, saveSettings, settingsPath, uploadPolicy, normalizeSettings, deriveTags } from './settings.js'
import { pruneRecognizeCache } from './db.js'
import { handleChat, getHistory, makeChatPlan } from './chat.js'
import { buildPresetPlan, injectMkdirItems, listPresets } from './presets.js'
import { createPlanBatch, createBatchFromPlan, dryRun, execute, undo, batches, batchDetail } from './ops.js'
import { modelState, setModelOverride } from './llm.js'
import { ensureOps, buildMenuBatch, listAllTags, volumeCapacity, thumbFor } from './ops-browse.js'
import { cleanCandidates, cleanBuildPlan } from './clean.js'

const MAX_ENTRIES = 2000
const run = promisify(execFile)

function json(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1_000_000) throw Object.assign(new Error('请求太大'), { status: 413 })
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch (e) { throw Object.assign(new Error('请求不是有效的 JSON'), { status: 400 }) }
}

const states = new WeakMap()
function state(ctx) {
  let s = states.get(ctx)
  if (!s) {
    // FLOWFILE_ROOTS 仅用于测试注入临时目录；在默认根（~ 与 /Volumes）之外追加，不替换。
    const extraRoots = process.env.FLOWFILE_ROOTS ? process.env.FLOWFILE_ROOTS.split(':').filter(Boolean) : []
    const guard = createGuard(extraRoots.length ? [...defaultRoots(), ...extraRoots] : undefined)
    const db = openDb()
    ensureOps()   // 右键菜单计划需要 mkdir op（幂等）
    s = { guard, db, scans: new ScanManager(db, guard) }
    states.set(ctx, s)
  }
  return s
}

async function toEntry(guard, db, parent, name) {
  const path = join(parent, name)
  if (!guard.isAllowed(path)) return null
  try {
    const info = await lstat(path)
    const isDir = info.isDirectory()
    const row = getFile(db, path)
    const base = {
      path, name, isDir,
      size: info.size,
      mtime: info.mtime.toISOString(),
      birthtime: info.birthtime ? info.birthtime.toISOString() : null,
      mode: info.mode,
      ext: isDir ? '' : extname(name).toLowerCase(),
      tags: classifyEntry(name, info.size, isDir),
      indexed: !!row
    }
    if (row) {
      base.userTags = tagsFor(db, path).map(t => t.name)
      base.hashState = row.hash_state
      base.phash = row.phash
      base.whereFrom = row.where_from
    }
    return base
  } catch (e) { return null }
}

async function listDirectory(guard, db, path) {
  const abs = guard.assertAllowed(path)
  let info
  try { info = await stat(abs) }
  catch (e) { throw Object.assign(new Error('目录不存在或不可读'), { status: 404 }) }
  if (!info.isDirectory()) throw Object.assign(new Error('不是目录'), { status: 400 })
  let names = []
  try { names = await readdir(abs) }
  catch (e) { throw Object.assign(new Error('无法读取目录（可能需要系统授权）'), { status: 403 }) }
  const entries = []
  let hidden = 0
  for (const name of names) {
    if (name.charAt(0) === '.') { hidden += 1; continue }
    if (entries.length >= MAX_ENTRIES) break
    const entry = await toEntry(guard, db, abs, name)
    if (entry) entries.push(entry)
  }
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh') : a.isDir ? -1 : 1))
  return {
    path: abs, parent: guard.isAllowed(dirname(abs)) ? dirname(abs) : null,
    count: entries.length, hidden, truncated: names.length > MAX_ENTRIES,
    entries, groups: allGroups(), mode: 'flowfile'
  }
}

async function getAttributes(guard, db, path) {
  const abs = guard.assertAllowed(path)
  let info
  try { info = await lstat(abs) }
  catch (e) { throw Object.assign(new Error('文件不存在'), { status: 404 }) }
  const isDir = info.isDirectory()
  const entry = {
    path: abs, name: basename(abs), isDir,
    size: info.size, mtime: info.mtime.toISOString(),
    birthtime: info.birthtime ? info.birthtime.toISOString() : null,
    mode: info.mode, ext: isDir ? '' : extname(abs).toLowerCase(),
    tags: classifyEntry(basename(abs), info.size, isDir)
  }
  const finder = await finderTags(abs)
  const row = getFile(db, abs)
  return {
    ...attributesFor(entry), finderTags: finder,
    userTags: tagsFor(db, abs).map(t => t.name),
    whereFrom: row ? row.where_from : null,
    contentType: row ? row.content_type : null,
    phash: row ? row.phash : null,
    hashState: row ? row.hash_state : null,
    indexed: !!row,
    timeline: timelineFor(db, abs, 20)
  }
}

function searchDb(db, guard, q, path, kind, tag) {
  const like = '%' + String(q || '').trim() + '%'
  let sql = 'SELECT * FROM files WHERE missing=0 AND name LIKE ?'
  const args = [like]
  if (path) { const abs = guard.assertAllowed(path); sql += ' AND path LIKE ?'; args.push(abs + '%') }
  if (kind && kind !== 'all') { sql += ' AND kind=?'; args.push(kind) }
  sql += ' ORDER BY size DESC LIMIT 300'
  let rows = db.prepare(sql).all(...args)
  rows = rows.filter(r => guard.isAllowed(r.path))
  if (tag) rows = rows.filter(r => tagsFor(db, r.path).some(t => t.name === tag))
  return rows.map(r => ({ path: r.path, name: r.name, size: r.size, mtime: r.mtime_ns,
    isDir: !!r.is_dir, ext: r.ext, tags: classifyEntry(r.name, r.size, !!r.is_dir),
    userTags: tagsFor(db, r.path).map(t => t.name) }))
}

async function route(ctx, s, req, res) {
  const url = new URL(req.url || '/', 'http://local')
  const path = url.pathname.replace(/^\/flowfile\/?/, '')
  const method = req.method || 'GET'
  const q = (k) => url.searchParams.get(k)
  const guard = s.guard, db = s.db

  if (method === 'GET') {
    if (path === 'volumes') return json(res, 200, await listVolumes(guard))
    if (path === 'list') return json(res, 200, await listDirectory(guard, db, q('path') || ''))
    if (path === 'meta') return json(res, 200, await getAttributes(guard, db, q('path') || ''))
    if (path === 'search') return json(res, 200, { entries: searchDb(db, guard, q('q'), q('path'), q('kind'), q('tag')) })
    if (path === 'duplicates') return json(res, 200, { groups: duplicatesFromDb(db, q('root') || null) })
    if (path === 'similar') { const p = guard.assertAllowed(q('path') || ''); return json(res, 200, similarFromDb(db, p)) }
    if (path === 'timeline') {
      const p = q('path')
      const limit = Math.min(Number(q('limit') || 50), 200)
      if (p) { guard.assertAllowed(p); return json(res, 200, { events: timelineFor(db, p, limit) }) }
      return json(res, 200, { events: recentEvents(db, limit) })
    }
    if (path === 'recognize') {
      const p = guard.assertAllowed(q('path') || '')
      const st = loadSettings()
      const r = await recognizeFile(ctx, p, { db, settings: st, force: q('force') === '1' })
      // 第 17 轮（m07721 ①）：识别结果自动派生成标签，source='auto' 与用户手打的 user 标签分开存。
      if (r && Array.isArray(r.tags) && r.tags.length) { try { setTags(db, p, r.tags, 'auto') } catch (e) {} }
      return json(res, 200, r)
    }
    if (path === 'settings') {
      const st = loadSettings()
      return json(res, 200, { settings: st, uplink: uploadPolicy(st), path: settingsPath() })
    }
    if (path === 'scan/status') { const st = s.scans.status(q('scanId') || ''); return st ? json(res, 200, st) : json(res, 404, { error: '扫描不存在', code: 'not_found' }) }
    if (path === 'ops/batches') return json(res, 200, { batches: batches(db, Math.min(Number(q('limit') || 30), 100)) })
    if (path === 'ops/batch') { const d = batchDetail(db, q('id') || ''); return d ? json(res, 200, d) : json(res, 404, { error: '批次不存在', code: 'not_found' }) }
    if (path === 'chat/history') return json(res, 200, { messages: getHistory(db, Math.min(Number(q('limit') || 100), 300)) })
    if (path === 'presets') return json(res, 200, { presets: listPresets(), mode: 'flowfile' })
    if (path === 'models') return json(res, 200, await modelState(ctx))
    if (path === 'capacity') return json(res, 200, volumeCapacity(guard, q('path') || ''))
    if (path === 'tags') return json(res, 200, { tags: listAllTags(db) })
    if (path === 'thumb') { const t = await thumbFor(guard, q('path') || '', Number(q('w') || 128)); return json(res, t.ok ? 200 : (t.error === '路径不在允许范围' ? 403 : 422), t) }
    if (path === 'clean/candidates') return json(res, 200, await cleanCandidates(db, guard))
    return json(res, 404, { error: '接口不存在', code: 'not_found' })
  }

  if (method === 'POST') {
    const site = req.headers['sec-fetch-site']
    if (site && site !== 'same-origin' && site !== 'none') return json(res, 403, { error: '拒绝跨站请求', code: 'csrf' })
    const body = await readJson(req)
    if (path === 'model') return json(res, 200, await setModelOverride(ctx, body))
    if (path === 'ops/menu-plan') return json(res, 200, buildMenuBatch(db, guard, body))
    if (path === 'clean/plan') return json(res, 200, await cleanBuildPlan(ctx, db, guard, body.paths || []))
    if (path === 'plan') {
      const message = String(body.message || '').trim()
      if (!message) throw Object.assign(new Error('请先说一句想怎么整理'), { status: 400 })
      const listing = await listDirectory(guard, db, body.path || '')
      const r = await createPlanBatch(ctx, db, message, listing.entries, { path: listing.path }, guard)
      return json(res, 200, { ...r.plan, batchId: r.batchId, items: r.items, scanned: listing.count, at: listing.path, readOnly: false })
    }
    if (path === 'settings') {
      // 保存设置：normalizeSettings 会把非法 mode 收敛回 off，allowCloud 只认 true。
      const st = saveSettings(settingsPath(), body.settings || body)
      return json(res, 200, { settings: st, uplink: uploadPolicy(st), path: settingsPath() })
    }
    if (path === 'recognize/cached') {
      const p = guard.assertAllowed(body.path || '')
      const st = loadSettings()
      const r = await recognizeFile(ctx, p, { db, settings: st, force: body.force === true })
      if (r && Array.isArray(r.tags) && r.tags.length) { try { setTags(db, p, r.tags, 'auto') } catch (e) {} }
      return json(res, 200, r)
    }
    if (path === 'recognize/prescan') {
      const listing = await listDirectory(guard, db, body.path || '')
      const st = loadSettings()
      const r = await preScanDir(ctx, db, listing.path, listing.entries, st)
      return json(res, 200, Object.assign({ at: listing.path }, r))
    }
    if (path === 'preset') {
      // 预设整理方案（m07306 ⑤）：纯规则枚举，不调模型；产出与对话同一形状的计划批次。
      const id = String(body.id || '')
      const listing = await listDirectory(guard, db, body.path || '')
      const raw = buildPresetPlan(id, listing.path, listing.entries)
      if (!raw) return json(res, 200, { batchId: null, items: [], empty: true, at: listing.path,
        reply: '这个目录里没有「' + id + '」能套用的文件' })
      const withMk = injectMkdirItems(raw, {
        dir: listing.path,
        existsFn: existsSync,
        allowedFn: function (p) { return guard.isAllowed(p) }
      })
      const b = createBatchFromPlan(db, withMk, { path: listing.path })
      return json(res, 200, { ...withMk, batchId: b.batchId, items: b.items, at: listing.path,
        scanned: listing.count, readOnly: false, preset: id })
    }
    if (path === 'chat') {
      const message = String(body.message || '').trim()
      if (!message) throw Object.assign(new Error('消息不能为空'), { status: 400 })
      const listing = await listDirectory(guard, db, body.path || '')
      const selected = Array.isArray(body.selected) ? body.selected.filter(p => guard.isAllowed(p)) : []
      const entries = selected.length ? listing.entries.filter(e => selected.includes(e.path)) : listing.entries
      const r = await handleChat(ctx, db, message, { path: listing.path }, entries, { guard })
      // 若模型给出计划，落成可勾选批次；并把 batchId 回写进历史消息（刷新后卡片仍可操作）
      if (r.payload && r.payload.kind === 'plan' && r.payload.plan && r.payload.plan.groups && r.payload.plan.groups.length) {
        try {
          // 真 bug 修复（m07306 ④）：AI 常把 move 目标写成一个还不存在的子目录，
          // 而 ops.dry-run 明确「不自动新建文件夹」→ 整批被判 blocked，用户看到的就是「AI 执行出错」。
          // 这里在执行门前补一条 mkdir，让计划自洽（只在目标父层是当前目录/已存在时补）。
          r.payload.plan = injectMkdirItems(r.payload.plan, {
            dir: listing.path,
            existsFn: existsSync,
            allowedFn: function (p) { return guard.isAllowed(p) }
          })
          const b = createBatchFromPlan(db, r.payload.plan, { path: listing.path })
          r.batchId = b.batchId
          r.payload.plan.batchId = b.batchId
          r.payload.plan.items = b.items
          r.payload.plan.at = listing.path
          r.payload.plan.scanned = listing.count
          updateChatPayload(db, r.messageId, r.payload)
        } catch (e) { r.batchId = null }
      }
      return json(res, 200, r)
    }
    if (path === 'chat/plan') {
      const message = String(body.message || '').trim()
      if (!message) throw Object.assign(new Error('消息不能为空'), { status: 400 })
      const listing = await listDirectory(guard, db, body.path || '')
      const plan = await makeChatPlan(ctx, message, listing.entries, { path: listing.path }, guard)
      const b = plan.groups && plan.groups.length ? createBatchFromPlan(db, plan, { path: listing.path }) : { batchId: null, items: [] }
      return json(res, 200, { ...plan, batchId: b.batchId, items: b.items, at: listing.path, scanned: listing.count })
    }
    if (path === 'scan') { const id = s.scans.start(body.root || '', body.options || {}); return json(res, 200, { scanId: id }) }
    if (path === 'scan/cancel') return json(res, 200, { ok: s.scans.cancel(String(body.scanId || '')) })
    if (path === 'ops/dry-run') return json(res, 200, dryRun(db, guard, String(body.batchId || '')))
    if (path === 'ops/execute') return json(res, 200, execute(db, guard, String(body.batchId || ''), body.approvedIds || [], body.confirmFlags || {}))
    if (path === 'ops/undo') return json(res, 200, undo(db, guard, String(body.batchId || '')))
    if (path === 'tags') {
      const p = guard.assertAllowed(body.path || '')
      const names = Array.isArray(body.tags) ? body.tags : []
      setTags(db, p, names, String(body.source || 'user'))
      addEvent(db, { path: p, kind: 'tagged', detail: JSON.stringify(names), at: Math.floor(Date.now() / 1000) })
      return json(res, 200, { ok: true, tags: tagsFor(db, p).map(t => t.name) })
    }
    if (path === 'open') {
      const p = guard.assertAllowed(body.path || '')
      const args = body.reveal ? ['-R', p] : [p]
      try { await run('open', args, { timeout: 5000 }) } catch (e) { throw Object.assign(new Error('打开失败：' + e.message), { status: 500 }) }
      return json(res, 200, { ok: true })
    }
    return json(res, 404, { error: '接口不存在', code: 'not_found' })
  }
  return json(res, 405, { error: '不支持的方法', code: 'method_not_allowed' })
}

export function requestRejection(ctx, req) {
  const connection = ctx.get('connection')
  if (typeof connection?.requestRejection !== 'function') return 403
  return connection.requestRejection({ headers: req.headers })
}

export const name = 'dsh-flowfile'

export default {
  inject: ['webServer', 'connection'],
  apply(ctx) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/flowfile',
      handler: async (req, res) => {
        try {
          const rejection = requestRejection(ctx, req)
          if (rejection) return json(res, rejection, { error: '未授权' })
          await route(ctx, state(ctx), req, res)
        } catch (err) {
          if (res.headersSent) return res.end()
          json(res, err.status || 500, { error: err.message, code: err.status === 403 ? 'forbidden' : 'error' })
        }
      },
    }), 'FlowFile: /flowfile routes')
  },
}
