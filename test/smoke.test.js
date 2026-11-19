import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'

// host 冒烟：所有路由经 mock ctx 走一遍；DB 落临时目录，绝不碰 ~/.flowfile 真库。
// 本机 mount 在 /sbin，测试 PATH 未必包含；补上才能复现 /Volumes 挂载卷列表。
process.env.PATH = '/sbin:' + (process.env.PATH || '')
const dir = mkdtempSync(join(tmpdir(), 'ff-smoke-'))
process.env.FLOWFILE_DB = join(dir, 'index.db')
process.env.FLOWFILE_ROOTS = dir   // 让扫描测试的临时目录落在允许根内
const mod = (await import('../src/host.js')).default
const { requestRejection } = await import('../src/host.js')

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
  mod.apply(ctx)
  return async (method, path, body, headers) => {
    const res = mockRes()
    await handler(mockReq(method, path, body, headers), res)
    return { status: res.statusCode, body: res.json() }
  }
}

test('host 鉴权：拿不到 connection 一律 403', () => {
  const res = mockRes()
  const r = requestRejection({ get: () => undefined }, { headers: {} })
  assert.equal(r, 403)
  void res
})

test('host 冒烟：volumes / list / meta / search / duplicates / timeline / batches / chat/history', async () => {
  const call = await setup()
  const v = await call('GET', '/flowfile/volumes')
  assert.equal(v.status, 200)
  assert.equal(v.body.mode, 'flowfile')
  assert.ok(v.body.volumes.length >= 1)
  assert.ok(v.body.volumes.some(x => x.path.indexOf('/Volumes/') === 0), '应列出 /Volumes 下的挂载卷')

  const home = homedir()
  const l = await call('GET', '/flowfile/list?path=' + encodeURIComponent(home))
  assert.equal(l.status, 200)
  assert.equal(l.body.path, home)
  assert.ok(Array.isArray(l.body.entries))
  assert.equal(l.body.groups.length, 8)

  const bad = await call('GET', '/flowfile/list?path=' + encodeURIComponent('/etc'))
  assert.equal(bad.status, 403)
  assert.match(bad.body.error, /不在允许范围/)

  const m = await call('GET', '/flowfile/meta?path=' + encodeURIComponent(home))
  assert.equal(m.status, 200)
  assert.equal(m.body.isDir, true)
  assert.ok(Array.isArray(m.body.finderTags))
  assert.ok(Array.isArray(m.body.timeline))

  const s = await call('GET', '/flowfile/search?q=x')
  assert.equal(s.status, 200)
  assert.ok(Array.isArray(s.body.entries))
  const d = await call('GET', '/flowfile/duplicates')
  assert.equal(d.status, 200)
  assert.ok(Array.isArray(d.body.groups))
  const tl = await call('GET', '/flowfile/timeline?limit=10')
  assert.equal(tl.status, 200)
  assert.ok(Array.isArray(tl.body.events))
  const b = await call('GET', '/flowfile/ops/batches')
  assert.equal(b.status, 200)
  assert.ok(Array.isArray(b.body.batches))
  const ch = await call('GET', '/flowfile/chat/history')
  assert.equal(ch.status, 200)
  assert.ok(Array.isArray(ch.body.messages))
})

test('host 冒烟：方法/CSRF/空消息/405/404', async () => {
  const call = await setup()
  assert.equal((await call('POST', '/flowfile/meta', {})).status, 404)
  assert.equal((await call('GET', '/flowfile/nope')).status, 404)
  assert.equal((await call('PUT', '/flowfile/volumes')).status, 405)
  assert.equal((await call('POST', '/flowfile/plan', { message: '' , path: homedir() })).status, 400)
  assert.equal((await call('POST', '/flowfile/chat', { message: '', path: homedir() })).status, 400)
  // 跨站拒绝
  const cross = await call('POST', '/flowfile/plan', { message: 'x', path: homedir() }, { 'sec-fetch-site': 'cross-site' })
  assert.equal(cross.status, 403)
  // 未授权请求
  const unauth = await setup(401)
  assert.equal((await unauth('GET', '/flowfile/volumes')).status, 401)
})

test('host 冒烟：scan 启动 / 状态 / 取消（不阻塞请求）', async () => {
  const call = await setup()
  // 用 FLOWFILE_ROOTS 根内的极小子目录，绝不扫整个 homedir（会卡住测试进程）
  const small = join(dir, 'scan-small')
  mkdirSync(small, { recursive: true })
  mkdirSync(join(small, 'sub'))
  writeFileSync(join(small, 'a.txt'), 'AAA')
  writeFileSync(join(small, 'sub', 'b.txt'), 'BBB')
  try {
    const s = await call('POST', '/flowfile/scan', { root: small, options: { meta: false } })
    assert.equal(s.status, 200)
    assert.ok(s.body.scanId)
    const st = await call('GET', '/flowfile/scan/status?scanId=' + encodeURIComponent(s.body.scanId))
    assert.equal(st.status, 200)
    assert.ok(['queued', 'running', 'done', 'cancelled'].includes(st.body.state))
    await call('POST', '/flowfile/scan/cancel', { scanId: s.body.scanId })
  } finally { rmSync(small, { recursive: true, force: true }) }
})

test('client bundle：__ModuleLoader__ 导出 apply + inject，id=flowfile', async () => {
  const src = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')
  const fakeReact = { createElement: () => ({}), useState: () => [null, () => {}], useEffect: () => {}, useRef: () => ({ current: null }) }
  let loaded = null
  const window = { __ModuleLoader__: { load(desc) { loaded = desc } } }
  new Function('window', 'require', src)(window, (name) => { if (name === 'react') return fakeReact; throw new Error('unexpected require: ' + name) })
  assert.equal(loaded.id, 'dsh-flowfile')
  const exported = loaded.factory((name) => { if (name === 'react') return fakeReact; throw new Error('unexpected require: ' + name) })
  assert.equal(typeof exported.apply, 'function')
  assert.deepEqual(exported.inject, ['slots'])
  assert.equal(exported.__esModule, true)
})

