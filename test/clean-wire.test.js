// 夹具隔离：恢复清单与删除落点都限制在本机临时绝对路径，绝不写真实 ~/.flowfile。
process.env.HOME = mkdtempSync(join(tmpdir(), 'ff-clean-home-'))

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, renameSync, writeFileSync, readFileSync, existsSync, rmSync, lstatSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, basename } from 'node:path'
import { sha256 } from '../src/hash.js'
import * as core from '../src/clean-core.js'
import hostMod from '../src/host.js'
import { createGuard } from '../src/path-guard.js'
import { openDb } from '../src/db.js'
import { createBatchFromPlan, dryRun, execute, undo, batchDetail } from '../src/ops.js'
import { setTrashDeps, resetTrashDeps } from '../src/trash.js'

const hostDir = mkdtempSync(join(tmpdir(), 'ff-clean-host-'))
process.env.FLOWFILE_DB = join(hostDir, 'index.db')
process.env.FLOWFILE_ROOTS = hostDir

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ff-clean-wire-'))
  const trashcan = join(dir, 'trashcan'); mkdirSync(trashcan)
  setTrashDeps((src) => { const dest = join(trashcan, basename(src)); renameSync(src, dest); return '# Moved "' + src + '" to "' + dest + '"' })
  const db = openDb(join(dir, 'index.db'))
  const guard = createGuard([dir])
  return { dir, db, guard }
}
function trashPlan(srcs) {
  return { reply: '清理', intent: 'clean', dropped: 0,
    groups: [{ label: '清理候选', reason: '规则命中', op: 'trash', paths: srcs }] }
}
function scannedFor(srcs) {
  const scanned = {}
  for (const p of srcs) {
    const stamp = core.cleanScanStamp(lstatSync(p))
    scanned[p] = { scanned_size: stamp.size, scanned_mtime: stamp.mtimeNs }
  }
  return { clean: { scanned: scanned } }
}

test('cleanScanStamp：复刻 index.js:123 公式，返回 size + 低精度纳秒 mtimeNs', () => {
  assert.equal(typeof core.cleanScanStamp, 'function', 'cleanScanStamp 必须存在')
  const s = core.cleanScanStamp({ size: 100, mtimeMs: 1794503922119.791 })
  assert.equal(s.size, 100)
  assert.equal(s.mtimeNs, String(BigInt(Math.floor(1794503922119.791) * 1e6)))
  assert.equal(core.cleanScanStamp(null).mtimeNs, '0')
})

test('cleanScanStamp：非 bigint 与 bigint stat 口径不同（证明必须用非 bigint lstatSync）', () => {
  const f = fixture()
  try {
    const p = join(f.dir, 'x.bin'); writeFileSync(p, 'DATA')
    const a = core.cleanScanStamp(lstatSync(p))
    const b = core.cleanScanStamp(lstatSync(p, { bigint: true }))
    assert.notEqual(a.mtimeNs, b.mtimeNs)
    const st = lstatSync(p)
    const manual = String(st.mtimeNs || BigInt(Math.floor(st.mtimeMs || st.mtime.getTime()) * 1e6))
    assert.equal(a.mtimeNs, manual)
    assert.equal(a.size, st.size)
  } finally { f.db.close(); rmSync(f.dir, { recursive: true, force: true }) }
})

test('createBatchFromPlan：第 4 参 extra 写入 plan_json.clean.scanned；旧三参调用不受影响', () => {
  const f = fixture()
  try {
    const p = join(f.dir, 'a.bin'); writeFileSync(p, 'A')
    const b = createBatchFromPlan(f.db, trashPlan([p]), { path: f.dir }, scannedFor([p]))
    const plan = batchDetail(f.db, b.batchId).plan
    assert.ok(plan.clean && plan.clean.scanned, 'extra 必须落进 plan_json')
    assert.equal(plan.clean.scanned[p].scanned_size, 1)
    const old = createBatchFromPlan(f.db, trashPlan([p]), { path: f.dir })
    assert.equal(batchDetail(f.db, old.batchId).plan.clean, undefined)
  } finally { f.db.close(); rmSync(f.dir, { recursive: true, force: true }) }
})

