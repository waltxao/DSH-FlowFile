// 第 15 轮（m07306 五条）：①低分辨率自适应 ②左侧树可折叠 ③计划显示作用范围
// ④AI 计划因目标目录不存在整批 blocked 的真 bug ⑤预设整理方案一键套用。
// 本文件先写、先红，再改实现（红→绿）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fitLayout, FF_LAYOUT_BREAKS, loadUiFold, saveUiFold, FF_FOLD_KEY } from '../src/browse-core.js'
import { listPresets, buildPresetPlan, injectMkdirItems, PRESETS } from '../src/presets.js'
import { OPS } from '../src/plan.js'

const dist = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/client-app.js', import.meta.url), 'utf8')
const browse = readFileSync(new URL('../src/client-browse.js', import.meta.url), 'utf8')

function entry(name, size, mtime, isDir) {
  return { path: '/d/' + name, name: name, size: size, mtime: mtime, isDir: !!isDir }
}

test('F1 fitLayout：1920 不动，1280 收右栏，1024 藏右栏并压 dock', () => {
  const a = fitLayout({ treeW: 210, rightW: 340, dockH: 300 }, 1920, 1080)
  assert.equal(a.treeW, 210); assert.equal(a.rightW, 340); assert.equal(a.dockH, 300); assert.equal(a.rightHidden, false)
  const b = fitLayout({ treeW: 210, rightW: 340, dockH: 300 }, 1280, 800)
  assert.ok(b.rightW <= 290, '1280 可用宽下右栏收到 <=290 但不隐藏，实际 ' + b.rightW)
  assert.equal(b.rightHidden, false, '1280 还不该藏右栏')
  const c = fitLayout({ treeW: 210, rightW: 340, dockH: 300 }, 1024, 700)
  assert.equal(c.rightHidden, true, '1024 必须藏右栏（否则中栏只剩 182px）')
  assert.ok(c.treeW <= 190, '1024 下树要收窄，实际 ' + c.treeW)
  assert.ok(c.dockH <= Math.round(700 * 0.42), 'dock 不得超过视口 42%，实际 ' + c.dockH)
  assert.equal(FF_LAYOUT_BREAKS.rightHide, 1080, '右栏隐藏门槛定在可用宽 1080（宿主导航占 280px，等效视口约 1360）')
})

test('F2 fitLayout：矮屏（600 高）dock 压到 220 以内，不留死高度', () => {
  const r = fitLayout({ treeW: 210, rightW: 340, dockH: 300 }, 1440, 600)
  assert.ok(r.dockH <= 220, '600 高屏 dock 必须 <=220，实际 ' + r.dockH)
})

test('F3 折叠状态持久化：默认都展开，存进 localStorage 后读回', () => {
  const store = {}
  const fake = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v) } }
  const d = loadUiFold(fake)
  assert.equal(d.tree, true); assert.equal(d.right, true)
  saveUiFold(fake, { tree: false, right: false })
  const back = loadUiFold(fake)
  assert.equal(back.tree, false); assert.equal(back.right, false)
  assert.equal(FF_FOLD_KEY, 'flowfile.fold.v1')
})

test('F4 预设清单：至少 5 个，每个有 id/name/desc', () => {
  const list = listPresets()
  assert.ok(list.length >= 5, '预设至少 5 个，实际 ' + list.length)
  list.forEach(p => { assert.ok(p.id); assert.ok(p.name); assert.ok(p.desc) })
  assert.equal(list.length, PRESETS.length)
})

test('F5 预设 by-type：按类型分到同名子目录，目标都落在当前目录下', () => {
  const entries = [entry('a.png', 10, '2026-11-01T00:00:00Z'), entry('b.pdf', 20, '2026-11-01T00:00:00Z'), entry('c.png', 30, '2026-11-01T00:00:00Z'), entry('sub', 0, '2026-11-01T00:00:00Z', true)]
  const plan = buildPresetPlan('by-type', '/d', entries)
  assert.ok(plan && plan.groups.length >= 2, '应分成图片与文档两组')
  const img = plan.groups.find(g => g.dst === '/d/图片')
  assert.ok(img, '图片组目标应为 /d/图片')
  assert.equal(img.paths.length, 2)
  assert.equal(img.op, 'move')
  assert.ok(plan.groups.every(g => g.paths.every(p => !p.endsWith('/sub'))), '目录不得被搬')
})

test('F6 预设 big-files：只收 >100MB 的文件', () => {
  const entries = [entry('big.iso', 200 * 1024 * 1024, '2026-11-01T00:00:00Z'), entry('small.txt', 1024, '2026-11-01T00:00:00Z')]
  const plan = buildPresetPlan('big-files', '/d', entries)
  const g = plan.groups.find(x => x.dst === '/d/_大文件')
  assert.ok(g, '大文件组目标应为 /d/_大文件')
  assert.deepEqual(g.paths, ['/d/big.iso'])
})

