import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffSnapshot } from '../src/timeline.js'

test('timeline.diffSnapshot：created / modified / moved / deleted / seen', () => {
  const prev = [
    { path: '/a/1.txt', size: 10, mtime_ns: '1', hash_full: 'h1' },
    { path: '/a/2.txt', size: 20, mtime_ns: '2', hash_full: 'h2' },
    { path: '/a/3.txt', size: 30, mtime_ns: '3', hash_full: 'h3' }
  ]
  const cur = [
    { path: '/a/1.txt', size: 10, mtime_ns: '1', hash_full: 'h1' },   // seen
    { path: '/a/2.txt', size: 21, mtime_ns: '9', hash_full: 'h2x' },  // modified
    { path: '/a/new.txt', size: 40, mtime_ns: '4', hash_full: 'h4' }, // created
    { path: '/b/3.txt', size: 30, mtime_ns: '3', hash_full: 'h3' }    // moved
  ]
  const ev = diffSnapshot(prev, cur, 1000)
  const kinds = ev.map(e => e.kind)
  assert.ok(kinds.includes('seen'))
  assert.ok(kinds.includes('modified'))
  assert.ok(kinds.includes('created'))
  const moved = ev.find(e => e.kind === 'moved')
  assert.equal(moved.from_path, '/a/3.txt')
  assert.equal(moved.to_path, '/b/3.txt')
  assert.equal(moved.hash_full, 'h3')
  assert.equal(ev[0].at, 1000)
})

test('timeline.diffSnapshot：消失且无同 hash 承接 = deleted', () => {
  const prev = [{ path: '/a/x', size: 1, mtime_ns: '1', hash_full: 'x' }]
  const ev = diffSnapshot(prev, [], 1)
  assert.equal(ev.length, 1)
  assert.equal(ev[0].kind, 'deleted')
})