test('client bundle 装配：browse-core 与新组件符号可达（第2轮 ②）', () => {
  const src = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')
  const fakeReact = { createElement: () => ({}), useState: () => [null, () => {}], useEffect: () => {}, useRef: () => ({ current: null }) }
  const window = { __ModuleLoader__: { load(desc) { window.__factory = desc.factory } } }
  // 在包装内追加断言：把关键函数挂到 window 上带出作用域
  const probe = src.replace('return module.exports}});', 'window.__probe={historyPush,reduceSelection,nextSort,menuFor,statusFor,buildMenuPlan,crumbTrail,FF_NavBar,FF_ContextMenu,FF_StatusBar,FF_Grid,FF_Sidebar,FF_QuickLook,FF_TagEditor,FF_ConflictDialog};return module.exports}});')
  const req = (name) => { if (name === 'react') return fakeReact; throw new Error('unexpected require: ' + name) }
  new Function('window', 'require', probe)(window, req)
  window.__factory(req)          // 真正执行 factory，__probe 才会被赋值
  const p = window.__probe
  for (const k of ['historyPush', 'reduceSelection', 'nextSort', 'menuFor', 'statusFor', 'buildMenuPlan', 'crumbTrail']) assert.equal(typeof p[k], 'function', k + ' 应来自 browse-core.js')
  for (const k of ['FF_NavBar', 'FF_ContextMenu', 'FF_StatusBar', 'FF_Grid', 'FF_Sidebar', 'FF_QuickLook', 'FF_TagEditor', 'FF_ConflictDialog']) assert.equal(typeof p[k], 'function', k + ' 应来自 client-browse.js')
  assert.equal(typeof p.historyPush({ stack: ['/a'], index: 0 }, '/b').stack.length, 'number')
  assert.equal(p.nextSort(null, 'name').key, 'name')
})

test('静态扫描：业务文件写只出现在执行门（ops.js + trash.js），且 trash.js 禁删除原语', async () => {
  const { readdirSync, readFileSync } = await import('node:fs')
  const srcDir = new URL('../src/', import.meta.url)
  const files = readdirSync(srcDir, { withFileTypes: true }).filter(d => d.isFile() && d.name.endsWith('.js')).map(d => d.name)
  // 只匹配「实际调用形态」name( ... )；plan.js 的 OPS 白名单/提示词里出现 trash/rename 等词不算写调用。
  const writeCall = /\b(renameSync|copyFileSync|rmSync|unlinkSync|writeFileSync|appendFileSync|mkdirSync|rmdirSync|trash)\s*\(/
  // 执行门：唯一允许写业务文件的两个模块；trash.js 是删除执行门（SMB 同卷降级）。
  const GATE = new Set(['ops.js', 'trash.js'])
  const offenders = []
  for (const f of files) {
    if (GATE.has(f)) continue
    const code = readFileSync(new URL('../src/' + f, import.meta.url), 'utf8')
    const hits = code.split('\n').map((line, i) => ({ line, i: i + 1 }))
      .filter(x => !/^\s*\/\//.test(x.line) && writeCall.test(x.line))
    // db.js 唯一允许：mkdirSync(dir) 建 ~/.flowfile 自有库目录
    const allowed = f === 'db.js' && hits.every(x => /mkdirSync\s*\(/.test(x.line))
    // settings.js（第 17 轮 m07721）也允许写 —— 但只允许写插件自有配置 ~/.flowfile/settings.json，
    // 且必须同时出现 mkdirSync 与 writeFileSync（建目录 + 写文件），不涉及任何业务文件。
    const settingsOk = f === 'settings.js' && hits.every(x => /mkdirSync\s*\(|writeFileSync\s*\(/.test(x.line))
    // ql-thumb.js（第 20 轮 m10399 缩略图）：QuickLook 子进程产物必须落盘才能缓存，
    // 但只允许写两处自有缓存——~/.flowfile/thumbs 与 os.tmpdir() 的临时目录，绝不碰业务文件。
    const qlOk = f === 'ql-thumb.js' &&
      /homedir\(\), '\.flowfile', 'thumbs'/.test(readFileSync(new URL('../src/' + f, import.meta.url), 'utf8')) &&
      /tmpdir\(\)/.test(readFileSync(new URL('../src/' + f, import.meta.url), 'utf8')) &&
      hits.every(x => /mkdirSync\s*\(|writeFileSync\s*\(|renameSync\s*\(|copyFileSync\s*\(|rmSync\s*\(|unlinkSync\s*\(/.test(x.line))
    const allowed2 = allowed || settingsOk || qlOk
    if (hits.length && !allowed2) offenders.push(f + ':' + hits.map(x => x.i).join(','))
  }
  assert.deepEqual(offenders, [], '业务文件写只应出现在执行门 ops.js/trash.js：' + offenders.join(' | '))
  // 更严：删除执行门也不得出现任何永久删除原语（只能同卷 renameSync 进自建回收站）。
  const trashCode = readFileSync(new URL('../src/trash.js', import.meta.url), 'utf8')
  const delNames = ['rmSync(', 'unlinkSync(', 'rmdirSync(', 'unlink(', 'rm -rf']
  for (const name of delNames) {
    assert.equal(trashCode.indexOf(name), -1, 'trash.js 禁止永久删除原语 ' + name)
  }
})
