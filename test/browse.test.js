// 第2轮 ② P0 浏览管理：纯逻辑失败测试先行。全部针对 src/browse-core.js，不依赖 DOM/React/fs。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as C from '../src/browse-core.js'

const E = (name, over) => Object.assign({ path: '/Volumes/QuickSwap/' + name, name, isDir: false,
  size: 100, mtime: '2026-11-13T02:00:00Z', tags: [{ name: '文档', category: 'document' }] }, over || {})
const VOLS = [
  { path: '/Users/demo', name: '本机', type: 'home', isSmb: false },
  { path: '/Volumes/000_文档和书籍', name: '000_文档和书籍', type: 'smbfs', isSmb: true },
  { path: '/Volumes/QuickSwap', name: 'QuickSwap', type: 'smbfs', isSmb: true }
]

test('历史栈：push/back/forward/分支截断/上限 50/去重', () => {
  let h = C.createHistory('/a')
  h = C.historyPush(h, '/b')
  h = C.historyPush(h, '/c')
  assert.equal(C.canBack(h), true)
  assert.equal(C.canForward(h), false)
  const back = C.historyBack(h)
  assert.equal(back.path, '/b')
  assert.equal(C.canForward(back.hist), true)
  const fwd = C.historyForward(back.hist)
  assert.equal(fwd.path, '/c')
  // 从 b 进入 d，c 被截断
  const branch = C.historyPush(back.hist, '/d')
  assert.equal(C.canForward(branch), false)
  assert.deepEqual(branch.stack, ['/a', '/b', '/d'])
  // 重复进入不产生历史
  assert.deepEqual(C.historyPush(branch, '/d').stack, ['/a', '/b', '/d'])
  // 上限
  let big = C.createHistory('/p0')
  for (let i = 1; i <= 80; i++) big = C.historyPush(big, '/p' + i)
  assert.equal(big.stack.length, C.FF_HISTORY_MAX)
  assert.equal(big.stack[big.stack.length - 1], '/p80')
  assert.equal(big.index, C.FF_HISTORY_MAX - 1)
})

test('地址栏：绝对路径校验 + 规范化，拒绝 .. 与 ~', () => {
  assert.equal(C.isSafeAddress('/Users/demo/Downloads'), true)
  assert.equal(C.isSafeAddress('/Users/../etc'), false)
  assert.equal(C.isSafeAddress('~/Downloads'), false)
  assert.equal(C.isSafeAddress('relative'), false)
  assert.equal(C.normalizeAddress('  /Volumes/QuickSwap//a/ '), '/Volumes/QuickSwap/a')
  assert.equal(C.normalizeAddress('\\Volumes\\QuickSwap\\a'), '/Volumes/QuickSwap/a')
  assert.equal(C.normalizeAddress('/'), '/')
  assert.equal(C.normalizeAddress(''), '')
})

test('面包屑：首段映射到卷根，onGo("/") 不再是死按钮', () => {
  const t = C.crumbTrail('/Volumes/QuickSwap/教程/一', VOLS)
  assert.equal(t[0].label, 'QuickSwap')
  assert.equal(t[0].path, '/Volumes/QuickSwap')
  assert.equal(t[0].enabled, true)
  assert.equal(t[1].label, '教程')
  assert.equal(t[1].path, '/Volumes/QuickSwap/教程')
  assert.equal(t[2].path, '/Volumes/QuickSwap/教程/一')
  assert.equal(t[2].last, true)
  // 根路径本身
  const r = C.crumbTrail('/Users/demo', VOLS)
  assert.equal(r[0].path, '/Users/demo')
  assert.equal(r.length, 1)
  // 不匹配任何卷时退化到 "/" 但不生成无效点击
  const any = C.crumbTrail('/etc/hosts', VOLS)
  assert.equal(any[0].path, null)
  assert.equal(any[0].enabled, false)
  assert.equal(any[1].label, 'etc')
})

