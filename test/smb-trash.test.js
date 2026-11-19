// 夹具隔离：恢复清单落临时 HOME，绝不写本机 ~/.flowfile。
process.env.HOME = mkdtempSync(join(tmpdir(), 'ff-smb-home-'))

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { createGuard } from '../src/path-guard.js'
import { openDb } from '../src/db.js'
import { createBatchFromPlan, dryRun, execute, undo, parseTrashOutput } from '../src/ops.js'
import { sha256 } from '../src/hash.js'
import { volumeRootOf, isNoTrashError, trashFile, setTrashDeps, resetTrashDeps } from '../src/trash.js'

// 真机实测错误串（2026-11-15 /Volumes/QuickSwap trash -v RC=5），保留弯引号与全部特征码。
const NO_TRASH_MSG = '2026-11-15 00:56:07.999 trash[60499:9549058] # Error attempting to move /Volumes/QuickSwap/.flowfile-smb-trash-probe-20261115 to the trash folder, Error Domain=NSCocoaErrorDomain Code=3328 \u201c.flowfile-smb-trash-probe-20261115\u201d couldn\u2019t be moved to the trash because the volume \u201cQuickSwap\u201d doesn\u2019t have one. UserInfo={NSURL=file:///Volumes/QuickSwap/.flowfile-smb-trash-probe-20261115, NSUserStringVariant=Trash, NSUnderlyingError=0x7786c94600 {Error Domain=NSOSStatusErrorDomain Code=-120 \u201cdirNFErr: Directory not found\u201d}}'

function noTrashRunner() {
  const e = new Error('Command failed: trash -v <src> (exit 5)')
  e.stdout = ''
  e.stderr = NO_TRASH_MSG
  e.status = 5
  throw e
}
function otherRunner() {
  const e = new Error('Command failed: trash -v <src> (exit 1)')
  e.stdout = ''
  e.stderr = 'EACCES: permission denied, trash binary not usable'
  e.status = 1
  throw e
}
function put(p, text) { writeFileSync(p, Buffer.from(text)); return sha256(Buffer.from(text)) }
function planOf(op, srcs, dst) {
  return { reply: '测试计划', intent: 'plan', dropped: 0,
    groups: [{ label: '组', reason: '测试', op, dst: dst || '', paths: srcs }] }
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ff-smbtrash-'))
  const db = openDb(join(dir, 'index.db'))
  const guard = createGuard([dir])
  const srcDir = join(dir, 'src')
  mkdirSync(srcDir)
  return { dir, db, guard, srcDir }
}
function cleanup(f) { try { f.db.close() } catch (e) {} rmSync(f.dir, { recursive: true, force: true }) }
function dropManifest(batchId) {
  try { unlinkSync(join(homedir(), '.flowfile', 'RESTORE-MANIFEST-' + batchId + '.json')) } catch (e) {}
}

test('smb-trash：volumeRootOf 只认 /Volumes/<卷>，其余返回 null', () => {
  assert.equal(volumeRootOf('/Volumes/QuickSwap/a/b.txt'), '/Volumes/QuickSwap')
  assert.equal(volumeRootOf('/Volumes/000_文档和书籍/01/x.pdf'), '/Volumes/000_文档和书籍')
  assert.equal(volumeRootOf('/Volumes'), null)
  assert.equal(volumeRootOf('/Volumes/QuickSwap'), null)
  assert.equal(volumeRootOf('/Users/waltxao/a.txt'), null)
  assert.equal(volumeRootOf('relative/a.txt'), null)
})

test('smb-trash：isNoTrashError 命中 3328 / dirNFErr / 卷无废纸篓，不命中普通错误', () => {
  assert.equal(isNoTrashError(NO_TRASH_MSG), true)
  assert.equal(isNoTrashError('NSCocoaErrorDomain Code=3328'), true)
  assert.equal(isNoTrashError('dirNFErr: Directory not found Code=-120'), true)
  assert.equal(isNoTrashError('EACCES: permission denied'), false)
  assert.equal(isNoTrashError(''), false)
  assert.equal(isNoTrashError(null), false)
})

