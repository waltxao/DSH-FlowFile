// FlowFile 删除执行门（第二个被显式授权可写业务文件的模块，与 ops.js 并列）。
// 唯一职责：把文件送进可恢复的回收站，返回精确落点。
//   native 路径：trash -v（macOS 系统废纸篓），成功则原样返回系统落点。
//   降级路径 ：仅当 trash 明确报「该卷没有废纸篓」(NSCocoaErrorDomain 3328 / dirNFErr -120)
//              且源确实位于某个 /Volumes/<卷> 内时，做同卷原子 renameSync 到
//              <卷根>/.flowfile-trash/<uuid>-<原名> + 卷内自管 RESTORE-MANIFEST.json。
// 其它任何失败（权限、断连、落点缺失）一律中止，绝不降级、绝不 rm/unlink。
// 永不实现：永久删除、跨卷搬运、无人值守删除、静默吞错。
import { existsSync, renameSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const TRASH_DIR = '.flowfile-trash'
const MANIFEST_NAME = 'RESTORE-MANIFEST.json'

/** 解析 trash -v 的输出：# Moved "<src>" to "<trash_path>" */
export function parseTrashOutput(out) {
  const m = /to\s+"([^"]+)"/.exec(String(out || ''))
  return m ? m[1] : null
}

/** 词法求 SMB 卷根：/Volumes/<卷>/<至少一段> → /Volumes/<卷>；其余一律 null。
 *  拒绝 /Volumes 自身与 /Volumes/<卷> 自身（那是卷根，不是待删文件）。 */
export function volumeRootOf(p) {
  const s = String(p || '')
  if (!s.startsWith('/Volumes/')) return null
  const seg = s.slice('/Volumes/'.length).split('/').filter(Boolean)
  if (seg.length < 2) return null
  return '/Volumes/' + seg[0]
}

/** 是否「该卷没有废纸篓」类错误。只在 trash 抛出后调用，故可用特征码精确匹配。 */
export function isNoTrashError(x) {
  const s = String(x == null ? '' : x)
  if (!s) return false
  return /Code=3328/.test(s)
    || /dirNFErr/.test(s)
    || /Code=-120/.test(s)
    || /(couldn.t|could not) be moved to the trash/i.test(s)
    || /(doesn.t|does not) have one/i.test(s)
}

// 可注入依赖：让 node --test 不必真的调系统 trash / 不必真的碰 SMB 卷。
// 生产环境 _runner=null → 走 defaultRunner；_volumeRoot=volumeRootOf。
let _runner = null
let _volumeRoot = volumeRootOf

export function setTrashDeps(runner, volumeRootFn) {
  _runner = runner || null
  _volumeRoot = volumeRootFn || volumeRootOf
}
export function resetTrashDeps() {
  _runner = null
  _volumeRoot = volumeRootOf
}

function defaultRunner(src) {
  return execFileSync('trash', ['-v', src], { encoding: 'utf8', timeout: 15000 })
}

function errMsg(detail) {
  return String(detail || '').replace(/\s+/g, ' ').slice(0, 400)
}

/** 卷内自管恢复清单：追加式，绝不覆盖既有条目；写失败只告警不回滚已完成的原子移动
 *  （主恢复链是 ops_items.trash_path + 用户目录 RESTORE-MANIFEST，本清单是第二保险）。 */
function appendVolumeManifest(vol, src, dest) {
  const mf = join(vol, TRASH_DIR, MANIFEST_NAME)
  let doc = { version: 1, volume: vol,
    note: 'FlowFile SMB 卷内自建回收站；恢复规则 mv <trash_path> <src>', entries: [] }
  try {
    const old = JSON.parse(readFileSync(mf, 'utf8'))
    if (old && Array.isArray(old.entries)) doc = old
  } catch (e) { /* 首次创建或旧清单损坏，用新 doc */ }
  doc.entries.push({ src, trash_path: dest, volume: vol, mode: 'fallback',
    at: Math.floor(Date.now() / 1000) })
  try {
    writeFileSync(mf, JSON.stringify(doc, null, 2), 'utf8')
  } catch (e) {
    // 清单写失败：落点仍返回，ops 会记进 trash_path 与用户目录清单，undo 不受影响。
    console.warn('[flowfile] 卷内 RESTORE-MANIFEST 写入失败（不影响本次可撤销性）：' + e.message)
  }
}

/** 同卷原子降级：不复制、不跨卷、不删除。落点用 randomUUID 保证唯一，绝不覆盖。 */
function fallbackMove(src, vol) {
  const dir = join(vol, TRASH_DIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: false })
  const dest = join(dir, randomUUID() + '-' + basename(src))
  renameSync(src, dest)              // 同卷 rename 是原子的；EXDEV/失败会抛出并被上层中止
  appendVolumeManifest(vol, src, dest)
  return dest
}

/** 把 src 送进回收站，返回精确落点。任何非预期失败都抛错（调用方 doTrash 包成 status 500）。 */
export function trashFile(src) {
  const runner = _runner || defaultRunner
  let out
  try {
    out = runner(src)
  } catch (e) {
    const detail = [e && e.stderr, e && e.stdout, e && e.message].filter(Boolean).join('\n')
    if (isNoTrashError(detail)) {
      const vol = _volumeRoot(src)
      if (!vol) {
        throw new Error('trash 报该卷无系统废纸篓，但源不在可降级的 SMB 卷内，中止（不降级为 rm）：' + errMsg(detail))
      }
      return fallbackMove(src, vol)
    }
    throw new Error('trash 执行失败且非「卷无废纸篓」，中止（不降级为 rm）：' + errMsg(detail))
  }
  const trashPath = parseTrashOutput(out)
  if (!trashPath || !existsSync(trashPath)) {
    throw new Error('trash 未报告落点或落点不存在，中止（不降级为 rm）')
  }
  return trashPath
}