test('dryRun：有 clean 锁且扫描后未变化 → ready（不误杀）', () => {
  const f = fixture()
  try {
    const p = join(f.dir, 'a.bin'); writeFileSync(p, 'A')
    const b = createBatchFromPlan(f.db, trashPlan([p]), { path: f.dir }, scannedFor([p]))
    const dry = dryRun(f.db, f.guard, b.batchId)
    assert.equal(dry.items.length, 1)
    assert.equal(dry.items[0].status, 'ready')
  } finally { f.db.close(); rmSync(f.dir, { recursive: true, force: true }) }
})

test('dryRun：扫描后文件变化 → 该项 skipped 且 reason 含重新扫描', () => {
  const f = fixture()
  try {
    const p = join(f.dir, 'a.bin'); writeFileSync(p, 'A')
    const b = createBatchFromPlan(f.db, trashPlan([p]), { path: f.dir }, scannedFor([p]))
    writeFileSync(p, 'LONGER-CONTENT-AFTER-SCAN')
    const dry = dryRun(f.db, f.guard, b.batchId)
    assert.ok((dry.blocked || []).length >= 1, 'stale 门必须把变化项拦进 blocked')
    assert.match(String(dry.blocked[0].reason), /重新扫描|变化/)
  } finally { f.db.close(); rmSync(f.dir, { recursive: true, force: true }) }
})

test('dryRun：无 clean 锁的普通批次不受 stale 门影响（回归）', () => {
  const f = fixture()
  try {
    const p = join(f.dir, 'a.bin'); writeFileSync(p, 'A')
    const b = createBatchFromPlan(f.db, trashPlan([p]), { path: f.dir })
    assert.equal(dryRun(f.db, f.guard, b.batchId).items[0].status, 'ready')
  } finally { f.db.close(); rmSync(f.dir, { recursive: true, force: true }) }
})

test('execute：dryRun 后文件变化 → TOCTOU stale 复检拦下，文件仍在（不删）', () => {
  const f = fixture()
  try {
    const p = join(f.dir, 'a.bin'); writeFileSync(p, 'A')
    const b = createBatchFromPlan(f.db, trashPlan([p]), { path: f.dir }, scannedFor([p]))
    dryRun(f.db, f.guard, b.batchId)
    writeFileSync(p, 'CHANGE-AFTER-DRYRUN')
    const ex = execute(f.db, f.guard, b.batchId, [b.items[0].id], {})
    const it = ex.items[0]
    assert.equal(it.status, 'skipped')
    assert.match(String(it.error), /重新扫描|变化/, 'TOCTOU 复检必须先于 confirmTrash 拦下')
    assert.equal(existsSync(p), true, '文件必须还在')
  } finally { f.db.close(); rmSync(f.dir, { recursive: true, force: true }) }
})

function mockRes() {
  return { statusCode: 200, headersSent: false, headers: {}, _body: null,
    setHeader(k, v) { this.headers[k] = v },
    end(body) { this._body = body; this.headersSent = true },
    json() { return this._body ? JSON.parse(this._body) : null } }
}
function mockReq(method, path, body, headers) {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : []
  return { method, url: path, headers: headers || {}, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c } }
}
async function setup(reject) {
  let handler = null
  const ctx = {
    _services: { connection: { requestRejection: () => reject || undefined } },
    get(name) { return this._services[name] },
    effect(fn) { return fn() },
    webServer: { register(desc) { handler = desc.handler; return () => {} } }
  }
  hostMod.apply(ctx)
  return async (method, path, body, headers) => {
    const res = mockRes()
    await handler(mockReq(method, path, body, headers), res)
    return { status: res.statusCode, body: res.json() }
  }
}

test('host：GET clean/candidates 200 且结构完整', async () => {
  const call = await setup()
  const r = await call('GET', '/flowfile/clean/candidates')
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.body.candidates))
  assert.ok(r.body.summary)
})

