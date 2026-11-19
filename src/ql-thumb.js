// 文件缩略图：图片走 sharp（进程内解码），其余类型走 macOS QuickLook（qlmanage）子进程。
// 实测（本轮 m10399 提问「能否实现文件缩略图」时量的）：
//   图片 97ms / 视频 219ms / 文本 175ms 均可出图；
//   ISO 与大归档、目录会在 qlmanage 里挂死（>10s 不返回）——所以必须有硬超时，超时即放弃并记黑名单。
// 三个硬约束：
//   ① 只读：不写业务文件，qlmanage 的输出先落临时目录，成功才搬进 ~/.flowfile/thumbs。
//   ② 缓存：键 = sha256(realpath|mtimeMs|size|width)，命中直接读盘，不再起子进程。
//   ③ 限流：同时最多 2 个 qlmanage（宿主是单进程，起太多会拖慢整个 DSH UI）。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const QL_BIN = '/usr/bin/qlmanage'
const MAX_WIDTH = 512
const QL_TIMEOUT_MS = 6000

// 已知会让 qlmanage 挂死的：大归档/磁盘镜像。直接不试，省 6 秒。
const QL_SKIP_EXT = ['.iso', '.dmg', '.img', '.vmdk', '.pkg', '.mpkg', '.toast', '.sparsebundle']

function thumbDir() {
  const d = join(homedir(), '.flowfile', 'thumbs')
  try { mkdirSync(d, { recursive: true }) } catch (e) {}
  return d
}

export function cacheKeyFor(path, mtimeMs, size, width) {
  return createHash('sha256').update(String(path) + '|' + mtimeMs + '|' + size + '|' + width).digest('hex').slice(0, 32)
}

const inflight = new Map()   // key → Promise（同键并发只跑一次）
let running = 0
const queue = []
function acquire() {
  return new Promise(function (resolve) {
    if (running < 2) { running++; resolve() }
    else queue.push(resolve)
  })
}
function release() {
  running--
  const next = queue.shift()
  if (next) { running++; next() }
}

function runQl(path, width, outDir) {
  return new Promise(function (resolve) {
    let settled = false
    const done = function (v) { if (!settled) { settled = true; resolve(v) } }
    let child
    try {
      child = spawn(QL_BIN, ['-t', '-s', String(width), '-o', outDir, path], { stdio: 'ignore' })
    } catch (e) { return done(null) }
    const timer = setTimeout(function () {
      try { child.kill('SIGKILL') } catch (e) {}
      done(null)
    }, QL_TIMEOUT_MS)
    child.on('error', function () { clearTimeout(timer); done(null) })
    child.on('exit', function (code) {
      clearTimeout(timer)
      if (code !== 0) return done(null)
      // qlmanage 的产物名是 <basename>.png
      const guess = join(outDir, basename(path) + '.png')
      done(existsSync(guess) ? guess : null)
    })
  })
}

/**
 * 生成/取用缩略图。返回 { ok, path, mime, bytes, cached } 或 { ok:false, error, unsupported? }。
 * 只读 + 幂等：同一文件同一宽度只会真正跑一次 qlmanage。
 */
export async function qlThumb(realPath, width) {
  const w = Math.max(32, Math.min(MAX_WIDTH, Number(width) || 128))
  let st
  try { st = statSync(realPath) } catch (e) { return { ok: false, error: '读不到文件' } }
  if (!st.isFile()) return { ok: false, error: '不是文件', unsupported: true }
  const ext = String(realPath).slice(String(realPath).lastIndexOf('.')).toLowerCase()
  if (QL_SKIP_EXT.indexOf(ext) >= 0) return { ok: false, error: '这类文件不生成缩略图', unsupported: true }
  if (st.size > 512 * 1024 * 1024) return { ok: false, error: '文件过大，跳过缩略图', unsupported: true }

  const key = cacheKeyFor(realPath, st.mtimeMs, st.size, w)
  const hit = join(thumbDir(), key + '.png')
  if (existsSync(hit)) {
    try {
      const buf = readFileSync(hit)
      return { ok: true, path: realPath, mime: 'image/png', bytes: buf.length, cached: true, file: hit }
    } catch (e) { try { unlinkSync(hit) } catch (e2) {} }
  }
  if (inflight.has(key)) return inflight.get(key)

  const task = (async function () {
    await acquire()
    const outDir = join(tmpdir(), 'ff-ql-' + randomUUID().slice(0, 8))
    try {
      mkdirSync(outDir, { recursive: true })
      const produced = await runQl(realPath, w, outDir)
      if (!produced) return { ok: false, error: 'QuickLook 未能生成缩略图', unsupported: true }
      // 先落盘到最终位置（同盘 rename 原子），再返回
      let finalPath = hit
      try { renameSync(produced, finalPath) } catch (e) {
        // 跨盘（tmpdir 与 ~/.flowfile 不同卷）时 rename 会失败：退化为复制
        try { copyFileSync(produced, finalPath) } catch (e2) { finalPath = produced }
      }
      const buf = readFileSync(finalPath)
      return { ok: true, path: realPath, mime: 'image/png', bytes: buf.length, cached: false, file: finalPath }
    } catch (e) {
      return { ok: false, error: e.message || String(e) }
    } finally {
      try { rmSync(outDir, { recursive: true, force: true }) } catch (e) {}
      release()
      inflight.delete(key)
    }
  })()
  inflight.set(key, task)
  return task
}

