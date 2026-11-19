// 第 2 轮 ③：AI 让用户自主选模型（host / api / client / llm 四处接线）。
// 失败测试先行：断言 GET models 状态形状、不在线 provider 标不可用、POST 白名单校验、
// 写 model.json 前备份可恢复、auto 归档不硬删、以及 host 冒烟路由存在。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { modelState, setModelOverride, clearRouteCache, readOverride, modelConfigPath, isTextModel } from '../src/llm.js'

const DIR = mkdtempSync(join(tmpdir(), 'ff-models-'))
process.env.FLOWFILE_MODEL_PATH = join(DIR, 'model.json')

const PROVIDERS = [{ id: 'agnes-ai' }, { id: 'deepseek-official' }, { id: 'ghost-provider' }]
const MODELS = {
  'agnes-ai': [{ id: 'agnes-2.5-flash' }, { id: 'agnes-image-2.5-flash' }],
  'deepseek-official': [{ id: 'deepseek-flash' }],
}

function mockCtx(o) {
  const opt = o || {}
  return {
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => opt.default || { provider: 'workbuddy', model: 'hy4free' } }
      if (name === 'llm') return {
        async listProviders() { return opt.providers || PROVIDERS },
        async listModels(id) {
          if (opt.failProviders && opt.failProviders.includes(id)) throw new Error('provider offline')
          return (opt.models && opt.models[id]) || MODELS[id] || []
        },
      }
      return undefined
    },
  }
}

function clean() {
  clearRouteCache()
  const p = modelConfigPath()
  if (existsSync(p)) rmSync(p)
  const bak = p + '.bak'
  if (existsSync(bak)) rmSync(bak)
}

test('③ 导出：modelState / setModelOverride / clearRouteCache / modelConfigPath', () => {
  assert.equal(typeof modelState, 'function')
  assert.equal(typeof setModelOverride, 'function')
  assert.equal(typeof clearRouteCache, 'function')
  assert.equal(typeof modelConfigPath, 'function')
  assert.ok(modelConfigPath().endsWith('model.json'))
})

test('③ GET models：列文本模型 + 跟随宿主默认 + 当前 route，图像/hy4 被排除', async () => {
  clean()
  const s = await modelState(mockCtx())
  assert.equal(s.mode, 'flowfile')
  assert.equal(s.autoLabel, '跟随宿主默认')
  assert.equal(s.override, null)
  assert.equal(s.overrideAvailable, true)
  assert.ok(s.current && s.current.provider && s.current.model)
  assert.ok(isTextModel(s.current.model), '当前路由必须是可流式文本模型')
  assert.notEqual(s.current.model, 'hy4free')
  const agnes = s.routes.find(r => r.provider === 'agnes-ai')
  assert.ok(agnes.models.includes('agnes-2.5-flash'))
  assert.ok(!agnes.models.includes('agnes-image-2.5-flash'), '图像模型不得出现在下拉里')
})

test('③ 不在线 provider 标「不可用」而非静默回落/隐藏', async () => {
  clean()
  const s = await modelState(mockCtx({ failProviders: ['ghost-provider'] }))
  const ghost = s.routes.find(r => r.provider === 'ghost-provider')
  assert.ok(ghost, '列不出模型的 provider 也必须出现在清单里')
  assert.equal(ghost.available, false)
  assert.equal(ghost.models.length, 0)
  assert.equal(s.routes.find(r => r.provider === 'agnes-ai').available, true)
})

test('③ POST model：不在清单里的 provider/model 一律 400，不静默写入', async () => {
  clean()
  await assert.rejects(
    () => setModelOverride(mockCtx(), { provider: 'ghost-provider', model: 'anything' }),
    (e) => e.status === 400 && /不在可用清单/.test(e.message)
  )
  await assert.rejects(
    () => setModelOverride(mockCtx(), { provider: 'agnes-ai', model: 'agnes-image-2.5-flash' }),
    (e) => e.status === 400
  )
  assert.equal(existsSync(modelConfigPath()), false, '非法值不得落盘')
})

test('③ POST model：写合法值 → model.json 只含 provider/model，readOverride 生效，状态回传', async () => {
  clean()
  const r = await setModelOverride(mockCtx(), { provider: 'agnes-ai', model: 'agnes-2.5-flash' })
  assert.equal(r.ok, true)
  assert.equal(r.action, 'set')
  assert.equal(r.backupPath, null, '首次写入没有旧文件可备份')
  const raw = JSON.parse(readFileSync(modelConfigPath(), 'utf8'))
  assert.deepEqual(Object.keys(raw).sort(), ['model', 'provider'], '配置只写两个 id，不带任何文件内容')
  assert.deepEqual(raw, { provider: 'agnes-ai', model: 'agnes-2.5-flash' })
  assert.deepEqual(readOverride(), { provider: 'agnes-ai', model: 'agnes-2.5-flash' })
  assert.deepEqual(r.override, { provider: 'agnes-ai', model: 'agnes-2.5-flash' })
  assert.equal(r.overrideAvailable, true)
  assert.deepEqual(r.current, { provider: 'agnes-ai', model: 'agnes-2.5-flash' })
  assert.equal(r.autoLabel, '跟随宿主默认')
})

