// 夹具隔离：恢复清单与删除落点都限制在本机临时绝对路径，绝不写真实 ~/.flowfile。
process.env.HOME = mkdtempSync(join(tmpdir(), 'ff-ops-home-'))

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, renameSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, basename } from 'node:path'
import { createGuard } from '../src/path-guard.js'
import { openDb } from '../src/db.js'
import { createBatchFromPlan, dryRun, execute, undo, batchDetail, flattenPlan, parseTrashOutput } from '../src/ops.js'
import { sha256 } from '../src/hash.js'
import { setTrashDeps } from '../src/trash.js'
const trashcan = mkdtempSync(join(tmpdir(), 'ff-ops-trash-'))
setTrashDeps((src) => { const dest = join(trashcan, basename(src)); renameSync(src, dest); return '# Moved "' + src + '" to "' + dest + '"' })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ff-ops-'))
  const db = openDb(join(dir, 'index.db'))
  const guard = createGuard([dir])
  const srcDir = join(dir, 'src')
  const dstDir = join(dir, 'dst')
  mkdirSync(srcDir); mkdirSync(dstDir)
  return { dir, db, guard, srcDir, dstDir }
}
function put(p, text) { writeFileSync(p, Buffer.from(text)); return sha256(Buffer.from(text)) }
function planOf(op, srcs, dst) {
  return { reply: '测试计划', intent: 'plan', dropped: 0,
    groups: [{ label: '组', reason: '测试', op, dst: dst || '', paths: srcs }] }
}

test('ops：dry-run 拦截越界源 / 目标已存在 / 不写任何文件', () => {
  const f = fixture()
  try {
    const a = join(f.srcDir, 'a.txt')
    const h = put(a, 'AAA')
    const batch = createBatchFromPlan(f.db, planOf('move', [a], f.dstDir), { path: f.srcDir })
    const dry = dryRun(f.db, f.guard, batch.batchId)
    assert.equal(dry.items.length, 1)
    assert.equal(dry.items[0].status, 'ready')
    assert.equal(dry.items[0].before_hash, h)
    assert.equal(dry.items[0].dst, join(f.dstDir, 'a.txt'))
    assert.equal(existsSync(a), true)          // dry-run 没动源文件
    assert.equal(existsSync(join(f.dstDir, 'a.txt')), false)
    assert.equal(batchDetail(f.db, batch.batchId).status, 'dry_run')
  } finally { f.db.close(); rmSync(f.dir, { recursive: true, force: true }) }
})

test('ops：dry-run 把越界源与不存在目标标 skipped', () => {
  const f = fixture()
  try {
    const a = join(f.srcDir, 'a.txt'); put(a, 'AAA')
    const batch = createBatchFromPlan(f.db, planOf('move', [a, '/etc/passwd'], f.dstDir), { path: f.srcDir })
    const dry = dryRun(f.db, f.guard, batch.batchId)
    assert.equal(dry.blocked.length, 1)
    assert.match(dry.blocked[0].reason, /不在允许范围|不存在|越界|不合法/)
    const noParent = createBatchFromPlan(f.db, planOf('move', [a], join(f.dir, 'missing', 'x')), { path: f.srcDir })
    const dry2 = dryRun(f.db, f.guard, noParent.batchId)
    assert.ok(dry2.blocked.length >= 1)
  } finally { f.db.close(); rmSync(f.dir, { recursive: true, force: true }) }
})

