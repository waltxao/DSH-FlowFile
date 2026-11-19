// 卷枚举：与 SMBFileManager/src-tauri/src/commands/volumes.rs:29,60,103 同思路。
// 不复刻 SMB 协议：只读 OS 已挂载的 /Volumes/<share>，用 mount 输出判 smbfs。
//
// 第 2 轮 ④（2026-11-13）：改「白名单式」——只显示本机用户目录 + 用户数据卷 + 网络卷。
// 系统卷（nobrowse / com.apple.* / Preboot / Recovery / VM / iSCPreboot / devicefs / 未知类型）
// 一律不显示。理由：黑名单会漏掉苹果以后新增的系统卷，白名单不会。
import { execFile } from 'node:child_process'
import { readdir, stat, lstat, realpath } from 'node:fs/promises'
import { statfsSync } from 'node:fs'
import { promisify } from 'node:util'
import { join, relative, isAbsolute, sep } from 'node:path'
import { homedir } from 'node:os'

const run = promisify(execFile)

// 系统卷名称特征：命中即隐藏，不管它的 fsType 是什么。
// 用前缀/全名而不是「黑名单逐个列」，这样以后苹果新增 com.apple.* 也不会漏。
const SYSTEM_NAME_RE = /^(?:com\.apple\.|Preboot$|Recovery$|VM$|iSCPreboot$|\.)/

// 允许出现的卷类型（volumeType 的返回值）。其余（devicefs / WEIRDFS / UNKNOWN…）一律不显示。
const VISIBLE_TYPES = new Set(['SMB', 'NFS', 'APFS', 'HFS+', '外置卷'])

function parseMountLines(stdout) {
  const rows = []
  for (const line of String(stdout || '').split('\n')) {
    const on = line.indexOf(' on /Volumes/')
    if (on < 0) continue
    const open = line.lastIndexOf(' (')
    if (open < 0) continue
    const path = line.slice(on + 4, open).trim()
    if (!path) continue
    const options = line.slice(open + 2).split(')')[0]
    const fsType = options.split(',')[0].trim().toLowerCase()
    rows.push({ path, fsType, options, nobrowse: /(^|,)\s*nobrowse\s*(,|$)/.test(options) })
  }
  return rows
}

/** 向后兼容：返回 Map<path, fsType>。core.test.js 与旧调用方依赖此形态。 */
export function parseMount(stdout) {
  const map = new Map()
  for (const r of parseMountLines(stdout)) map.set(r.path, r.fsType)
  return map
}

/** 新增：返回 Map<path, {fsType, options, nobrowse}>，供白名单过滤读完整 option。 */
export function parseMountDetail(stdout) {
  const map = new Map()
  for (const r of parseMountLines(stdout)) map.set(r.path, { fsType: r.fsType, options: r.options, nobrowse: r.nobrowse })
  return map
}

export function volumeType(fsType) {
  if (!fsType) return 'Unknown'
  if (fsType.indexOf('smb') >= 0 || fsType.indexOf('cifs') >= 0) return 'SMB'
  if (fsType.indexOf('nfs') >= 0) return 'NFS'
  if (fsType.indexOf('apfs') >= 0) return 'APFS'
  if (fsType.indexOf('hfs') >= 0) return 'HFS+'
  if (fsType.indexOf('exfat') >= 0 || fsType.indexOf('msdos') >= 0 || fsType.indexOf('ntfs') >= 0) return '外置卷'
  return fsType.toUpperCase()
}

/** 名称黑名单（系统/隐藏卷），与 fsType 无关，mount 拿不到时也能挡。 */
export function isSystemVolumeName(name) {
  return SYSTEM_NAME_RE.test(String(name || ''))
}

/**
 * 白名单判据（纯函数，供测试与运行时共用）：
 * ① 名称像系统卷 → 隐藏；② nobrowse → 隐藏；③ 类型不在可见集合 → 隐藏；否则显示。
 * 严格白名单：类型无法确认（空/unknown/未识别）一律不显示，避免把系统卷/未知设备放进来。
 * mount 命令失败时 detail 为空，/Volumes 卷会整体不显示（只保留本机），这是安全的降级。
 */
export function shouldShowVolume(name, fsType, options) {
  if (isSystemVolumeName(name)) return false
  if (/(^|,)\s*nobrowse\s*(,|$)/.test(String(options || ''))) return false
  const t = String(fsType || '').toLowerCase()
  if (!t || t === 'unknown') return false
  return VISIBLE_TYPES.has(volumeType(t))
}

