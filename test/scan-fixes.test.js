// P1.6 真机复验发现的三处缺陷的回归测试（只读 / 临时目录）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fullHashSync, fullHashAsync } from '../src/hash.js'
import { openDb } from '../src/db.js'
import { ScanManager } from '../src/index.js'

function tmpDir() { return mkdtempSync(join(tmpdir(), 'ff-scanfix-')) }

// 缺陷 A：fullHashSync 同步读整文件会冻结 Electron 主进程；改用异步版且结果必须逐字节一致。
test('hash：fullHashAsync 与 fullHashSync 结果完全一致，超大文件标 skipped_large', async () => {
  const dir = tmpDir()
  try {
    const p = join(dir, 'a.bin')
    const buf = Buffer.alloc(300 * 1024 + 7)
    for (let i = 0; i < buf.length; i++) buf[i] = i % 251
    writeFileSync(p, buf)
    const sync = fullHashSync(p, buf.length)
    const async = await fullHashAsync(p, buf.length)
    assert.equal(sync.state, 'full')
    assert.equal(async.state, 'full')
    assert.equal(async.hash, sync.hash, '异步哈希必须与同步版字节级一致')
    const huge = await fullHashAsync(p, 2 * 1024 * 1024 * 1024 + 1)
    assert.equal(huge.state, 'skipped_large')
    assert.equal(huge.hash, null)
    // 取消必须真的停：shouldStop 返回 true 时立即返回 cancelled，不读完整个文件。
    const t0 = Date.now()
    const stopped = await fullHashAsync(p, buf.length, () => true)
    assert.equal(stopped.state, 'cancelled')
    assert.ok(Date.now() - t0 < 2000, 'shouldStop 生效时应立即返回')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// 缺陷 B：扫描完成后 active 残留 → 同目录重扫永远 409。
test('ScanManager：同一目录可连续重扫两次，结束后 active 清空', async () => {
  const dir = tmpDir()
  let db = null
  try {
    const small = join(dir, 'data')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(small)
    writeFileSync(join(small, 'a.txt'), 'AAA')
    writeFileSync(join(small, 'b.txt'), 'BBB')
    db = openDb(join(dir, 'index.db'))
    const guard = { roots: [dir], isAllowed: () => true, assertAllowed: (p) => p }
    const scans = new ScanManager(db, guard)
    const wait = async (id) => {
      for (let i = 0; i < 100; i++) {
        const st = scans.status(id)
        if (st && (st.state === 'done' || st.state === 'cancelled' || st.state === 'failed')) return st
        await new Promise(r => setTimeout(r, 20))
      }
      return scans.status(id)
    }
    const id1 = scans.start(small, { meta: false })
    const st1 = await wait(id1)
    assert.equal(st1.state, 'done')
    assert.equal(st1.done, 2)
    assert.equal(scans.active.size, 0, 'done 后必须移出 active')
    const id2 = scans.start(small, { meta: false })   // 修复前这里抛 409
    assert.ok(id2 && id2 !== id1)
    const st2 = await wait(id2)
    assert.equal(st2.state, 'done', '第二次扫描必须能完成（增量失效）')
    assert.equal(scans.active.size, 0)
  } finally { try { db && db.close() } catch (e) {} rmSync(dir, { recursive: true, force: true }) }
})

// 缺陷 A/C 的静态护栏：index.js 只能用异步哈希；client 刷新时必须 rehook 历史计划卡片。
test('静态护栏：index.js 用 fullHashAsync（无同步全量哈希），client-app.js 刷新时 hookPlan', () => {
  const idx = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.ok(idx.includes('fullHashAsync'), 'index.js 必须走异步哈希')
  assert.ok(idx.includes('partialHashAsync'), 'index.js 必须走异步部分哈希')
  assert.ok(!idx.includes('fullHashSync('), 'index.js 不得再调用同步全量哈希')
  assert.ok(!idx.includes('readdirSync('), 'index.js 不得再同步 readdir（SMB 上会冻结主进程）')
  assert.ok(!idx.includes('lstatSync('), 'index.js 不得再同步 lstat')
  assert.ok(!idx.includes('realpathSync('), 'index.js 不得再同步 realpath')
  assert.ok(idx.includes('setImmediate('), 'start() 必须把 _run 从 HTTP 请求里解耦')
  assert.ok(idx.includes('() => state.aborted'), 'fullHashAsync 必须传入取消判据，避免取消后哈希任务继续占线程池')
  assert.ok(idx.includes('this.active.delete(id)'), '必须清理 active')
  assert.ok(idx.includes('done % 5 === 0'), '必须每 5 个文件让出事件循环')
  const app = readFileSync(new URL('../src/client-app.js', import.meta.url), 'utf8')
  assert.ok(app.includes('hookPlan(p)'), '历史消息加载后必须重新接上计划卡片回调')
})