test('smb-trash：parseTrashOutput 仍由 ops.js 导出（回归保护）', () => {
  assert.equal(parseTrashOutput('# Moved "/tmp/x" to "/Users/me/.Trash/x"'), '/Users/me/.Trash/x')
  assert.equal(parseTrashOutput(''), null)
})

test('smb-trash：native trash -v 成功 → 返回精确落点，不降级、不建卷内回收站', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-smbtrash-native-'))
  try {
    const src = join(dir, 'a.txt'); put(src, 'AAA')
    const dest = join(dir, '.Trash', 'a.txt')
    mkdirSync(join(dir, '.Trash')); put(dest, 'AAA')
    setTrashDeps(function () { return '# Moved "' + src + '" to "' + dest + '"' }, volumeRootOf)
    const tp = trashFile(src)
    assert.equal(tp, dest)
    assert.equal(existsSync(join(dir, '.flowfile-trash')), false, 'native 成功绝不能降级')
    assert.equal(existsSync(src), true, 'trashFile 不自己搬文件，runner 是假的')
  } finally { resetTrashDeps(); rmSync(dir, { recursive: true, force: true }) }
})

test('smb-trash：native 报了落点但落点不存在 → 中止（不降级为 rm）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-smbtrash-missing-'))
  try {
    const src = join(dir, 'a.txt'); put(src, 'AAA')
    setTrashDeps(function () { return '# Moved "x" to "/nonexistent/ff-trash/x"' }, () => dir)
    assert.throws(() => trashFile(src), /中止|落点|不降级/)
    assert.equal(existsSync(src), true)
    assert.equal(existsSync(join(dir, '.flowfile-trash')), false)
  } finally { resetTrashDeps(); rmSync(dir, { recursive: true, force: true }) }
})

test('smb-trash：卷无废纸篓 → 降级到同卷 .flowfile-trash + 卷内 RESTORE-MANIFEST', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-smbtrash-fb-'))
  try {
    const src = join(dir, 'a.txt'); const h = put(src, 'FALLBACK-CONTENT')
    setTrashDeps(noTrashRunner, () => dir)
    const tp = trashFile(src)
    assert.ok(tp.indexOf(join(dir, '.flowfile-trash') + '/') === 0, '落点必须在卷根 .flowfile-trash 内')
    assert.equal(existsSync(src), false, '源应被同卷原子移走')
    assert.equal(existsSync(tp), true)
    assert.equal(sha256(readFileSync(tp)), h, '逐字节一致')
    const mf = join(dir, '.flowfile-trash', 'RESTORE-MANIFEST.json')
    assert.equal(existsSync(mf), true, '卷内自管恢复清单必须存在')
    const doc = JSON.parse(readFileSync(mf, 'utf8'))
    assert.equal(doc.entries.length, 1)
    assert.equal(doc.entries[0].src, src)
    assert.equal(doc.entries[0].trash_path, tp)
    assert.equal(doc.entries[0].mode, 'fallback')
    assert.equal(doc.entries[0].volume, dir)
  } finally { resetTrashDeps(); rmSync(dir, { recursive: true, force: true }) }
})

test('smb-trash：非「无废纸篓」错误一律中止，不降级、不 rm、文件原封不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-smbtrash-other-'))
  try {
    const src = join(dir, 'a.txt'); const h = put(src, 'KEEP-ME')
    setTrashDeps(otherRunner, () => dir)
    assert.throws(() => trashFile(src))
    assert.equal(existsSync(src), true)
    assert.equal(sha256(readFileSync(src)), h)
    assert.equal(existsSync(join(dir, '.flowfile-trash')), false, '普通错误绝不触发降级目录')
  } finally { resetTrashDeps(); rmSync(dir, { recursive: true, force: true }) }
})

test('smb-trash：非 /Volumes 路径即使报无废纸篓也不降级（降级只允许 SMB 卷）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-smbtrash-local-'))
  try {
    const src = join(dir, 'a.txt'); put(src, 'LOCAL')
    setTrashDeps(noTrashRunner, volumeRootOf)   // 默认词法卷根：/tmp/... → null
    assert.throws(() => trashFile(src), /中止|不降级|不允许/)
    assert.equal(existsSync(src), true)
    assert.equal(existsSync(join(dir, '.flowfile-trash')), false)
  } finally { resetTrashDeps(); rmSync(dir, { recursive: true, force: true }) }
})