/** 纯函数：按真机 mount 输出过滤 /Volumes 下的名字列表。 */
export function filterVolumeNames(names, stdout) {
  const detail = parseMountDetail(stdout)
  return (names || []).filter(function (name) {
    const d = detail.get(join('/Volumes', name))
    return shouldShowVolume(name, d ? d.fsType : '', d ? d.options : '')
  })
}

/**
 * 卷容量（第 25 轮）：侧栏的容量条与「xx 可用」必须来自真实 statfs，
 * 不能再让前端用 (18 + i*22)% 这种按索引捏的宽度冒充使用率。
 * statfs 读不到（SMB 掉线 / 权限）时只返回 null，由前端整条隐藏，而不是退化成假数据。
 */
export function volumeCapacityOf(path) {
  try {
    const s = statfsSync(path)
    const total = Number(s.blocks) * Number(s.bsize)
    const free = Number(s.bavail) * Number(s.bsize)
    if (!(total > 0) || !(free >= 0)) return null
    const used = total - free
    return { total, free, used, usedPct: Math.round(used * 100 / total) }
  } catch (e) { return null }
}

/**
 * opts 仅用于测试注入（mountOutput / names / skipStat），真机调用保持 listVolumes(guard) 不变。
 */
export async function listVolumes(guard, opts) {
  const inject = opts || {}
  let detail = new Map()
  try {
    const stdout = inject.mountOutput !== undefined ? inject.mountOutput : (await run('mount', [], { timeout: 5000 })).stdout
    detail = parseMountDetail(stdout)
  } catch (e) { /* mount 拿不到时无法确认卷类型，/Volumes 卷整体不显示（只保留本机） */ }
  const home = homedir()
  const homeCap = volumeCapacityOf(home)
  const volumes = [{ name: '本机 · 用户目录', path: home, type: '本机', fsType: 'apfs', isNetwork: false, isSmb: false,
    free: homeCap ? homeCap.free : null, total: homeCap ? homeCap.total : null, usedPct: homeCap ? homeCap.usedPct : null }]
  // 第 26 轮：加上系统盘根。此前只能从用户目录往下走，用户要看的 /Applications、
  // /Library 这些位置在界面上根本到不了。放行范围由 path-guard 的 SYSTEM_TOP 控制，
  // 这里只是把它暴露成一个可点的卷，不等于能读整盘。
  const rootCap = volumeCapacityOf('/')
  volumes.push({ name: '系统盘', path: '/', type: 'APFS', fsType: 'apfs', isNetwork: false, isSmb: false,
    free: rootCap ? rootCap.free : null, total: rootCap ? rootCap.total : null, usedPct: rootCap ? rootCap.usedPct : null })
  let volumesReal = '/Volumes'
  try { volumesReal = await realpath('/Volumes') } catch (e) { /* 保持原值 */ }
  let names = inject.names !== undefined ? inject.names : []
  if (inject.names === undefined) {
    try { names = await readdir('/Volumes') } catch (e) { names = [] }
  }
  for (const name of names) {
    if (name.charAt(0) === '.') continue
    const path = join('/Volumes', name)
    // 白名单门：系统卷 / nobrowse / 未知类型一律不显示。
    const d = detail.get(path)
    if (!shouldShowVolume(name, d ? d.fsType : '', d ? d.options : '')) continue
    let target = path
    if (!inject.skipStat) {
      try {
        const link = await lstat(path)
        if (link.isSymbolicLink()) {
          target = await realpath(path)
          const rel = relative(volumesReal, target)
          if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) continue
        }
        const info = await stat(target)
        if (!info.isDirectory()) continue
      } catch (e) { continue }
    }
    const fsType = (d && d.fsType) || detail.get(target)?.fsType || ''
    const type = volumeType(fsType)
    const cap = inject.skipStat ? null : volumeCapacityOf(target)
    volumes.push({ name: name, path: path, type: type, fsType: fsType || 'unknown', isNetwork: type === 'SMB' || type === 'NFS', isSmb: type === 'SMB',
      free: cap ? cap.free : null, total: cap ? cap.total : null, usedPct: cap ? cap.usedPct : null })
  }
  const rank = v => v.path === home ? 0 : v.path === '/' ? 1 : v.isSmb ? 2 : v.isNetwork ? 3 : 4
  volumes.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'zh'))
  return { roots: guard.roots, mode: 'flowfile', volumes: volumes }
}