test('③ POST model：二次写入先备份上一版（可恢复清单）', async () => {
  clean()
  await setModelOverride(mockCtx(), { provider: 'agnes-ai', model: 'agnes-2.5-flash' })
  const r2 = await setModelOverride(mockCtx(), { provider: 'deepseek-official', model: 'deepseek-flash' })
  assert.ok(r2.backupPath && r2.backupPath.endsWith('.bak'))
  assert.equal(existsSync(r2.backupPath), true)
  const bak = JSON.parse(readFileSync(r2.backupPath, 'utf8'))
  assert.deepEqual(bak, { provider: 'agnes-ai', model: 'agnes-2.5-flash' }, '备份必须是上一版')
})

test('③ 钉住值不再可用 → 标 overrideAvailable=false，current 回落但不假装已切换', async () => {
  clean()
  await setModelOverride(mockCtx(), { provider: 'agnes-ai', model: 'agnes-2.5-flash' })
  const s = await modelState(mockCtx({ providers: [{ id: 'deepseek-official' }], models: { 'deepseek-official': [{ id: 'deepseek-flash' }] } }))
  assert.deepEqual(s.override, { provider: 'agnes-ai', model: 'agnes-2.5-flash' })
  assert.equal(s.overrideAvailable, false, '必须如实标注钉住的模型不可用')
  assert.notDeepEqual(s.current, s.override, 'current 是回落后的真实路由，不能假装还钉着')
})

test('③ POST model auto：归档不硬删，readOverride 回到 null', async () => {
  clean()
  await setModelOverride(mockCtx(), { provider: 'agnes-ai', model: 'agnes-2.5-flash' })
  const r = await setModelOverride(mockCtx(), { auto: true })
  assert.equal(r.ok, true)
  assert.equal(r.action, 'cleared')
  assert.equal(readOverride(), null)
  assert.equal(r.override, null)
  assert.ok(r.backupPath && existsSync(r.backupPath), '旧配置归档到 .bak 而不是硬删')
  const bak = JSON.parse(readFileSync(r.backupPath, 'utf8'))
  assert.equal(bak.provider, 'agnes-ai')
})

test('③ POST model 空 body 等价 auto（跟随宿主默认）', async () => {
  clean()
  await setModelOverride(mockCtx(), { provider: 'agnes-ai', model: 'agnes-2.5-flash' })
  const r = await setModelOverride(mockCtx(), { provider: '', model: '' })
  assert.equal(r.action, 'cleared')
  assert.equal(readOverride(), null)
})

test('③ client bundle：模型下拉/接口命名已装配进 dist（不止后端）', async () => {
  const code = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')
  assert.ok(code.includes('function ffModels()'), 'client 必须有 ffModels')
  assert.ok(code.includes('function ffSetModel('), 'client 必须有 ffSetModel')
  assert.ok(code.includes("ffGet('models')"), 'ffModels 走 GET models')
  assert.ok(code.includes("ffPost('model'"), 'ffSetModel 走 POST model')
  assert.ok(code.includes('fd-model'), '对话头必须有模型下拉样式类')
  assert.ok(code.includes('跟随宿主默认'), '下拉必须有跟随宿主默认选项')
  assert.ok(code.includes('onModel'), 'FD_App 必须把 onModel 传给 FF_Chat')
})

test('③ 静态护栏：llm.js 配置写入只用 promises 异步 API，无任何 Sync 文件写调用', async () => {
  const code = readFileSync(new URL('../src/llm.js', import.meta.url), 'utf8')
  const syncWrite = /\b(writeFileSync|appendFileSync|renameSync|unlinkSync|mkdirSync|rmdirSync|copyFileSync|rmSync)\s*\(/
  assert.equal(syncWrite.test(code), false, 'Electron 主进程不得同步写文件')
  assert.ok(code.includes("from 'node:fs/promises'") || code.includes('from "node:fs/promises"'))
})

test('③ host 冒烟：GET /flowfile/models 200、POST /flowfile/model 非法 400、CSRF 仍生效', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-modelhost-'))
  process.env.FLOWFILE_DB = join(dir, 'index.db')
  process.env.FLOWFILE_ROOTS = dir
  process.env.FLOWFILE_MODEL_PATH = join(dir, 'model.json')
  const mod = (await import('../src/host.js')).default
  function mockRes() {
    return { statusCode: 200, headersSent: false, headers: {}, _body: null,
      setHeader(k, v) { this.headers[k] = v }, end(b) { this._body = b; this.headersSent = true },
      json() { return this._body ? JSON.parse(this._body) : null } }
  }
  function mockReq(method, path, body, headers) {
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : []
    return { method, url: path, headers: headers || {}, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c } }
  }
  let handler = null
  const ctx = {
    _services: { connection: { requestRejection: () => undefined } },
    get(n) { return this._services[n] }, effect(fn) { return fn() },
    webServer: { register(d) { handler = d.handler; return () => {} } },
  }
  mod.apply(ctx)
  const call = async (method, path, body, headers) => {
    const res = mockRes()
    await handler(mockReq(method, path, body, headers), res)
    return { status: res.statusCode, body: res.json() }
  }
  const g = await call('GET', '/flowfile/models')
  assert.equal(g.status, 200)
  assert.equal(g.body.mode, 'flowfile')
  assert.ok(Array.isArray(g.body.routes))
  assert.equal(g.body.autoLabel, '跟随宿主默认')
  const bad = await call('POST', '/flowfile/model', { provider: 'ghost', model: 'x' })
  assert.equal(bad.status, 400)
  const csrf = await call('POST', '/flowfile/model', { auto: true }, { 'sec-fetch-site': 'cross-site' })
  assert.equal(csrf.status, 403)
  rmSync(dir, { recursive: true, force: true })
})
