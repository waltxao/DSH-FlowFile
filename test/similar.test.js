import { test } from 'node:test'
import assert from 'node:assert/strict'
import { strongSimilar, weakMatches } from '../src/similar.js'

test('similar：同 phash 距离 ≤6 判强相似，距离大不判', () => {
  const target = { path: '/a/x.png', name: 'x.png', phash: '0000000000000000', text_fp: null, is_dir: 0, missing: 0 }
  const items = [
    { path: '/a/y.png', name: 'y.png', size: 10, phash: '0000000000000003', is_dir: 0, missing: 0 },  // 距离 2
    { path: '/a/z.png', name: 'z.png', size: 10, phash: 'ffffffffffffffff', is_dir: 0, missing: 0 },  // 距离 64
    { path: target.path, name: 'x.png', phash: '0000000000000000', is_dir: 0, missing: 0 }
  ]
  const out = strongSimilar(items, target)
  assert.equal(out.length, 1)
  assert.equal(out[0].path, '/a/y.png')
  assert.equal(out[0].strength, 'strong')
  assert.equal(out[0].basis, 'dHash')
})

test('similar：文本 SimHash 距离 ≤8 判强相似', () => {
  const target = { path: '/a/x.md', name: 'x.md', phash: null, text_fp: 'aaaaaaaaaaaaaaaa', is_dir: 0, missing: 0 }
  const items = [
    { path: '/a/y.md', name: 'y.md', size: 10, text_fp: 'aaaaaaaaaaaaaaab', is_dir: 0, missing: 0 },
    { path: '/a/z.md', name: 'z.md', size: 10, text_fp: '5555555555555555', is_dir: 0, missing: 0 }
  ]
  const out = strongSimilar(items, target)
  assert.equal(out.length, 1)
  assert.equal(out[0].basis, 'SimHash')
})

test('similar：弱信号标 weak 且依据是名称+类型+大小', () => {
  const target = { path: '/a/报告.pdf', name: '报告.pdf', ext: '.pdf', size: 100, is_dir: 0 }
  const items = [
    { path: '/b/报告 副本.pdf', name: '报告 副本.pdf', ext: '.pdf', size: 105, is_dir: 0 },
    { path: '/b/别的.pdf', name: '别的.pdf', ext: '.pdf', size: 100, is_dir: 0 }
  ]
  const out = weakMatches(items, target)
  assert.equal(out.length, 1)
  assert.equal(out[0].strength, 'weak')
  assert.equal(out[0].basis, '名称+类型+大小')
})