test('smb-trash：同卷多文件降级落点唯一、卷内 manifest 累计、互不覆盖', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-smbtrash-multi-'))
  try {
    const a = join(dir, 'a.txt'), b = join(dir, 'a.txt.dup')
    const ha = put(a, 'AAA'), hb = put(b, 'BBB')
    setTrashDeps(noTrashRunner, () => dir)
    const ta = trashFile(a), tb = trashFile(b)
    assert.notEqual(ta, tb, '落点必须唯一，不能互相覆盖')
    assert.equal(sha256(readFileSync(ta)), ha)
    assert.equal(sha256(readFileSync(tb)), hb)
    const doc = JSON.parse(readFileSync(join(dir, '.flowfile-trash', 'RESTORE-MANIFEST.json'), 'utf8'))
    assert.equal(doc.entries.length, 2)
  } finally { resetTrashDeps(); rmSync(dir, { recursive: true, force: true }) }
})

test('smb-trash：execute 降级 → trash_path 落卷内回收站 → RESTORE-MANIFEST → undo 逐字节恢复', () => {
  const f = fixture()
  let batchId = null
  try {
    const a = join(f.srcDir, 'trashme.txt'); const h = put(a, 'SMB-TRASH-E2E')
    setTrashDeps(noTrashRunner, () => f.dir)   // 把临时目录当 SMB 卷根注入
    const batch = createBatchFromPlan(f.db, planOf('trash', [a], ''), { path: f.srcDir })
    batchId = batch.batchId
    dryRun(f.db, f.guard, batch.batchId)
    const ex = execute(f.db, f.guard, batch.batchId, batch.items.map(i => i.id), { confirmTrash: true })
    assert.equal(ex.status, 'done')
    assert.equal(existsSync(a), false, '确认删除后源应消失')
    const it = ex.items.find(x => x.status === 'done')
    assert.ok(it.trash_path, '必须记录精确落点')
    assert.ok(it.trash_path.indexOf('/.flowfile-trash/') > 0, '落点必须是卷内自建回收站')
    assert.equal(existsSync(it.trash_path), true)
    assert.equal(sha256(readFileSync(it.trash_path)), h)
    const hm = join(homedir(), '.flowfile', 'RESTORE-MANIFEST-' + batch.batchId + '.json')
    assert.equal(existsSync(hm), true, 'ops 侧恢复清单仍应生成')
    assert.equal(JSON.parse(readFileSync(hm, 'utf8')).entries[0].before_hash, h)
    const u = undo(f.db, f.guard, batch.batchId)
    assert.equal(u.status, 'rolled_back')
    assert.equal(existsSync(a), true, '撤销后应回到原位')
    assert.equal(sha256(readFileSync(a)), h, '撤销后逐字节一致')
    assert.equal(existsSync(it.trash_path), false, '落点应已被移走')
  } finally { resetTrashDeps(); dropManifest(batchId); cleanup(f) }
})

test('smb-trash：未经二次确认的降级路径仍跳过，文件不动', () => {
  const f = fixture()
  let batchId = null
  try {
    const a = join(f.srcDir, 'keep.txt'); put(a, 'KEEP')
    setTrashDeps(noTrashRunner, () => f.dir)
    const batch = createBatchFromPlan(f.db, planOf('trash', [a], ''), { path: f.srcDir })
    batchId = batch.batchId
    dryRun(f.db, f.guard, batch.batchId)
    const ex = execute(f.db, f.guard, batch.batchId, batch.items.map(i => i.id), {})
    assert.equal(ex.items[0].status, 'skipped')
    assert.equal(existsSync(a), true)
    assert.equal(existsSync(join(f.dir, '.flowfile-trash')), false)
  } finally { resetTrashDeps(); dropManifest(batchId); cleanup(f) }
})
