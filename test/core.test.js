import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyEntry, allGroups, LARGE_FILE_THRESHOLD, extOf, IMAGE_EXTS, TEXT_EXTS } from '../src/rules.js'
import { isAllowed, createGuard, defaultRoots } from '../src/path-guard.js'
import { parseMount, volumeType } from '../src/volumes.js'
import { extractJson } from '../src/llm.js'
import { planSystem, buildUser, validatePlan, OPS } from '../src/plan.js'
import fmt from './helpers-format.cjs'
const { fdSize, fdTime, fdKind, fdBase, fdPct } = fmt
import { homedir } from 'node:os'

const FENCE = String.fromCharCode(96).repeat(3)

test('规则表：文件夹 / 图片 / 大文件 / 未知 / 8 类', () => {
  assert.equal(classifyEntry('Some.dir', 0, true)[0].name, '文件夹')
  assert.equal(classifyEntry('a.PNG', 10, false)[0].name, '图片')
  assert.deepEqual(classifyEntry('x.iso', LARGE_FILE_THRESHOLD + 1, false).map(t => t.name), ['归档', '大文件'])
  assert.equal(classifyEntry('noext', 10, false).length, 0)
  assert.equal(allGroups().length, 8)
  assert.equal(extOf('a.TXT'), 'txt')
  assert.ok(IMAGE_EXTS.has('png') && TEXT_EXTS.has('md'))
})

test('路径白名单：允许 home 与 /Volumes，挡越界与凭据', () => {
  const roots = defaultRoots()
  assert.ok(isAllowed(homedir() + '/Downloads', roots))
  assert.ok(isAllowed('/Volumes/QuickSwap', roots))
  assert.equal(isAllowed('/etc/passwd', roots), false)
  assert.equal(isAllowed(homedir() + '/.ssh/id_rsa', roots), false)
  assert.equal(isAllowed('/Volumes/QuickSwap/../../etc', roots), false)
  assert.equal(isAllowed('relative/path', roots), false)
  const guard = createGuard(roots)
  assert.throws(() => guard.assertAllowed('/etc'), (e) => e.status === 403)
  assert.throws(() => guard.assertAllowed(''), (e) => e.status === 400)
  assert.equal(guard.assertAllowed('/Volumes/QuickSwap'), '/Volumes/QuickSwap')
})

test('卷枚举：解析 mount 输出并判 SMB', () => {
  const m = parseMount('//walt@NAS/Share on /Volumes/Share (smbfs, nodev, nosuid)', '\n')
  assert.equal(m.get('/Volumes/Share'), 'smbfs')
  assert.equal(volumeType('smbfs'), 'SMB')
  assert.equal(volumeType('cifs'), 'SMB')
  assert.equal(volumeType('apfs'), 'APFS')
  assert.equal(volumeType(''), 'Unknown')
})

test('LLM extractJson：代码块 / 裸 JSON / 尾部噪声', () => {
  assert.equal(extractJson('好的\n' + FENCE + 'json\n{"a":1}\n' + FENCE).a, 1)
  assert.equal(extractJson('前缀 {"b":2} 后缀').b, 2)
  assert.throws(() => extractJson('完全没有 JSON'))
})

test('plan：system 硬约束 + buildUser 候选 + validatePlan 白名单加严', () => {
  assert.ok(planSystem().indexOf('绝对不能执行') > 0)
  assert.ok([...OPS].includes('trash') && ![...OPS].includes('rm'))
  const user = buildUser('把大文件挑出来', [{ path: '/tmp/a', name: 'a', size: 10, ext: '.txt', tags: [{ name: '文档' }] }], { path: '/tmp' })
  assert.ok(user.indexOf('把大文件挑出来') > 0 && user.indexOf('/tmp/a') > 0)
  const guard = createGuard(['/tmp'])
  const safe = validatePlan({ reply: '好', intent: 'plan', groups: [
    { label: '图片', paths: ['/tmp/a', '/etc/passwd'], reason: '都是图', op: 'move', dst: '/tmp/dst' },
    { label: '空', paths: [], op: 'none' },
    { label: 123, paths: 'not-array', op: 'rm' }
  ] }, ['/tmp/a'], { guard, existsFn: () => true, realpathFn: (p) => p })
  assert.equal(safe.groups.length, 1)
  assert.deepEqual(safe.groups[0].paths, ['/tmp/a'])
  assert.equal(safe.groups[0].op, 'move')
  assert.equal(safe.dropped, 1)
  assert.equal(safe.readOnly, true)
  assert.ok(!['rm', 'delete'].includes(safe.groups[0].op))
  const gone = validatePlan({ reply: '', groups: [{ label: 'x', paths: ['/tmp/a'], op: 'move', dst: '' }] }, ['/tmp/a'], { guard, existsFn: () => false, realpathFn: (p) => p })
  assert.equal(gone.groups.length, 0)
  assert.equal(gone.dropped, 1)
})

test('格式化：fdSize / fdTime / fdKind / fdBase / fdPct', () => {
  assert.equal(fdSize(0), '0 B')
  assert.equal(fdSize(1024), '1.00 KB')
  assert.equal(fdKind({ isDir: true }), '文件夹')
  assert.equal(fdBase('/a/b/c.txt'), 'c.txt')
  assert.equal(fdPct(1, 4), 25)
  assert.equal(fdTime(null), '—')
})
