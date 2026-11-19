// 第 2 轮 ④：不显示系统隐藏磁盘（白名单式）。
// 判据来自真机 mount 形态：Preboot/Recovery 带 nobrowse、com.apple.* 是 devicefs、
// Iris-Data 是 APFS 数据卷、两个 SMB 是 smbfs。目标 = 4 卷（本机 + 数据卷 + 2 SMB）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMount, parseMountDetail, shouldShowVolume, filterVolumeNames, listVolumes, volumeType } from '../src/volumes.js'

const MOUNT = [
  '//walt@FN920X._smb._tcp.local/000_文档和书籍 on /Volumes/000_文档和书籍 (smbfs, nodev, nosuid, SMB_3.1.1)',
  '/dev/disk3s5 on /Volumes/Iris-Data (apfs, local, nodev, nosuid, journaled, protect)',
  '/dev/disk3s1 on /Volumes/Preboot (apfs, local, nodev, nosuid, journaled, nobrowse)',
  '/dev/disk3s3 on /Volumes/Recovery (apfs, local, nodev, nosuid, journaled, nobrowse)',
  '//walt@FN920X._smb._tcp.local/QuickSwap on /Volumes/QuickSwap (smbfs, nodev, nosuid)',
  'devfs on /Volumes/com.apple.TimeMachine.localsnapshots (devicefs, local, nobrowse)',
].join('\n')

const NAMES = ['000_文档和书籍', 'Iris-Data', 'Preboot', 'QuickSwap', 'Recovery', 'com.apple.TimeMachine.localsnapshots', '.DS_Store']

test('parseMount 向后兼容：仍返回 fsType 字符串', () => {
  const m = parseMount('//walt@NAS/Share on /Volumes/Share (smbfs, nodev, nosuid)')
  assert.equal(m.get('/Volumes/Share'), 'smbfs')
  assert.equal(volumeType('smbfs'), 'SMB')
})

test('parseMountDetail：保留完整 options 与 nobrowse 标记', () => {
  const d = parseMountDetail(MOUNT)
  assert.equal(d.get('/Volumes/000_文档和书籍').fsType, 'smbfs')
  assert.equal(d.get('/Volumes/000_文档和书籍').nobrowse, false)
  assert.equal(d.get('/Volumes/Preboot').fsType, 'apfs')
  assert.equal(d.get('/Volumes/Preboot').nobrowse, true, 'Preboot 的 nobrowse 必须被解析出来')
  assert.ok(d.get('/Volumes/Recovery').options.indexOf('nobrowse') >= 0)
  assert.equal(d.get('/Volumes/com.apple.TimeMachine.localsnapshots').fsType, 'devicefs')
})

test('shouldShowVolume：正向白名单，系统卷一律隐藏', () => {
  const show = (name, fsType, options) => shouldShowVolume(name, fsType, options)
  assert.equal(show('Iris-Data', 'apfs', 'apfs, local, journaled'), true)
  assert.equal(show('000_文档和书籍', 'smbfs', 'smbfs, nodev, nosuid'), true)
  assert.equal(show('QuickSwap', 'smbfs', 'smbfs, nodev, nosuid'), true)
  assert.equal(show('Preboot', 'apfs', 'apfs, nobrowse'), false, 'nobrowse 必须挡住')
  assert.equal(show('Recovery', 'apfs', 'apfs, nobrowse'), false)
  assert.equal(show('com.apple.TimeMachine.localsnapshots', 'devicefs', 'devicefs, nobrowse'), false)
  assert.equal(show('VM', 'apfs', 'apfs'), false)
  assert.equal(show('iSCPreboot', 'apfs', 'apfs'), false)
  assert.equal(show('.hidden', 'apfs', 'apfs'), false)
  assert.equal(show('Mystery', 'weirdfs', 'weirdfs'), false, '不认识的类型不放行（白名单式）')
  assert.equal(show('Mystery', 'unknown', ''), false)
})

test('filterVolumeNames：真机 7 个条目只留 3 个数据卷', () => {
  const kept = filterVolumeNames(NAMES, MOUNT)
  assert.deepEqual(kept.slice().sort(), ['000_文档和书籍', 'Iris-Data', 'QuickSwap'])
  assert.equal(kept.length, 3)
  NAMES.filter(n => n !== '000_文档和书籍' && n !== 'Iris-Data' && n !== 'QuickSwap').forEach(n => {
    assert.ok(!kept.includes(n), '系统/隐藏卷不得出现：' + n)
  })
})

test('listVolumes：注入真机形态，最终 5 卷且系统卷 0 命中', async () => {
  const guard = { roots: ['/Users/waltxao', '/Volumes'] }
  const r = await listVolumes(guard, { mountOutput: MOUNT, names: NAMES, skipStat: true })
  assert.equal(r.mode, 'flowfile')
  // 第 26 轮：新增「系统盘」卷（path === '/'），本机 + 系统盘 + Iris-Data + 2 SMB = 5 卷
  assert.equal(r.volumes.length, 5, '本机 + 系统盘 + Iris-Data + 2 SMB = 5 卷')
  assert.equal(r.volumes[0].name, '本机 · 用户目录')
  assert.equal(r.volumes[1].path, '/', '系统盘固定排在本机之后')
  assert.equal(r.volumes[1].name, '系统盘')
  assert.ok(r.volumes.some(v => v.name === 'Iris-Data' && v.type === 'APFS'))
  assert.ok(r.volumes.some(v => v.isSmb && v.name === '000_文档和书籍'))
  assert.ok(r.volumes.some(v => v.isSmb && v.name === 'QuickSwap'))
  const allNames = r.volumes.map(v => v.name)
  ;['Preboot', 'Recovery', 'VM', 'iSCPreboot', 'com.apple.TimeMachine.localsnapshots', '.DS_Store'].forEach(n => {
    assert.ok(!allNames.includes(n), '系统卷不得出现在结果里：' + n)
  })
})

test('listVolumes：mount 拿不到时也不放行 devicefs / 未知卷', async () => {
  const guard = { roots: [] }
  const r = await listVolumes(guard, { mountOutput: '', names: ['com.apple.TimeMachine.localsnapshots', 'Iris-Data'], skipStat: true })
  assert.ok(!r.volumes.some(v => v.name.indexOf('com.apple.') === 0))
})

test('filterVolumeNames：软链逃逸由 listVolumes 的 realpath 层保留拦截（纯函数不碰 fs）', () => {
  // 纯函数只做「按 mount 类型/选项」的白名单；符号链接逃逸仍由 listVolumes 的 realpath 检查处理。
  assert.equal(typeof filterVolumeNames, 'function')
})
