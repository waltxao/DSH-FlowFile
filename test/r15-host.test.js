// 第 15 轮 host 侧接线验证：/presets、/preset、以及「目标目录不存在 → 自动补 mkdir」的自愈。
// 用 mock ctx 走真实路由表（同 browse-host.test.js 的做法），不需要重启 DSH。
process.env.HOME = '/tmp/ff-r15-home'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import hostMod from '../src/host.js'
import { createGuard } from '../src/path-guard.js'
import { buildPresetPlan, injectMkdirItems, listPresets } from '../src/presets.js'
import { OPS } from '../src/plan.js'

const dir = mkdtempSync(join(tmpdir(), 'ff-r15-'));
process.env.FLOWFILE_DB = join(dir, 'index.db')
process.env.FLOWFILE_ROOTS = dir
mkdirSync(join(dir, 'docs'))
writeFileSync(join(dir, 'docs', 'a.md'), 'x')
writeFileSync(join(dir, 'docs', 'b.md'), 'y')
writeFileSync(join(dir, 'docs', 'c.png'), 'z')

function mockRes() {
  return { statusCode: 200, headersSent: false, headers: {}, _body: null,
    setHeader(k, v) { this.headers[k] = v },
    end(body) { this._body = body; this.headersSent = true },
    json() { return this._body ? JSON.parse(this._body) : null } }
}
function mockReq(method, path, body, headers) {
  const chunks = body ? [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))] : []
  return { method, url: path, headers: headers || {}, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c } }
}
async function setup() {
  let handler = null
  const ctx = {
    _services: { connection: { requestRejection: () => undefined } },
    get(name) { return this._services[name] },
    effect(fn) { return fn() },
    webServer: { register(d) { handler = d.handler; return () => {} } }
  }
  hostMod.apply(ctx)
  return async (method, path, body, headers) => {
    const res = mockRes()
    await handler(mockReq(method, path, body, headers || { 'sec-fetch-site': 'same-origin' }), res)
    return { status: res.statusCode, body: res.json(), headers: res.headers }
  }
}

test('H1 GET /presets 返回 5 个预设', async () => {
  const call = await setup()
  const r = await call('GET', '/flowfile/presets')
  assert.equal(r.status, 200)
  assert.equal(r.body.presets.length, listPresets().length)
  assert.ok(r.body.presets.some(p => p.id === 'by-type'))
})

test('H2 POST /preset by-type 产出可执行批次，并自动补 mkdir', async () => {
  const call = await setup()
  const r = await call('POST', '/flowfile/preset', { id: 'by-type', path: join(dir, 'docs') })
  assert.equal(r.status, 200)
  assert.ok(r.body.batchId, '应建批次，实际 ' + JSON.stringify(r.body).slice(0, 200))
  assert.equal(r.body.at, join(dir, 'docs'))
  assert.ok(r.body.items.length >= 3, '至少 3 项（1 mkdir + 2 move），实际 ' + r.body.items.length)
  const ops = r.body.items.map(i => i.op)
  assert.ok(ops.includes('mkdir'), '目标目录不存在时应自动补 mkdir，实际 ' + JSON.stringify(ops))
})

test('H3 POST /preset 不存在的 id 返回 empty 而不是 500', async () => {
  const call = await setup()
  const r = await call('POST', '/flowfile/preset', { id: 'nope', path: join(dir, 'docs') })
  assert.equal(r.status, 200)
  assert.equal(r.body.batchId, null)
  assert.equal(r.body.empty, true)
})

test('H4 injectMkdirItems 在真实 fs 上只补一层，不越权', () => {
  const plan = { reply: 'x', groups: [{ label: 'g', reason: 'r', op: 'move', dst: join(dir, 'docs', 'md'), paths: [join(dir, 'docs', 'a.md')] }] }
  const out = injectMkdirItems(plan, { dir: join(dir, 'docs'), existsFn: (p) => { try { statSync(p); return true } catch (e) { return false } }, allowedFn: () => true })
  assert.equal(out.groups.length, 2)
  assert.equal(out.groups[0].op, 'mkdir')
  const deep = injectMkdirItems({ groups: [{ label: 'g', reason: 'r', op: 'move', dst: join(dir, 'docs', 'x', 'y'), paths: [join(dir, 'docs', 'a.md')] }] }, { dir: join(dir, 'docs'), existsFn: () => false, allowedFn: () => true })
  assert.equal(deep.groups.length, 1, '两级新目录不自动补（避免凭空造层级）')
})

test('H5 OPS 含 mkdir，且 mkdir 在 plan 校验里不会被丢弃', () => {
  assert.ok(OPS.has('mkdir'))
  const p = buildPresetPlan('big-files', join(dir, 'docs'), [{ path: join(dir, 'docs', 'big.bin'), name: 'big.bin', size: 200 * 1024 * 1024, isDir: false }])
  assert.ok(p && p.groups.length === 1)
  assert.equal(p.groups[0].dst, join(dir, 'docs') + '/_大文件')
})