test('多选状态机：click / cmd 增减 / shift 锚点范围 / ⌘A / ⌘⇧A / Esc', () => {
  const order = ['/a', '/b', '/c', '/d'].map(n => '/Volumes/QuickSwap/' + n.slice(1))
  const A = order[0], B = order[1], Cc = order[2], D = order[3]
  let s = C.reduceSelection(C.FF_SEL_CLEAR, { type: 'click', path: A })
  assert.deepEqual(s.selected, [A]); assert.equal(s.anchor, A)
  s = C.reduceSelection(s, { type: 'cmd', path: Cc })
  assert.deepEqual(s.selected, [A, Cc])
  assert.equal(s.anchor, A, '⌘ 增减不移动锚点')
  s = C.reduceSelection(s, { type: 'cmd', path: A })
  assert.deepEqual(s.selected, [Cc])
  s = C.reduceSelection(s, { type: 'shift', path: A, order })
  assert.deepEqual(s.selected, [A], '锚点 A → 点 A = 仅 A')
  s = C.reduceSelection(s, { type: 'shift', path: D, order })
  assert.deepEqual(s.selected, [A, B, Cc, D], '锚点 A → ⇧D = A..D')
  s = C.reduceSelection(s, { type: 'selectAll', order })
  assert.equal(s.selected.length, 4)
  s = C.reduceSelection(s, { type: 'deselectAll', order })
  assert.deepEqual(s.selected, [])
  s = C.reduceSelection(s, { type: 'escape' })
  assert.equal(s.anchor, null)
  void D
})

test('列头排序：三击复原，目录恒在前，name/size/mtime/tags 可用', () => {
  assert.deepEqual(C.nextSort(null, 'name'), { key: 'name', dir: 'asc' })
  assert.deepEqual(C.nextSort({ key: 'name', dir: 'asc' }, 'name'), { key: 'name', dir: 'desc' })
  assert.deepEqual(C.nextSort({ key: 'name', dir: 'desc' }, 'name'), { key: null, dir: null })
  assert.deepEqual(C.nextSort({ key: 'name', dir: 'asc' }, 'size'), { key: 'size', dir: 'asc' })
  const rows = [
    E('b.txt', { size: 5, mtime: '2026-11-10T00:00:00Z' }),
    E('dir', { isDir: true, size: 0 }),
    E('a.txt', { size: 50, mtime: '2026-11-12T00:00:00Z' }),
    E('c.txt', { size: 1, mtime: '2026-11-13T00:00:00Z', tags: [{ name: '图片', category: 'image' }] })
  ]
  assert.equal(C.sortEntries(rows, { key: 'name', dir: 'asc' })[0].isDir, true)
  assert.equal(C.sortEntries(rows, { key: 'size', dir: 'desc' })[1].name, 'a.txt')
  assert.equal(C.sortEntries(rows, { key: 'mtime', dir: 'desc' })[1].name, 'c.txt')
  assert.equal(C.sortEntries(rows, { key: 'tags', dir: 'asc' })[1].tags[0].name, '图片')
  assert.deepEqual(C.sortEntries(rows, null), rows)
})

test('列显隐/宽持久化：名称列不可隐藏，损坏数据回退默认', () => {
  const mem = { getItem(k) { return this[k] || null }, setItem(k, v) { this[k] = v } }
  const cols = C.defaultColumns()
  assert.equal(C.toggleColumn(cols, 'name')[0].visible, true)
  const t = C.toggleColumn(cols, 'size')
  assert.equal(t.find(c => c.key === 'size').visible, false)
  const w = C.setColumnWidth(cols, 'mtime', 40)
  assert.equal(w.find(c => c.key === 'mtime').width, 60)
  C.saveColumns(mem, w)
  const loaded = C.loadColumns(mem)
  assert.equal(loaded.find(c => c.key === 'mtime').width, 60)
  mem[ C.FF_COL_KEY ] = '{bad json'
  assert.equal(C.loadColumns(mem).length, 4)
  assert.match(C.columnGrid(loaded), /minmax\(0,1fr\)/)
  assert.equal(C.saveViewMode(mem, 'grid'), 'grid')
  assert.equal(C.loadViewMode(mem), 'grid')
})

test('收藏：增删 + 上限 24', () => {
  const mem = { getItem(k) { return this[k] || null }, setItem(k, v) { this[k] = v } }
  let f = []
  f = C.toggleFavorite(mem, f, { path: '/Volumes/QuickSwap/a', name: 'a' })
  assert.equal(f.length, 1)
  f = C.toggleFavorite(mem, f, { path: '/Volumes/QuickSwap/a', name: 'a' })
  assert.equal(f.length, 0)
  for (let i = 0; i < 30; i++) f = C.toggleFavorite(mem, f, { path: '/x/' + i, name: 'x' + i })
  assert.equal(f.length, 24)
  assert.equal(C.loadFavorites(mem).length, 24)
})