test('F7 预设 old-installers：90 天以上的安装包才进回收站', () => {
  const old = new Date(Date.now() - 200 * 86400000).toISOString()
  const fresh = new Date(Date.now() - 3 * 86400000).toISOString()
  const entries = [entry('old.dmg', 10, old), entry('new.dmg', 10, fresh)]
  const plan = buildPresetPlan('old-installers', '/d', entries)
  const g = plan.groups.find(x => x.op === 'trash')
  assert.ok(g, '应产出 trash 组')
  assert.deepEqual(g.paths, ['/d/old.dmg'])
  assert.equal(g.requiresExplicitTrash, true)
})

test('F8 预设未知 id 返回 null，不抛、不产出空计划', () => {
  assert.equal(buildPresetPlan('nope', '/d', []), null)
  const empty = buildPresetPlan('big-files', '/d', [])
  assert.equal(empty, null, '没有候选时返回 null，别给用户一张空卡片')
})

test('F9 真 bug 修复：目标目录不存在时自动补 mkdir 项（否则整批 blocked）', () => {
  const plan = { reply: '移动', groups: [{ label: 'md', reason: 'r', op: 'move', dst: '/d/md', paths: ['/d/a.md', '/d/b.md'] }] }
  const out = injectMkdirItems(plan, { dir: '/d', existsFn: function () { return false }, allowedFn: function () { return true } })
  assert.equal(out.groups.length, 2)
  assert.equal(out.groups[0].op, 'mkdir')
  assert.equal(out.groups[0].dst, '/d/md')
  assert.deepEqual(out.groups[0].paths, ['/d'])
  assert.equal(out.groups[1].op, 'move')
})

test('F10 injectMkdirItems：目录已存在不补，越界 dst 不补', () => {
  const plan = { reply: 'x', groups: [{ label: 'g', reason: 'r', op: 'move', dst: '/d/exist', paths: ['/d/a'] }] }
  const yes = injectMkdirItems(plan, { dir: '/d', existsFn: function () { return true }, allowedFn: function () { return true } })
  assert.equal(yes.groups.length, 1)
  const outside = injectMkdirItems({ groups: [{ label: 'g', reason: 'r', op: 'move', dst: '/etc/x', paths: ['/d/a'] }] }, { dir: '/d', existsFn: function () { return false }, allowedFn: function () { return false } })
  assert.equal(outside.groups.length, 1, '越界目标不得自动建目录')
})

test('F11 OPS 集合包含 mkdir（预设/自动建目录都靠它）', () => {
  assert.ok(OPS.has('mkdir'))
})

test('F12 客户端：树与右栏都能折叠，且折叠状态走持久化', () => {
  assert.ok(app.indexOf('foldState') > 0 || app.indexOf('folds') > 0, 'client-app 应有折叠状态')
  assert.ok(app.indexOf('loadUiFold') > 0, 'client-app 应读持久化的折叠状态')
  assert.ok(app.indexOf('fdToggleFold') > 0, 'client-app 应有切换函数 fdToggleFold')
  assert.ok(app.indexOf('fitLayout(') > 0, 'client-app 应调用 fitLayout 做自适应')
})

test('F13 客户端：dock 里有预设入口与作用范围说明', () => {
  assert.ok(browse.indexOf('fd-preset') > 0, 'dock 里应有 fd-preset 条')
  assert.ok(browse.indexOf('作用目录') > 0, '计划卡片要写明作用目录')
  assert.ok(browse.indexOf('onPreset') > 0, 'dock 应暴露 onPreset 回调')
})

test('F14 dist 已同步（含 presets 与折叠）', () => {
  assert.ok(dist.indexOf('buildPresetPlan') > 0 || dist.indexOf('ffPresetPlan') > 0, 'dist 应含预设接线')
  assert.ok(dist.indexOf('fd-preset') > 0, 'dist 应含预设样式')
})

test('F15 树头有折叠按钮，折叠后出现 rail 可展开', () => {
  assert.ok(browse.indexOf('onFold') > 0, 'FF_Tree 应接收 onFold 回调')
  assert.ok(browse.indexOf('fd-tree-h') > 0, '树头要在')
  assert.ok(app.indexOf('onFold: function () { fdToggleFold(\'tree\') }') > 0, 'client-app 要把 onFold 接上')
})

test('F16 预设清单在 client 侧有兜底副本（host 未重启时 UI 也能显示）', () => {
  assert.ok(browse.indexOf('FF_PRESET_FALLBACK') > 0, 'client 应有预设兜底清单')
  assert.ok(/FF_PRESET_FALLBACK\s*=\s*\[/.test(browse), '兜底清单应是数组常量')
  assert.ok(browse.indexOf("'by-type'") > 0 || browse.indexOf('"by-type"') > 0, '兜底清单要含 by-type')
})
