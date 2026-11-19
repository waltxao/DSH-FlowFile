// 第2轮 ② P0 host/ops 接缝失败测试先行。
// 判别性契约：新 GET 路由存在且 404/405 正确；menuPlan 只建 planned 批次不执行；mkdir 经执行门且可撤销。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ff-browse-host-'))
process.env.FLOWFILE_DB = join(dir, 'index.db')
process.env.FLOWFILE_ROOTS = dir
const mod = (await import('../src/host.js')).default
const { ensureOps, buildMenuBatch, capacityOf, thumbFor } = await import('../src/ops-browse.js')
const { createGuard } = await import('../src/path-guard.js')

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
  mod.apply(ctx)
  return async (method, path, body, headers) => {
    const res = mockRes()
    await handler(mockReq(method, path, body, headers), res)
    return { status: res.statusCode, body: res.json(), headers: res.headers }
  }
}

test('ensureOps：OPS 增加 mkdir，plan.js 校验器放行 mkdir 且只认白名单路径', async () => {
  ensureOps()
  const { OPS, validatePlan } = await import('../src/plan.js')
  assert.equal(OPS.has('mkdir'), true)
  const guard = createGuard([dir, homedir(), '/Volumes'])
  const p = join(dir, 'new')
  const r = validatePlan({ reply: 'x', groups: [{ op: 'mkdir', dst: p, paths: [dir] }] }, [dir], { guard, existsFn: () => true })
  assert.equal(r.groups.length, 1)
  assert.equal(r.groups[0].op, 'mkdir')
  assert.equal(r.groups[0].dst, p)
  const bad = validatePlan({ reply: 'x', groups: [{ op: 'mkdir', dst: '/etc/evil', paths: [dir] }] }, [dir], { guard, existsFn: () => true })
  assert.equal(bad.groups[0].dst, '', '越界目标被清空，绝不落到 /etc')
  assert.equal(bad.dropped, 0)
})

test('buildMenuBatch：菜单动作落成 planned 批次，绝不执行、不写业务文件', async () => {
  const { openDb } = await import('../src/db.js')
  const db = openDb(join(dir, 'menu.db'))
  const guard = createGuard([dir, homedir(), '/Volumes'])
  const src = join(dir, 'a.txt'); writeFileSync(src, 'AAA')
  const r = buildMenuBatch(db, guard, { action: 'newFolder', path: dir, newName: '新文件夹' })
  assert.ok(r.batchId)
  assert.equal(r.plan.intent, 'plan')
  assert.equal(r.plan.groups[0].op, 'mkdir')
  assert.equal(r.items.length, 1)
  assert.equal(existsSync(join(dir, '新文件夹')), false, '建批次阶段绝不真的建目录')
  const { getBatch } = await import('../src/db.js')
  assert.equal(getBatch(db, r.batchId).status, 'planned')
})

test('capacityOf：返回 total/free/used 且 free 不超 total', () => {
  const c = capacityOf('/tmp')
  assert.equal(c.ok, true)
  assert.ok(c.total > 0)
  assert.ok(c.free >= 0 && c.free <= c.total)
  assert.equal(c.used, c.total - c.free)
  assert.ok(c.pct >= 0 && c.pct <= 100)
})

test('thumbFor：图片返回尺寸与 data URL，非图片/越界返回错误', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPQiNqCFTEMLQkAJYpNgeZwIfcAAAAASUVORK5CYII=', 'base64')
  const img = join(dir, 'one.png'); writeFileSync(img, png)
  const guard = createGuard([dir, homedir(), '/Volumes'])
  const t = await thumbFor(guard, img, 64)
  assert.equal(t.ok, true)
  assert.match(t.dataUrl, /^data:image\/png;base64,/)
  assert.ok(t.width > 0 && t.height > 0)
  const bad = await thumbFor(guard, join(dir, 'missing.png'), 64)
  assert.equal(bad.ok, false)
  const outside = await thumbFor(guard, '/etc/hosts', 64)
  assert.equal(outside.ok, false)
})

test('host 冒烟：GET capacity / GET tags / POST ops/menu-plan 判别性', async () => {
  const call = await setup()
  const cap = await call('GET', '/flowfile/capacity?path=' + encodeURIComponent(homedir()))
  assert.equal(cap.status, 200)
  assert.ok(cap.body.total > 0)
  const tags = await call('GET', '/flowfile/tags')
  assert.equal(tags.status, 200)
  assert.ok(Array.isArray(tags.body.tags))
  const mp = await call('POST', '/flowfile/ops/menu-plan', { action: 'newFolder', path: dir, newName: 'X' })
  assert.equal(mp.status, 200)
  assert.ok(mp.body.batchId)
  assert.equal(mp.body.plan.readOnly, false)
  assert.equal(mp.body.items.length, 1)
  assert.equal(existsSync(join(dir, 'X')), false)
  // 跨站保护对新路由同样生效
  const cross = await call('POST', '/flowfile/ops/menu-plan', { action: 'newFolder', path: dir, newName: 'Y' }, { 'sec-fetch-site': 'cross-site' })
  assert.equal(cross.status, 403)
  // 非法动作 400，不建批次
  const bad = await call('POST', '/flowfile/ops/menu-plan', { action: 'nope', path: dir })
  assert.equal(bad.status, 400)
  // GET thumb 越界
  const th = await call('GET', '/flowfile/thumb?path=' + encodeURIComponent('/etc/hosts') + '&w=64')
  assert.notEqual(th.status, 200)
})
