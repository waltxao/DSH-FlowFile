// 第2轮 ② P0：右键菜单「新建文件夹」全链路执行门。
// 坐实 §2.4：AI/菜单只出 planned 批次 → dry-run → 人确认（approvedIds）→ 执行 → 可撤销；撤销后逐字节可恢复。
// 夹具隔离：恢复清单写临时 HOME，删除走 mock trash（本机绝对路径）。
process.env.HOME = mkdtempSync(join(tmpdir(), 'ff-menu-home-'))

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, basename } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ff-menu-exec-'))
const { openDb } = await import('../src/db.js')
const { createGuard } = await import('../src/path-guard.js')
const { buildMenuBatch } = await import('../src/ops-browse.js')
const { dryRun, execute, undo } = await import('../src/ops.js')
const { setTrashDeps } = await import('../src/trash.js')
const trashcan = join(dir, 'trashcan'); mkdirSync(trashcan)
let trashSeq = 0
// 真实 trash 对同名文件会避让；mock 也用序号保证落点唯一，否则 undo 阶段二次 trash 会覆盖前一次落点
setTrashDeps((src) => { const dest = join(trashcan, (++trashSeq) + '-' + basename(src)); renameSync(src, dest); return '# Moved "' + src + '" to "' + dest + '"' })

test('新建文件夹：planned → dry-run → execute（目录出现）→ undo（目录消失）', () => {
  const db = openDb(join(dir, 'exec.db'))
  const guard = createGuard([dir, homedir(), '/Volumes'])
  const target = join(dir, '新建文件夹')
  const batch = buildMenuBatch(db, guard, { action: 'newFolder', path: dir, newName: '新建文件夹' })
  assert.equal(existsSync(target), false, '建批次阶段不落盘')

  const dry = dryRun(db, guard, batch.batchId)
  assert.equal(dry.items.length, 1)
  assert.equal(dry.items[0].status, 'ready')
  assert.equal(dry.items[0].dst, target)
  assert.equal(existsSync(target), false, 'dry-run 阶段不落盘')

  const ids = dry.items.map(x => Number(x.id))
  const done = execute(db, guard, batch.batchId, ids, {})
  assert.equal(done.status, 'done')
  assert.equal(done.items.filter(x => x.status === 'done').length, 1)
  assert.equal(existsSync(target), true, '确认执行后目录才出现')

  const undone = undo(db, guard, batch.batchId)
  assert.equal(undone.status, 'rolled_back')
  assert.equal(existsSync(target), false, '撤销后目录消失（只删空目录，绝不递归）')
})

test('新建文件夹：目标已存在时 dry-run 拦截，执行拒绝', () => {
  const db = openDb(join(dir, 'exec2.db'))
  const guard = createGuard([dir, homedir(), '/Volumes'])
  const target = join(dir, '已存在')
  mkdirSync(target)
  const batch = buildMenuBatch(db, guard, { action: 'newFolder', path: dir, newName: '已存在' })
  const dry = dryRun(db, guard, batch.batchId)
  assert.equal(dry.items.length, 0)
  assert.equal(dry.blocked.length, 1)
  assert.match(dry.blocked[0].reason, /已存在/)
  const r = execute(db, guard, batch.batchId, [1], {})
  assert.equal(r.items[0].status, 'skipped', '被拦截项即使被勾选也绝不执行')
  assert.equal(existsSync(target), true, '原目录不受影响')
})

test('移到废纸篓：菜单计划带 requiresExplicitTrash，execute 无 confirmTrash 时跳过', () => {
  const db = openDb(join(dir, 'exec3.db'))
  const guard = createGuard([dir, homedir(), '/Volumes'])
  const f = join(dir, 'a.txt'); writeFileSync(f, 'AAA')
  const batch = buildMenuBatch(db, guard, { action: 'trash', path: dir, selection: [f] })
  assert.equal(batch.plan.groups[0].requiresExplicitTrash, true)
  const dry = dryRun(db, guard, batch.batchId)
  assert.equal(dry.items.length, 1)
  // 不给二次确认 → 跳过，文件仍在
  const r1 = execute(db, guard, batch.batchId, [Number(dry.items[0].id)], {})
  assert.equal(r1.items[0].status, 'skipped')
  assert.equal(existsSync(f), true)
})

test('冲突替换：旧文件先进回收站再复制，undo 后旧文件逐字节恢复', () => {
  const db = openDb(join(dir, 'exec4.db'))
  const guard = createGuard([dir, homedir(), '/Volumes'])
  const dstDir = join(dir, 'dst'); mkdirSync(dstDir)
  const src = join(dir, 'src.txt'); writeFileSync(src, 'NEW-CONTENT')
  const dst = join(dstDir, 'src.txt'); writeFileSync(dst, 'OLD-CONTENT')
  const batch = buildMenuBatch(db, guard, { action: 'paste', path: dstDir,
    clipboard: { mode: 'copy', paths: [src] }, conflict: 'replace', entries: [{ path: dst, name: 'src.txt' }] })
  // 第一组是 trash 旧文件，第二组是 copy
  assert.equal(batch.plan.groups[0].op, 'trash')
  assert.equal(batch.plan.groups[1].op, 'copy')
  const dry = dryRun(db, guard, batch.batchId)
  const ids = dry.items.filter(x => x.status === 'ready').map(x => Number(x.id))
  const done = execute(db, guard, batch.batchId, ids, { confirmTrash: true })
  assert.equal(done.status, 'done')
  assert.equal(existsSync(dst), true)
  // 复制的内容是 NEW（旧文件已进回收站，副本写入）
  assert.equal(readFileSync(dst, 'utf8'), 'NEW-CONTENT')
  const undone = undo(db, guard, batch.batchId)
  assert.equal(undone.status, 'rolled_back')
  assert.equal(readFileSync(dst, 'utf8'), 'OLD-CONTENT', 'undo 后旧文件逐字节恢复')
})

test('清理测试临时目录', () => { rmSync(dir, { recursive: true, force: true }); assert.equal(existsSync(dir), false) })
