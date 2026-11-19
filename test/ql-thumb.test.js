import { test } from 'node:test'
import assert from 'node:assert/strict'
import { qlThumb, dirThumb, cacheKeyFor, readThumbBytes } from '../src/ql-thumb.js'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('qlThumb：缓存键由路径+mtime+size+宽度决定，任一变化键就变', () => {
  const a = cacheKeyFor('/a/b.png', 1000, 200, 128)
  const b = cacheKeyFor('/a/b.png', 1001, 200, 128)
  const c = cacheKeyFor('/a/b.png', 1000, 200, 256)
  assert.notEqual(a, b); assert.notEqual(a, c)
  assert.equal(a.length, 32)
})

test('qlThumb：跳过扩展名与目录直接返回 unsupported，不起子进程', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-ql-'))
  try {
    const iso = join(dir, 'x.iso')
    writeFileSync(iso, 'x')
    const r1 = await qlThumb(iso, 128)
    assert.equal(r1.ok, false); assert.equal(r1.unsupported, true)
    const r2 = await qlThumb(dir, 128)
    assert.equal(r2.ok, false); assert.equal(r2.unsupported, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('qlThumb：真文本文件能出 png（macOS QuickLook 可用）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-ql-'))
  try {
    const f = join(dir, 'hello.md')
    writeFileSync(f, '# hello\n\n缩略图测试\n')
    const r = await qlThumb(f, 128)
    assert.equal(r.ok, true, 'qlmanage 应能出图: ' + JSON.stringify(r))
    assert.equal(r.mime, 'image/png')
    const buf = readThumbBytes(r)
    assert.ok(buf && buf.length > 100, '应读回 png 字节')
    // PNG 魔数
    assert.equal(buf[0], 0x89); assert.equal(buf[1], 0x50)
    // 第二次命中缓存
    const r2 = await qlThumb(f, 128)
    assert.equal(r2.ok, true); assert.equal(r2.cached, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---- 第 23 轮（m10799「能否自动生成缩略图」）----
// 目录缩略图：qlmanage 对目录会挂死（实测 >10s），所以改成自己拼 2×2 图片子项。
const SHARP = (() => {
  try { return require('sharp') } catch (e) { return null }
})()

test('dirThumb：目录里有图片时拼出 2×2 拼图，且二次命中缓存', async (t) => {
  const sharp = await loadSharpForTest()
  if (!sharp) return t.skip('本机解析不到 sharp，跳过目录拼图用例')
  const dir = mkdtempSync(join(tmpdir(), 'ff-dir-'))
  try {
    // 造 3 张纯色 png
    for (const [n, rgb] of [['a.png', { r: 255, g: 0, b: 0 }], ['b.png', { r: 0, g: 200, b: 0 }], ['c.png', { r: 0, g: 0, b: 255 }]]) {
      await sharp({ create: { width: 64, height: 64, channels: 3, background: rgb } }).png().toFile(join(dir, n))
    }
    writeFileSync(join(dir, 'readme.md'), '# x')
    const r = await dirThumb(dir, 128, sharp)
    assert.equal(r.ok, true, '应拼出目录图: ' + JSON.stringify(r && r.error))
    assert.equal(r.mime, 'image/png')
    const bytes = r.data || readThumbBytes(r)
    assert.ok(bytes && bytes.length > 200, '应产出 png 字节')
    assert.equal(bytes[0], 0x89); assert.equal(bytes[1], 0x50)
    const r2 = await dirThumb(dir, 128, sharp)
    assert.equal(r2.ok, true); assert.equal(r2.cached, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('dirThumb：目录里没有图片时返回 unsupported，不假装有图', async (t) => {
  const sharp = await loadSharpForTest()
  if (!sharp) return t.skip('本机解析不到 sharp')
  const dir = mkdtempSync(join(tmpdir(), 'ff-dir-'))
  try {
    writeFileSync(join(dir, 'a.txt'), 'x'); writeFileSync(join(dir, 'b.md'), 'y')
    const r = await dirThumb(dir, 128, sharp)
    assert.equal(r.ok, false)
    assert.equal(r.unsupported, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('dirThumb：非目录传进来要被挡住', async (t) => {
  const sharp = await loadSharpForTest()
  if (!sharp) return t.skip('本机解析不到 sharp')
  const dir = mkdtempSync(join(tmpdir(), 'ff-dir-'))
  try {
    const f = join(dir, 'a.png')
    await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toFile(f)
    const r = await dirThumb(f, 128, sharp)
    assert.equal(r.ok, false); assert.equal(r.unsupported, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('canDirThumb：目录可试、.app 包与文件不试', async () => {
  const C = await import('../src/browse-core.js')
  assert.equal(C.canDirThumb({ path: '/a/docs', name: 'docs', isDir: true }), true)
  assert.equal(C.canDirThumb({ path: '/a/X.app', name: 'X.app', isDir: true }), false, '.app 包不递归')
  assert.equal(C.canDirThumb({ path: '/a/x.png', name: 'x.png', isDir: false }), false, '文件走 canThumb')
})

// sharp 在源码目录解析不到（与运行期一致：host 从 profile 解析），测试里先试 profile 锚点
async function loadSharpForTest() {
  if (SHARP) return SHARP
  try {
    const { loadSharp } = await import('../src/sharp-loader.js')
    return loadSharp()
  } catch (e) { return null }
}
