// 相似文件查找：图片 dHash（汉明 ≤6）、文本 SimHash（≤8）、弱信号（名+ext+size）。
// 弱信号标 weak 且不可批量操作。纯函数，输入 files 行。
import { hammingHex, weakSimilar } from './hash.js'

export const IMAGE_DISTANCE = 6
export const TEXT_DISTANCE = 8

export function strongSimilar(items, target, opts) {
  const o = opts || {}
  const imgDist = o.imageDistance ?? IMAGE_DISTANCE
  const txtDist = o.textDistance ?? TEXT_DISTANCE
  const out = []
  for (const f of items) {
    if (f.path === target.path || f.is_dir || f.missing) continue
    if (target.phash && f.phash && hammingHex(target.phash, f.phash) <= imgDist) {
      out.push({ path: f.path, name: f.name, size: f.size, basis: 'dHash', distance: hammingHex(target.phash, f.phash), strength: 'strong' })
    } else if (target.text_fp && f.text_fp && hammingHex(target.text_fp, f.text_fp) <= txtDist) {
      out.push({ path: f.path, name: f.name, size: f.size, basis: 'SimHash', distance: hammingHex(target.text_fp, f.text_fp), strength: 'strong' })
    }
  }
  return out
}

export function weakMatches(items, target) {
  const out = []
  for (const f of items) {
    if (f.path === target.path) continue
    if (weakSimilar(target, f)) out.push({ path: f.path, name: f.name, size: f.size, basis: '名称+类型+大小', strength: 'weak' })
  }
  return out
}

export function similarFromDb(db, path, opts) {
  const target = db.prepare('SELECT * FROM files WHERE path=?').get(path)
  if (!target) return { target: null, strong: [], weak: [], basis: 'not_found' }
  const root = target.root || null
  const items = root
    ? db.prepare('SELECT * FROM files WHERE root=? AND missing=0 AND is_dir=0').all(root)
    : db.prepare('SELECT * FROM files WHERE missing=0 AND is_dir=0').all()
  return { target: { path: target.path, name: target.name }, strong: strongSimilar(items, target, opts), weak: weakMatches(items, target), basis: 'phash+text_fp+weak' }
}