test('六态 + 状态栏文案', () => {
  assert.equal(C.stateOf({ loading: true }), 'loading')
  assert.equal(C.stateOf({ error: 'boom' }), 'error')
  assert.equal(C.stateOf({ offline: true }), 'offline')
  assert.equal(C.stateOf({ partial: true, listing: {}, shownCount: 3 }), 'partial')
  assert.equal(C.stateOf({ readOnly: true, listing: {}, shownCount: 3 }), 'readonly')
  assert.equal(C.stateOf({ listing: {}, shownCount: 0 }), 'empty')
  assert.equal(C.stateOf({ listing: {}, shownCount: 5 }), 'ready')
  assert.match(C.statusFor({ shownCount: 5, selectedCount: 2 }).text, /已选 2/)
  assert.equal(C.statusFor({ error: 'x' }).tone, 'error')
  assert.ok(C.statusFor({ error: 'x' }).hint.indexOf('刷新') >= 0)
  assert.equal(Object.keys(C.FF_STATE_HINTS).length, 7)
})

test('快捷键模型：输入框内不劫持，⌘A / ⌘⇧A / 空格 / Esc / ⌘[ / ⌘]', () => {
  assert.equal(C.matchHotkey({ key: 'a', metaKey: true }), 'selectAll')
  assert.equal(C.matchHotkey({ key: 'A', metaKey: true, shiftKey: true }), 'deselectAll')
  assert.equal(C.matchHotkey({ key: ' ', targetTag: 'BODY' }), 'quicklook')
  assert.equal(C.matchHotkey({ key: ' ', targetTag: 'INPUT' }), null)
  assert.equal(C.matchHotkey({ key: 'Escape' }), 'escape')
  assert.equal(C.matchHotkey({ key: '[', metaKey: true }), 'back')
  assert.equal(C.matchHotkey({ key: ']', metaKey: true }), 'forward')
  assert.equal(C.matchHotkey({ key: 'F2' }), 'rename')
  assert.equal(C.matchHotkey({ key: 'a', isContentEditable: true, metaKey: true }), null)
})

test('右键菜单：空白/单文件/多选变体，只读禁用写项', () => {
  const blank = C.menuFor({ isBlank: true, clipCount: 3 })
  assert.ok(blank.some(x => x.id === 'newFolder'))
  assert.ok(blank.some(x => x.id === 'paste' && x.enabled))
  const one = C.menuFor({ target: E('a.txt'), selectedCount: 1, clipCount: 0 })
  assert.ok(one.some(x => x.id === 'rename' && x.enabled))
  assert.ok(one.some(x => x.id === 'open' && x.enabled))
  assert.ok(!one.some(x => x.id === 'paste' && x.enabled))
  const multi = C.menuFor({ target: E('a.txt'), selectedCount: 3 })
  assert.ok(multi.some(x => x.id === 'rename' && !x.enabled))
  assert.ok(multi.some(x => x.id === 'trash' && x.danger))
  const ro = C.menuFor({ target: E('a.txt'), selectedCount: 1, readOnly: true })
  assert.ok(ro.some(x => x.id === 'trash' && !x.enabled))
  assert.ok(ro.some(x => x.id === 'copy' && x.enabled))
})

test('标签 7 色 + 批量赋值', () => {
  assert.equal(C.FF_TAG_COLORS.length, 7)
  assert.equal(C.isTagColor('#0A84FF'), true)
  assert.equal(C.isTagColor('blue'), true)
  assert.equal(C.isTagColor('#000000'), false)
  assert.deepEqual(C.tagAssign(['合同'], '发票', true), ['合同', '发票'])
  assert.deepEqual(C.tagAssign(['合同', '发票'], '合同', false), ['发票'])
})