test('host：POST clean/plan 空候选/越界路径不建批次', async () => {
  const call = await setup()
  const empty = await call('POST', '/flowfile/clean/plan', { paths: [] })
  assert.equal(empty.status, 200)
  assert.ok(!empty.body.batchId)
  const bad = await call('POST', '/flowfile/clean/plan', { paths: ['/etc/passwd'] })
  assert.ok(!bad.body.batchId)
})

test('host：clean 路由受 CSRF 与鉴权约束', async () => {
  const call = await setup()
  assert.equal((await call('POST', '/flowfile/clean/plan', { paths: [] }, { 'sec-fetch-site': 'cross-site' })).status, 403)
  const unauth = await setup(401)
  assert.equal((await unauth('GET', '/flowfile/clean/candidates')).status, 401)
})

// 清理专属接缝闭合：带 clean.scanned 锁的 trash 批次能完整复用既有执行门（不误杀 → 真删 → 可恢复）。
// 只碰测试自造的 tmpdir 夹具文件；trash 后立即 undo 移回，finally 清理，零触碰用户既有文件。
test('清理批次全链路：clean.scanned 锁一致 → dry-run ready → confirmTrash 进回收站 → RESTORE-MANIFEST → undo 逐字节恢复', () => {
  const f = fixture()
  try {
    const a = join(f.dir, 'clean-me.bin')
    writeFileSync(a, 'CLEAN-CONTENT')
    const h = sha256(readFileSync(a))
    const b = createBatchFromPlan(f.db, trashPlan([a]), { path: f.dir }, scannedFor([a]))
    const dry = dryRun(f.db, f.guard, b.batchId)
    assert.equal(dry.items[0].status, 'ready', '锁一致时 dry-run 不误杀')
    const ex = execute(f.db, f.guard, b.batchId, b.items.map(x => x.id), { confirmTrash: true })
    assert.equal(ex.status, 'done')
    assert.equal(existsSync(a), false, '确认后源应消失')
    const done = ex.items.find(x => x.status === 'done')
    assert.ok(done && done.trash_path && existsSync(done.trash_path), '回收站落点真实存在')
    const mf = join(homedir(), '.flowfile', 'RESTORE-MANIFEST-' + b.batchId + '.json')
    assert.equal(existsSync(mf), true, '应生成 RESTORE-MANIFEST')
    const u = undo(f.db, f.guard, b.batchId)
    assert.equal(u.status, 'rolled_back')
    assert.equal(existsSync(a), true, '撤销后回到原位')
    assert.equal(sha256(readFileSync(a)), h, '撤销后逐字节一致')
  } finally { resetTrashDeps(); f.db.close(); rmSync(f.dir, { recursive: true, force: true }) }
})

test('bundle：第 6 tab / FF_CleanPanel / clean-core 符号 / defaultChecked 接线', () => {
  const src = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')
  const fakeReact = { createElement: () => ({}), useState: () => [null, () => {}], useEffect: () => {}, useRef: () => ({ current: null }) }
  const window = { __ModuleLoader__: { load(desc) { window.__factory = desc.factory } } }
  const probe = src.replace('return module.exports}});', 'window.__probe={FF_TABS:FF_TABS,FF_CleanPanel:FF_CleanPanel,cleanMergeCandidates:cleanMergeCandidates,cleanScanStamp:cleanScanStamp};return module.exports}});')
  const req = (name) => { if (name === 'react') return fakeReact; throw new Error('unexpected require: ' + name) }
  new Function('window', 'require', probe)(window, req)
  window.__factory(req)
  const p = window.__probe
  assert.ok(Array.isArray(p.FF_TABS) && p.FF_TABS.some(t => t.id === 'clean'), 'FF_TABS 必须有第 6 个 clean tab')
  assert.equal(typeof p.FF_CleanPanel, 'function')
  assert.equal(typeof p.cleanMergeCandidates, 'function')
  assert.equal(typeof p.cleanScanStamp, 'function')
  assert.match(src, /defaultChecked/, 'hookPlan 必须支持默认不勾参数')
})