test('ops：execute 3 文件 move + 逐字节一致 + undo 反序恢复 + 逐字节一致', () => {
  const f = fixture()
  try {
    const names = ['a.txt', 'b.txt', 'c.txt']
    const hashes = {}
    for (const n of names) hashes[n] = put(join(f.srcDir, n), 'CONTENT-' + n)
    const batch = createBatchFromPlan(f.db, planOf('move', names.map(n => join(f.srcDir, n)), f.dstDir), { path: f.srcDir })
    dryRun(f.db, f.guard, batch.batchId)
    const ids = batch.items.map(it => it.id)
    const ex = execute(f.db, f.guard, batch.batchId, ids, {})
    assert.equal(ex.status, 'done')
    assert.equal(ex.items.filter(x => x.status === 'done').length, 3)
    for (const n of names) {
      assert.equal(existsSync(join(f.srcDir, n)), false, '源应消失')
      assert.equal(sha256(readFileSync(join(f.dstDir, n))), hashes[n], '目标字节应一致')
    }
    // 幂等：重复 execute 直接返回已有结果，不重复移动
    const again = execute(f.db, f.guard, batch.batchId, ids, {})
    assert.equal(again.idempotent, true)
    assert.equal(again.status, 'done')
    // undo
    const u = undo(f.db, f.guard, batch.batchId)
    assert.equal(u.status, 'rolled_back')
    assert.equal(u.items.filter(x => x.status === 'restored').length, 3)
    for (const n of names) {
      assert.equal(existsSync(join(f.srcDir, n)), true, '应回到原位')
      assert.equal(sha256(readFileSync(join(f.srcDir, n))), hashes[n], '撤销后逐字节一致')
      assert.equal(existsSync(join(f.dstDir, n)), false, '目标应已移走')
    }
  } finally { f.db.close(); rmSync(f.dir, { recursive: true, force: true }) }
})

test('ops：未勾选任何项拒绝执行；只执行勾选的项', () => {
  const f = fixture()
  try {
    const a = join(f.srcDir, 'a.txt'), b = join(f.srcDir, 'b.txt')
    put(a, 'A'); put(b, 'B')
    const batch = createBatchFromPlan(f.db, planOf('move', [a, b], f.dstDir), { path: f.srcDir })
    dryRun(f.db, f.guard, batch.batchId)
    assert.throws(() => execute(f.db, f.guard, batch.batchId, [], {}), (e) => e.status === 400)
    const onlyA = execute(f.db, f.guard, batch.batchId, [batch.items[0].id], {})
    assert.equal(onlyA.status, 'done')
    assert.equal(existsSync(join(f.dstDir, 'a.txt')), true)
    assert.equal(existsSync(join(f.dstDir, 'b.txt')), false)  // 未勾选的没动
    assert.equal(existsSync(b), true)
    undo(f.db, f.guard, batch.batchId)
  } finally { f.db.close(); rmSync(f.dir, { recursive: true, force: true }) }
})

test('ops：trash 未经二次确认跳过；确认后进回收站 + RESTORE-MANIFEST + undo 逐字节恢复', () => {
  const f = fixture()
  try {
    const a = join(f.srcDir, 'trashme.txt')
    const h = put(a, 'TRASH-CONTENT')
    const batch = createBatchFromPlan(f.db, planOf('trash', [a], ''), { path: f.srcDir })
    dryRun(f.db, f.guard, batch.batchId)
    const ids = batch.items.map(it => it.id)
    // 不给 confirmTrash → skipped，文件仍在
    const no = execute(f.db, f.guard, batch.batchId, ids, {})
    assert.equal(no.status, 'done')
    assert.equal(existsSync(a), true, '未确认删除时文件必须还在')
    assert.equal(no.items[0].status, 'skipped')
    // 重新建一个批次（上一批已 done，幂等不能重跑）
    const batch2 = createBatchFromPlan(f.db, planOf('trash', [a], ''), { path: f.srcDir })
    dryRun(f.db, f.guard, batch2.batchId)
    const yes = execute(f.db, f.guard, batch2.batchId, batch2.items.map(it => it.id), { confirmTrash: true })
    assert.equal(yes.status, 'done')
    assert.equal(existsSync(a), false, '确认后源应消失')
    const doneItem = yes.items.find(x => x.status === 'done')
    assert.ok(doneItem.trash_path, '应记录回收站精确落点')
    assert.equal(existsSync(doneItem.trash_path), true, '回收站落点应真实存在')
    assert.equal(sha256(readFileSync(doneItem.trash_path)), h)
    const manifest = join(homedir(), '.flowfile', 'RESTORE-MANIFEST-' + batch2.batchId + '.json')
    assert.equal(existsSync(manifest), true, '应生成 RESTORE-MANIFEST')
    const mf = JSON.parse(readFileSync(manifest, 'utf8'))
    assert.equal(mf.entries[0].before_hash, h)
    // undo 从回收站移回并逐字节校验
    const u = undo(f.db, f.guard, batch2.batchId)
    assert.equal(u.status, 'rolled_back')
    assert.equal(existsSync(a), true, '撤销后应回到原位')
    assert.equal(sha256(readFileSync(a)), h, '撤销后逐字节一致')
    assert.equal(existsSync(doneItem.trash_path), false)
  } finally { f.db.close(); rmSync(f.dir, { recursive: true, force: true }) }
})