test('冲突三选：keep 自动改名 / replace 旧文件先进回收站 / skip 丢弃', () => {
  const items = [
    { src: '/A/a.txt', dst: '/B/a.txt' },
    { src: '/A/b.txt', dst: '/B/b.txt' }
  ]
  const exist = ['/B/a.txt']
  const keep = C.resolveConflicts(items, exist, 'keep')
  assert.equal(keep.items.length, 2)
  assert.equal(keep.items[0].dst, '/B/a 2.txt')
  assert.equal(keep.conflicts.length, 1)
  const rep = C.resolveConflicts(items, exist, 'replace')
  assert.deepEqual(rep.trashTargets, ['/B/a.txt'])
  assert.equal(rep.items[0].dst, '/B/a.txt')
  const skip = C.resolveConflicts(items, exist, 'skip')
  assert.equal(skip.items.length, 1)
  assert.equal(skip.items[0].dst, '/B/b.txt')
  assert.equal(C.conflictsFor({ mode: 'copy', paths: ['/A/a.txt'] }, '/B', [{ path: '/B/a.txt' }]).length, 1)
})

test('菜单动作 → 结构化计划：mkdir/rename/trash/paste，绝不直接执行', () => {
  const dir = '/Volumes/QuickSwap/x'
  const nf = C.buildMenuPlan('newFolder', { path: dir, newName: '新' })
  assert.equal(nf.kind, 'plan')
  assert.equal(nf.plan.groups[0].op, 'mkdir')
  const rn = C.buildMenuPlan('rename', { path: dir, selection: [dir + '/a.txt'], newName: 'b.txt' })
  assert.equal(rn.plan.groups[0].op, 'rename')
  assert.equal(rn.plan.groups[0].dst, dir + '/b.txt')
  const tr = C.buildMenuPlan('trash', { path: dir, selection: [dir + '/a.txt', dir + '/b.txt'] })
  assert.equal(tr.plan.groups[0].op, 'trash')
  assert.equal(tr.plan.groups[0].requiresExplicitTrash, true)
  const paste = C.buildMenuPlan('paste', { path: dir, clipboard: { mode: 'cut', paths: ['/Volumes/QuickSwap/a.txt'] }, conflict: 'keep', entries: [E('a.txt')] })
  assert.equal(paste.kind, 'plan')
  assert.equal(paste.plan.groups[0].op, 'move')
  const rep = C.buildMenuPlan('paste', { path: dir, clipboard: { mode: 'copy', paths: ['/Volumes/QuickSwap/a.txt'] }, conflict: 'replace', entries: [{ path: dir + '/a.txt', name: 'a.txt' }] })
  assert.equal(rep.plan.groups[0].op, 'trash')   // 替换前先移走旧文件
  assert.equal(rep.plan.groups[1].op, 'copy')
  const skip = C.buildMenuPlan('paste', { path: dir, clipboard: { mode: 'copy', paths: ['/Volumes/QuickSwap/a.txt'] }, conflict: 'skip', entries: [{ path: dir + '/a.txt', name: 'a.txt' }] })
  assert.equal(skip.kind, 'client')
  assert.equal(skip.action, 'allSkipped')
  assert.equal(C.buildMenuPlan('rename', { selection: [] }).action, 'needOne')
})

// 第 20 轮（m10399「能否实现文件缩略图」）：缩略图从「只有 7 种图片」扩到「除明确跳过的大归档/镜像外都能试」，
// 图片走 sharp、其余走 macOS QuickLook；取不到时后端回 ok:false，前端回落类型图标。
test('缩略图资格 + 卷分区', () => {
  assert.equal(C.canThumb(E('p.png', { ext: '.png' })), true)
  assert.equal(C.canThumb(E('p.jpg', { ext: '.jpg' })), true)
  assert.equal(C.canThumb(E('p.txt', { ext: '.txt' })), true, '文本现在由 QuickLook 出图')
  assert.equal(C.canThumb(E('m.mp4', { ext: '.mp4' })), true, '视频现在由 QuickLook 出图')
  assert.equal(C.canThumb(E('d.pdf', { ext: '.pdf' })), true, 'PDF 现在由 QuickLook 出图')
  assert.equal(C.canThumb(E('x.iso', { ext: '.iso' })), false, 'ISO 会拖死 qlmanage，必须排除')
  assert.equal(C.canThumb(E('y.dmg', { ext: '.dmg' })), false, 'dmg 同样排除')
  assert.equal(C.canThumb(E('dir', { isDir: true })), false)
  assert.equal(C.isRasterImage(E('p.png', { ext: '.png' })), true)
  assert.equal(C.isRasterImage(E('p.txt', { ext: '.txt' })), false)
  const p = C.partitionVolumes(VOLS)
  assert.equal(p.local.length, 1)
  assert.equal(p.smb.length, 2)
})
