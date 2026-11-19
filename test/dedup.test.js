import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bucketBySize, finalizeGroups, keepSuggestion } from '../src/dedup.js'

test('dedup：size 分桶只留 count>1', () => {
  const items = [
    { path: '/a/1', size: 100, is_dir: 0, missing: 0 },
    { path: '/a/2', size: 100, is_dir: 0, missing: 0 },
    { path: '/a/3', size: 200, is_dir: 0, missing: 0 },
    { path: '/a/dir', size: 0, is_dir: 1, missing: 0 }
  ]
  const b = bucketBySize(items)
  assert.equal(b.length, 1)
  assert.equal(b[0].size, 100)
  assert.equal(b[0].items.length, 2)
})

test('dedup：三级淘汰（partial 分桶 → full hash）不误并', () => {
  const mk = (path, hash_full) => ({ path, name: path.split('/').pop(), size: 100, is_dir: 0, missing: 0, hash_full, hash_state: 'full' })
  // 三个同 size 文件：两个同 hash、一个不同 hash
  const buckets = [{ size: 100, items: [mk('/a/x', 'H1'), mk('/a/y', 'H1'), mk('/a/z', 'H2')] }]
  const groups = finalizeGroups(buckets, {
    partialFn: (f) => ({ hash: 'P' + f.hash_full, state: 'partial' }),
    fullFn: (f) => ({ hash: f.hash_full, state: 'full' })
  })
  assert.equal(groups.length, 1)
  assert.equal(groups[0].items.length, 2)
  assert.deepEqual(groups[0].items.map(x => x.path).sort(), ['/a/x', '/a/y'])
  assert.equal(groups[0].state, 'full')
})

test('dedup：full hash 不同的同 size 文件不进重复组', () => {
  const mk = (path, h) => ({ path, size: 100, is_dir: 0, missing: 0, hash_full: h, hash_state: 'full' })
  const groups = finalizeGroups([{ size: 100, items: [mk('/a/x', 'H1'), mk('/b/y', 'H2')] }], {
    partialFn: (f) => ({ hash: f.hash_full, state: 'partial' }),
    fullFn: (f) => ({ hash: f.hash_full, state: 'full' })
  })
  assert.equal(groups.length, 0)
})

test('dedup：保留建议只出文案、不删文件', () => {
  const items = [
    { path: '/Volumes/SMB/very/long/path/f.txt', mtime_ns: '2' },
    { path: '/Users/me/f.txt', mtime_ns: '3' },
    { path: '/Users/me/g.txt', mtime_ns: '1' }
  ]
  const s = keepSuggestion(items)
  assert.equal(s.keep, '/Users/me/g.txt')  // 最早 mtime 优先
  assert.ok(s.reason.indexOf('不自动执行') > 0)
})