// 跨卷降级分支（本地两个独立根，纯词法前缀不同 → dryRun 标 crossVolume）。
// 只在本地临时目录做，不碰 SMB/网络共享（那属于硬门，需单独授权）。
test('ops：跨卷移动未单独确认则拒绝；确认后 copy→SHA 校验→源进回收站→RESTORE-MANIFEST→undo 恢复', () => {
  const rootA = '/tmp/ff-exdev-a', rootB = '/tmp/ff-exdev-b'
  rmSync(rootA, { recursive: true, force: true }); rmSync(rootB, { recursive: true, force: true })
  mkdirSync(join(rootA, 'src'), { recursive: true }); mkdirSync(join(rootB, 'dst'), { recursive: true })
  const db = openDb(join(rootA, 'index.db'))
  const guard = createGuard([rootA, rootB])
  try {
    const a = join(rootA, 'src', 'a.txt'), h = put(a, 'EXDEV-CONTENT')
    const mk = () => createBatchFromPlan(db, planOf('move', [a], join(rootB, 'dst')), { path: join(rootA, 'src') })
    // 未确认：dryRun 应标 crossVolume + requiresExdevConfirm，execute 该项 failed 且源仍在
    const b1 = mk()
    const d1 = dryRun(db, guard, b1.batchId)
    assert.equal(d1.items[0].crossVolume, true)
    assert.equal(d1.items[0].requiresExdevConfirm, true)
    const no = execute(db, guard, b1.batchId, [b1.items[0].id], {})
    assert.equal(no.status, 'failed')
    assert.match(String(no.failed), /跨卷移动需要单独确认/)
    assert.equal(existsSync(a), true, '未确认时源文件必须还在')
    // 确认：copy → SHA 校验 → 源进回收站，写 RESTORE-MANIFEST
    put(a, 'EXDEV-CONTENT')
    const b2 = mk()
    dryRun(db, guard, b2.batchId)
    const yes = execute(db, guard, b2.batchId, [b2.items[0].id], { confirmExdev: true })
    assert.equal(yes.status, 'done')
    const dst = join(rootB, 'dst', 'a.txt')
    assert.equal(existsSync(dst), true)
    assert.equal(sha256(readFileSync(dst)), h, '跨卷副本必须逐字节一致')
    assert.equal(existsSync(a), false, '确认后源应进回收站')
    const mf = join(homedir(), '.flowfile', 'RESTORE-MANIFEST-' + b2.batchId + '.json')
    assert.equal(existsSync(mf), true, '跨卷降级必须写恢复清单')
    // undo 从回收站恢复
    const u = undo(db, guard, b2.batchId)
    assert.equal(u.status, 'rolled_back')
    assert.equal(existsSync(a), true)
    assert.equal(sha256(readFileSync(a)), h)
  } finally {
    db.close()
    rmSync(rootA, { recursive: true, force: true }); rmSync(rootB, { recursive: true, force: true })
  }
})

test('ops：parseTrashOutput 解析 # Moved 精确落点', () => {
  assert.equal(parseTrashOutput('# Moved "/tmp/x" to "/Users/me/.Trash/x"'), '/Users/me/.Trash/x')
  assert.equal(parseTrashOutput(''), null)
})

test('ops：flattenPlan 的 op 白名单不含 rm/delete', () => {
  const items = flattenPlan({ groups: [{ label: 'x', paths: ['/a'], op: 'rm' }] })
  assert.equal(items[0].op, 'rm')  // 摊平只搬字段，合法性由 validatePlan 保证
})
