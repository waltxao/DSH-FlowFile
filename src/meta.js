// 元数据采集：whereFroms / mdls / sips / Finder 标签。全部 child_process.execFile（不拼 shell 字符串）。
// 只读，不做任何写回；失败一律记 null，不阻断扫描。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, statSync } from 'node:fs'
import { extOf, IMAGE_EXTS, TEXT_EXTS } from './rules.js'
import { loadSharp } from './sharp-loader.js'
import { dHashFromRaw, simHash } from './hash.js'

const run = promisify(execFile)
const WHERE_XATTR = 'com.apple.metadata:kMDItemWhereFroms'
const TAG_XATTR = 'com.apple.metadata:_kMDItemUserTags'
const TEXT_LIMIT = 20 * 1024

async function safeRun(cmd, args, opts) {
  if (process.platform !== 'darwin' && (cmd === 'mdls' || cmd === 'sips' || cmd === 'xattr' || cmd === 'plutil')) return null
  try { return (await run(cmd, args, { timeout: 4000, maxBuffer: 1024 * 1024, ...(opts || {}) })).stdout }
  catch (e) { return null }
}

// whereFroms 是 binary plist：xattr -p 拿 hex → plutil -convert json 解析。
export async function whereFroms(path) {
  if (process.platform !== 'darwin') return { whereFrom: null, raw: null }
  const hex = await safeRun('xattr', ['-p', WHERE_XATTR, path])
  if (!hex) return { whereFrom: null, raw: null }
  const clean = String(hex).replace(/[^0-9a-fA-F]/g, '')
  if (clean.length < 16) return { whereFrom: null, raw: null }
  // whereFroms 是 binary plist：实测 URL 以明文嵌在 plist 里，直接扫 ASCII 即可（plutil 走 stdin 需要写临时文件，扫描期不落盘）。
  const ascii = Buffer.from(clean, 'hex').toString('latin1')
  const urls = ascii.match(/https?:\/\/[\x21-\x7E]{4,}/g) || []
  const first = urls.length ? urls[0].trim() : null
  return { whereFrom: first || null, raw: null }
}

export async function mdlsInfo(path) {
  const out = await safeRun('mdls', ['-name', 'kMDItemContentType', '-name', 'kMDItemDownloadedDate', '-name', 'kMDItemLastUsedDate', '-name', 'kMDItemFinderComment', path])
  if (!out) return { contentType: null, downloaded: null, lastUsed: null, finderComment: null }
  const get = (k) => {
    const m = new RegExp(k + '\\s*=\\s*(.+)').exec(out)
    if (!m) return null
    const v = m[1].trim()
    return v === '(null)' ? null : v.replace(/^"|"$/g, '')
  }
  return {
    contentType: get('kMDItemContentType'),
    downloaded: get('kMDItemDownloadedDate'),
    lastUsed: get('kMDItemLastUsedDate'),
    finderComment: get('kMDItemFinderComment')
  }
}

export async function finderTags(path) {
  const hex = await safeRun('xattr', ['-p', TAG_XATTR, path])
  if (!hex) return []
  const clean = String(hex).replace(/[^0-9a-fA-F]/g, '')
  if (clean.length < 16) return []
  const ascii = Buffer.from(clean, 'hex').toString('latin1')
  const matches = ascii.match(/[\x20-\x7E\u4E00-\u9FFF]{2,}/g) || []
  return matches.filter(s => !/^(bplist00|NSArray|NSString|CFString|\$objects|\$top|U\$null|\x00)/.test(s)).slice(0, 8)
}

export async function imageSize(path) {
  const sharp = loadSharp()
  if (sharp) {
    try { const m = await sharp(path).metadata(); return { width: m.width || null, height: m.height || null, source: 'sharp' } }
    catch (e) { /* 降级到 sips */ }
  }
  const out = await safeRun('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path])
  if (!out) return { width: null, height: null, source: null }
  const w = /pixelWidth:\s*(\d+)/.exec(out), h = /pixelHeight:\s*(\d+)/.exec(out)
  return { width: w ? Number(w[1]) : null, height: h ? Number(h[1]) : null, source: 'sips' }
}

export async function dHashFor(path) {
  const sharp = loadSharp()
  if (!sharp) return { phash: null, source: 'unsupported_no_sharp' }
  try {
    const raw = await sharp(path).resize(9, 8, { fit: 'fill' }).greyscale().raw().toBuffer()
    return { phash: dHashFromRaw(raw), source: 'sharp' }
  } catch (e) { return { phash: null, source: 'unsupported_decode' } }
}

export function textFingerprint(path) {
  const ext = extOf(path)
  if (!TEXT_EXTS.has(ext)) return { text_fp: null, excerpt: null, source: 'unsupported_ext' }
  try {
    const fd = readFileSync(path)
    const buf = fd.subarray(0, TEXT_LIMIT)
    const text = buf.toString('utf8')
    return { text_fp: simHash(text), excerpt: text.slice(0, 500), source: 'simhash' }
  } catch (e) { return { text_fp: null, excerpt: null, source: 'unreadable' } }
}

/** 汇总一个文件所有可观测信号（供 recognize.js 与扫描索引共用）。 */
export async function collectSignals(path, stat) {
  const ext = extOf(path)
  const isImage = IMAGE_EXTS.has(ext)
  const isText = TEXT_EXTS.has(ext)
  const [wf, md, ft, isz, dh] = await Promise.all([
    whereFroms(path), mdlsInfo(path), finderTags(path),
    isImage ? imageSize(path) : Promise.resolve({ width: null, height: null, source: null }),
    isImage ? dHashFor(path) : Promise.resolve({ phash: null, source: 'not_image' })
  ])
  const tf = isText ? textFingerprint(path) : { text_fp: null, excerpt: null, source: 'not_text' }
  const st = stat || statSync(path)
  return {
    path, name: path.split('/').pop(), ext,
    size: Number(st.size), mtime: st.mtime.toISOString(),
    where_from: wf.whereFrom, content_type: md.contentType,
    downloaded: md.downloaded, last_used: md.lastUsed || null,
    finder_comment: md.finderComment, finder_tags: ft,
    image_width: isz.width, image_height: isz.height,
    phash: dh.phash, phash_source: dh.source,
    text_fp: tf.text_fp, text_excerpt: tf.excerpt, text_source: tf.source
  }
}
