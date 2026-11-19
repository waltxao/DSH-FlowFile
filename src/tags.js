// 属性识别：元数据 + 规则标签 + macOS Finder 标签（xattr）读取。只读，不做任何写回。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { classifyEntry } from './rules.js'

const run = promisify(execFile)
const TAG_XATTR = 'com.apple.metadata:_kMDItemUserTags'

export async function finderTags(path) {
  if (process.platform !== 'darwin') return []
  try {
    const out = await run('xattr', ['-p', TAG_XATTR, path], { timeout: 3000, maxBuffer: 1024 * 256 })
    const hex = String(out.stdout || '').replace(/[^0-9a-fA-F]/g, '')
    if (hex.length < 16) return []
    const buf = Buffer.from(hex, 'hex').toString('latin1')
    const matches = buf.match(/[\x20-\x7E\u4E00-\u9FFF]{2,}/g) || []
    return matches.filter(s => !/^(bplist00|NSArray|NSString|CFString|\$objects|\$top|U\$null|\x00)/.test(s)).slice(0, 8)
  } catch (e) { return [] }
}

export function attributesFor(entry) {
  return {
    path: entry.path, name: entry.name, isDir: entry.isDir,
    size: entry.size, mtime: entry.mtime, birthtime: entry.birthtime,
    ext: entry.ext, mode: entry.mode, tags: entry.tags,
    source: '扩展名规则 + 文件元数据 + Finder xattr'
  }
}
