import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256, partialHashSync, fullHashSync, dHashFromRaw, simHash, hammingHex,
  normalizeName, weakSimilar, SMALL_FILE_THRESHOLD, PARTIAL_CHUNK } from '../src/hash.js'

test('hash：SHA-256 / 小文件全量 / 大文件首尾部分 / 全量一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-hash-'))
  try {
    const small = join(dir, 'small.bin')
    writeFileSync(small, Buffer.from('hello world'))
    assert.equal(sha256(Buffer.from('hello world')), fullHashSync(small, 11).hash)
    const p1 = partialHashSync(small, 11)
    assert.equal(p1.state, 'full')
    const big = join(dir, 'big.bin')
    const buf = Buffer.alloc(PARTIAL_CHUNK * 3, 7)
    buf[0] = 1; buf[buf.length - 1] = 9
    writeFileSync(big, buf)
    const p2 = partialHashSync(big, buf.length)
    assert.equal(p2.state, 'partial')
    assert.equal(p2.hash, sha256(Buffer.concat([buf.subarray(0, PARTIAL_CHUNK), buf.subarray(buf.length - PARTIAL_CHUNK)])))
    assert.equal(fullHashSync(big, buf.length).hash, sha256(buf))
    assert.equal(SMALL_FILE_THRESHOLD, 8192)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('hash：dHash / SimHash / 汉明距离 / 弱信号归一化', () => {
  // 构造 72 字节 9x8 灰度：每行递增 → 每行 8 个 1
  const raw = Buffer.alloc(72)
  for (let y = 0; y < 8; y++) for (let x = 0; x < 9; x++) raw[y * 9 + x] = x * 10
  const dh = dHashFromRaw(raw)
  assert.equal(dh.length, 16)
  assert.equal(hammingHex(dh, dh), 0)
  const a = simHash('文件管理 查重 相似 文件'), b = simHash('文件管理 查重 相似 文件'), c = simHash('完全不同的内容 abc')
  assert.equal(a.length, 16)
  assert.ok(hammingHex(a, b) === 0)
  assert.ok(hammingHex(a, c) > 0)
  assert.equal(normalizeName('报告 副本.pdf'), normalizeName('报告.pdf'))
  assert.equal(normalizeName('报告(1).pdf'), normalizeName('报告.pdf'))
  assert.equal(weakSimilar(
    { path: '/a/报告.pdf', name: '报告.pdf', ext: '.pdf', size: 100 },
    { path: '/b/报告 副本.pdf', name: '报告 副本.pdf', ext: '.pdf', size: 105 }), 1)
  assert.equal(weakSimilar(
    { path: '/a/x.pdf', name: 'x.pdf', ext: '.pdf', size: 100 },
    { path: '/b/x.pdf', name: 'x.pdf', ext: '.pdf', size: 500 }), 0)
})
