// 分级哈希与感知哈希：常量照抄 flowfinder-native/rust-core/src/core/dedup_engine.rs 实测值。
// blake3 换成 node:crypto 的 SHA-256（换算法只影响 hash 值，不影响分组语义）。
// 全部为同步读，不做任何写。
import { createHash } from 'node:crypto'
import { openSync, readSync, closeSync, readFileSync } from 'node:fs'
import { open as openAsync, readFile } from 'node:fs/promises'

export const PARTIAL_CHUNK = 4096
export const SMALL_FILE_THRESHOLD = 8192
export const HASH_CHUNK = 65536
export const FULL_HASH_MAX_BYTES = 2 * 1024 * 1024 * 1024

export function sha256(buf) { return createHash('sha256').update(buf).digest('hex') }

// 部分哈希：文件 < 8KB 直接全量；否则头 4KB + 尾 4KB 一起算。
export function partialHashSync(path, size) {
  if (size < SMALL_FILE_THRESHOLD) return { hash: sha256(readFileSync(path)), state: 'full' }
  const fd = openSync(path, 'r')
  try {
    const head = Buffer.alloc(PARTIAL_CHUNK)
    readSync(fd, head, 0, PARTIAL_CHUNK, 0)
    const tail = Buffer.alloc(PARTIAL_CHUNK)
    readSync(fd, tail, 0, PARTIAL_CHUNK, size - PARTIAL_CHUNK)
    return { hash: sha256(Buffer.concat([head, tail])), state: 'partial' }
  } finally { closeSync(fd) }
}

// 全量哈希：流式 64KB 缓冲，超大文件跳过（标 skipped_large）。
export function fullHashSync(path, size) {
  if (size > FULL_HASH_MAX_BYTES) return { hash: null, state: 'skipped_large' }
  const h = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(HASH_CHUNK)
    let pos = 0
    for (;;) {
      const n = readSync(fd, buf, 0, HASH_CHUNK, pos)
      if (n <= 0) break
      h.update(buf.subarray(0, n))
      pos += n
      if (n < HASH_CHUNK) break
    }
    return { hash: h.digest('hex'), state: 'full' }
  } finally { closeSync(fd) }
}

// 部分哈希（异步版）：SMB 上头尾各 4KB 的同步 readSync 也会连续卡住主进程，改用 FileHandle.read。
export async function partialHashAsync(path, size) {
  if (size < SMALL_FILE_THRESHOLD) return { hash: sha256(await readFile(path)), state: 'full' }
  const fh = await openAsync(path, 'r')
  try {
    const head = Buffer.alloc(PARTIAL_CHUNK)
    await fh.read(head, 0, PARTIAL_CHUNK, 0)
    const tail = Buffer.alloc(PARTIAL_CHUNK)
    await fh.read(tail, 0, PARTIAL_CHUNK, size - PARTIAL_CHUNK)
    return { hash: sha256(Buffer.concat([head, tail])), state: 'partial' }
  } finally { await fh.close() }
}

// 全量哈希（异步版）：FileHandle.read 走 libuv 线程池，单次读不阻塞 Electron 主进程；
// 每 4MB 再主动 setImmediate 让出一次。SMB 大文件扫描必须用它，避免整个 DSH 卡死。
export async function fullHashAsync(path, size, shouldStop) {
  if (size > FULL_HASH_MAX_BYTES) return { hash: null, state: 'skipped_large' }
  const h = createHash('sha256')
  const fh = await openAsync(path, 'r')
  try {
    const buf = Buffer.alloc(HASH_CHUNK)
    let pos = 0, sinceYield = 0
    for (;;) {
      // 取消必须真的停：否则连续「启动→取消」大卷会让若干 2GB 级哈希任务叠在
      // libuv 线程池里，把后续 HTTP 请求挤到几十秒（真机实测 44s）。
      if (shouldStop && shouldStop()) return { hash: null, state: 'cancelled' }
      const { bytesRead } = await fh.read(buf, 0, HASH_CHUNK, pos)
      if (bytesRead <= 0) break
      h.update(buf.subarray(0, bytesRead))
      pos += bytesRead
      sinceYield += bytesRead
      if (sinceYield >= 4 * 1024 * 1024) { await new Promise(r => setImmediate(r)); sinceYield = 0 }
      if (bytesRead < HASH_CHUNK) break
    }
    return { hash: h.digest('hex'), state: 'full' }
  } finally { await fh.close() }
}

// dHash：输入 sharp 输出的 9x8 灰度 raw（72 字节），相邻像素比较出 64bit，返回 16 位 hex。
export function dHashFromRaw(raw) {
  const bits = []
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i = y * 9 + x
      bits.push(raw[i] > raw[i + 1] ? '1' : '0')
    }
  }
  let hex = ''
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4).join(''), 2).toString(16)
  return hex
}

// SimHash 64bit：按非字母数字中文切词，词频加权，返回 16 位 hex。
export function simHash(text, bits = 64) {
  const tokens = String(text || '').toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]/g) || []
  const weights = new Array(bits).fill(0)
  for (const tok of tokens) {
    let v = 2166136261
    for (let i = 0; i < tok.length; i++) { v ^= tok.charCodeAt(i); v = Math.imul(v, 16777619) }
    const x = BigInt.asUintN(64, BigInt(v >>> 0))
    for (let b = 0; b < bits; b++) weights[b] += (x >> BigInt(b)) & 1n ? 1 : -1
  }
  let out = 0n
  for (let b = 0; b < bits; b++) if (weights[b] > 0) out |= 1n << BigInt(b)
  return out.toString(16).padStart(bits / 4, '0')
}

export function hammingHex(a, b) {
  if (!a || !b || a.length !== b.length) return 999
  let d = 0
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (x) { d += x & 1; x >>= 1 }
  }
  return d
}

// 弱信号：文件名归一化（去 副本/拷贝/(1)/日期后缀）+ 同扩展名 + size 差 <= 10%。
export function normalizeName(name) {
  return String(name || '').toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[\s_-]*(副本|拷贝|copy|复件|\(\d+\)|（\d+）|\d{4}[-.]\d{2}[-.]\d{2}|\d{8})$/g, '')
    .replace(/[\s_\-()（）]+/g, '')
}

export function weakSimilar(a, b) {
  if (!a || !b || a.path === b.path || a.is_dir || b.is_dir) return 0
  if (normalizeName(a.name) !== normalizeName(b.name)) return 0
  if ((a.ext || '') !== (b.ext || '')) return 0
  const max = Math.max(Number(a.size), Number(b.size))
  if (max === 0) return 0
  if (Math.abs(Number(a.size) - Number(b.size)) / max > 0.1) return 0
  return 1
}
