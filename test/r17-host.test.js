// 第 17 轮 host 侧接线验证：设置读写、上传策略、识别缓存、auto 标签、预识别开关。
process.env.HOME = '/tmp/ff-r17h-home'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import hostMod from '../src/host.js'
import { openDb, tagsFor } from '../src/db.js'
import { createGuard } from '../src/path-guard.js'

const dir = mkdtempSync(join(tmpdir(), 'ff-r17-host-'))
process.env.FLOWFILE_DB = join(dir, 'index.db')
process.env.FLOWFILE_ROOTS = dir
process.env.FLOWFILE_HOME = join(dir, 'home')
writeFileSync(join(dir, 'a.png'), 'x')
writeFileSync(join(dir, 'b.md'), 'y')

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
  return async (method, path, body) => {
    const res = mockRes()
    await handler(mockReq(method, path, body, { 'sec-fetch-site': 'same-origin' }), res)
    return { status: res.statusCode, body: res.json() }
  }
}

test('H17-1 GET /settings：默认识别关闭、不上传', async () => {
  const call = await setup()
  const r = await call('GET', '/flowfile/settings')
  assert.equal(r.status, 200)
  assert.equal(r.body.settings.ai.mode, 'off')
  assert.equal(r.body.settings.ai.allowCloud, false)
  assert.equal(r.body.settings.recognize.preScan, false)
  assert.equal(r.body.uplink.allowed, false)
  assert.ok(/识别已关闭/.test(r.body.uplink.reason))
})

test('H17-2 POST /settings：非法 mode 被收敛回 off，host 模式不带 allowCloud 仍拒绝上传', async () => {
  const call = await setup()
  const bad = await call('POST', '/flowfile/settings', { settings: { ai: { mode: 'cloud-evil' } } })
  assert.equal(bad.body.settings.ai.mode, 'off')
  const host = await call('POST', '/flowfile/settings', { settings: { ai: { mode: 'host' } } })
  assert.equal(host.body.settings.ai.mode, 'host')
  assert.equal(host.body.settings.ai.allowCloud, false)
  assert.equal(host.body.uplink.allowed, false, '没有 allowCloud 就不许上传')
  const ok = await call('POST', '/flowfile/settings', { settings: { ai: { mode: 'host', allowCloud: true } } })
  assert.equal(ok.body.uplink.allowed, true)
  assert.equal(ok.body.uplink.uplink, 'cloud')
})

test('H17-3 local 模式指向非 loopback 被拒绝', async () => {
  const call = await setup()
  const r = await call('POST', '/flowfile/settings', { settings: { ai: { mode: 'local', localBaseUrl: 'http://192.168.1.9:11434/v1' } } })
  assert.equal(r.body.settings.ai.mode, 'local')
  assert.equal(r.body.uplink.allowed, false)
  assert.ok(/回环/.test(r.body.uplink.reason))
})

test('H17-4 识别关闭时不调模型：返回规则卡片 + 白名单标签，并写入 auto 标签', async () => {
  const call = await setup()
  await call('POST', '/flowfile/settings', { settings: { ai: { mode: 'off' }, recognize: { autoTags: true } } })
  const r = await call('POST', '/flowfile/recognize/cached', { path: join(dir, 'a.png') })
  assert.equal(r.status, 200)
  assert.equal(r.body.modelUsed, false, 'off 模式必须 modelUsed=false')
  assert.equal(r.body.uplink, 'none')
  assert.ok(r.body.card && r.body.card.what, '应有规则卡片')
  assert.ok(Array.isArray(r.body.tags) && r.body.tags.indexOf('图片') >= 0, 'png 应派生「图片」标签，实际 ' + JSON.stringify(r.body.tags))
})

test('H17-5 第二次识别命中缓存（cached=true，不重建卡片）', async () => {
  const call = await setup()
  await call('POST', '/flowfile/settings', { settings: { ai: { mode: 'off' } } })
  const first = await call('POST', '/flowfile/recognize/cached', { path: join(dir, 'b.md') })
  assert.equal(first.body.cached, false)
  const second = await call('POST', '/flowfile/recognize/cached', { path: join(dir, 'b.md') })
  assert.equal(second.body.cached, true)
  assert.equal(second.body.card.what, first.body.card.what)
})

test('H17-6 预识别关闭时 /recognize/prescan 直接 skipped，不做任何模型调用', async () => {
  const call = await setup()
  await call('POST', '/flowfile/settings', { settings: { recognize: { preScan: false } } })
  const r = await call('POST', '/flowfile/recognize/prescan', { path: dir })
  assert.equal(r.status, 200)
  assert.equal(r.body.skipped, true)
  assert.equal(r.body.items.length, 0)
})

test('H17-7 预识别开启 + 识别关闭时仍 skipped（因为没有授权任何模型）', async () => {
  const call = await setup()
  await call('POST', '/flowfile/settings', { settings: { ai: { mode: 'off' }, recognize: { preScan: true } } })
  const r = await call('POST', '/flowfile/recognize/prescan', { path: dir })
  assert.equal(r.body.skipped, true)
  assert.ok(/识别已关闭/.test(r.body.reason))
})