// ---- 目录缩略图：2×2 拼图 ----
// 目录走 qlmanage 会挂死（实测 >10s），所以自己拼：读最多 4 个图片子项，sharp 合成一张。
// 没有任何图片子项的目录直接返回 unsupported，前端回落文件夹图标——不假装有图。
const DIR_SCAN_MAX = 24        // 最多扫 24 个子项找图片，避免大目录卡住
const DIR_TILES = 4            // 2×2

/**
 * 目录缩略图。sharp 由调用方注入（host 侧用 sharp-loader，测试里可传 null 走无图路径）。
 * 返回与 qlThumb 同构：{ ok, path, mime, bytes, cached, file }。
 */
export async function dirThumb(realDir, width, sharp) {
  let st
  try { st = statSync(realDir) } catch (e) { return { ok: false, error: '读不到目录' } }
  if (!st.isDirectory()) return { ok: false, error: '不是目录', unsupported: true }
  if (!sharp) return { ok: false, error: '目录缩略图组件不可用', unsupported: true }

  const w = Math.max(32, Math.min(MAX_WIDTH, Number(width) || 128))
  const key = cacheKeyFor(realDir, st.mtimeMs, 'dir', w)
  const hit = join(thumbDir(), key + '.png')
  if (existsSync(hit)) {
    try { return { ok: true, path: realDir, mime: 'image/png', bytes: readFileSync(hit).length, cached: true, file: hit } }
    catch (e) { try { unlinkSync(hit) } catch (e2) {} }
  }

  // 找图片子项（只读，失败静默）
  let names = []
  try {
    names = readdirSync(realDir).filter(function (n) { return n[0] !== '.' }).slice(0, DIR_SCAN_MAX)
  } catch (e) { return { ok: false, error: '目录不可读', unsupported: true } }
  const tiles = []
  for (const n of names) {
    if (tiles.length >= DIR_TILES) break
    const f = join(realDir, n)
    const ext = n.slice(n.lastIndexOf('.')).toLowerCase()
    if (FF_DIR_TILE_EXT.indexOf(ext) < 0) continue
    try {
      const s = statSync(f)
      if (!s.isFile() || s.size > 40 * 1024 * 1024) continue
      const buf = await sharp(f).rotate().resize({ width: Math.round(w / 2), height: Math.round(w / 2), fit: 'cover' }).png().toBuffer()
      tiles.push(buf)
    } catch (e) { /* 单张失败不影响整张 */ }
  }
  if (!tiles.length) return { ok: false, error: '目录里没有可用的图片', unsupported: true }

  // 第 25 轮：原实现无论几张图都按 2×2 铺，只有 1 张时另外三格留灰底——
  // 在 20px 的列表行里看起来就像「缩略图坏了」。改成按张数选版式：
  // 1 张 = 整幅 cover；2 张 = 左右对半；3–4 张 = 2×2。没铺满的地方不再留背景色。
  const canvas = sharp({ create: { width: w, height: w, channels: 4, background: { r: 238, g: 241, b: 246, alpha: 1 } } })
  let composites
  if (tiles.length === 1) {
    const full = await sharp(tiles[0]).resize({ width: w, height: w, fit: 'cover' }).png().toBuffer()
    composites = [{ input: full, left: 0, top: 0 }]
  } else if (tiles.length === 2) {
    const half = Math.round(w / 2)
    composites = tiles.slice(0, 2).map(function (buf, i) {
      return { input: buf, left: i * half, top: 0 }
    })
  } else {
    const half = Math.round(w / 2)
    composites = tiles.map(function (buf, i) {
      return { input: buf, left: (i % 2) * half, top: Math.floor(i / 2) * half }
    })
  }
  const out = await canvas.composite(composites).png().toBuffer()
  try { writeFileSync(hit, out) } catch (e) {}
  return { ok: true, path: realDir, mime: 'image/png', bytes: out.length, cached: false, file: existsSync(hit) ? hit : null, data: existsSync(hit) ? null : out }
}

// 拼图只吃位图；svg/heic 交给 sharp 也可能失败，失败就算了
const FF_DIR_TILE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.tiff', '.tif']

/** 读缓存的缩略图字节（给 raw 路由直接回二进制用）。 */
export function readThumbBytes(result) {
  if (!result || !result.ok || !result.file) return null
  try { return readFileSync(result.file) } catch (e) { return null }
}
