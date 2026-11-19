// FlowFile 路径白名单：默认只允许 本机用户目录 + /Volumes（含 SMB 挂载卷）。
// 与 flowfinder-native/rust-core/src/core/path_guard.rs 同思路，额外挡住凭据位置，
// 并用 realpath 展开符号链接：/Volumes/Iris 是指向 / 的软链，不处理会把浏览卷变成浏览整个根目录。
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve, relative, sep, join, dirname, basename } from 'node:path'

const DENY_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws', '.kube', 'Keychains'])

// 第 26 轮：允许访问系统盘，但不是「放开整盘」。
// 只在根下放行这几类用户可感知的位置；系统实现目录（/etc /private /var /dev /bin /sbin
// /cores /tmp /home /pkg /System）继续拒绝——它们对文件管理没有意义，且是凭据与系统配置所在地。
// 判据用一级段名，所以 /etc -> /private/etc 的 firmlink 也会被同一套规则拦住。
const SYSTEM_TOP = new Set(['Applications', 'Library', 'opt', 'usr'])
// /Users 只作为中转层放行（外加共享目录），别的账户目录不因此变得可读：
// 具体路径仍要落在 homedir 根内才合法。
const SYSTEM_PATHS = new Set(['/Users', '/Users/Shared'])
const DENY_NAMES = new Set(['.credentials.yaml', 'id_rsa', 'id_ed25519', '.env'])

export function defaultRoots() { return [homedir(), '/Volumes'] }

function firstSegment(p) {
  const parts = String(p || '').split(sep).filter(Boolean)
  return parts.length ? parts[0] : ''
}

/** 根下的一级目录是否属于可浏览的系统位置（Applications / Library / opt / usr）。 */
function isSystemTop(p) { return SYSTEM_TOP.has(firstSegment(p)) }
function isSystemPath(p) { return SYSTEM_PATHS.has(String(p || '')) }

function realOf(p) { try { return realpathSync(p) } catch (e) { return p } }

// 展开路径里所有能解析的软链；尾段不存在时逐层回退到最近存在的祖先再拼回去。
function deepestRealPath(p) {
  let cur = p
  const tail = []
  for (;;) {
    try {
      const real = realpathSync(cur)
      return tail.length ? join(real, ...tail.reverse()) : real
    } catch (e) {
      const parent = dirname(cur)
      if (parent === cur) return p
      tail.push(basename(cur))
      cur = parent
    }
  }
}

function withinAny(p, roots) {
  for (const root of roots) {
    const rel = relative(root, p)
    if (rel === '') return true
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) continue
    return true
  }
  return false
}

export function isAllowed(absPath, roots) {
  if (typeof absPath !== 'string' || !isAbsolute(absPath)) return false
  const parts = absPath.split(sep)
  for (const part of parts) if (DENY_SEGMENTS.has(part)) return false
  const base = parts[parts.length - 1]
  if (DENY_NAMES.has(base)) return false
  if (/\.(pem|key|p12)$/.test(base)) return false
  // 磁盘根本身允许列出（不然侧栏「系统盘」点进去就是 403）；
  // 但它的子项必须逐个过白名单，所以「能列根」不等于「能读整盘」。
  if (absPath === sep) return true

  // 展开软链后的真实路径（/var → /private/var 这类 firmlink 也算）。
  // 所有根都同时收进「词法 + 真实」两套形态，输入是词法路径还是已 realpath 的路径都能正确判定。
  const real = deepestRealPath(absPath)
  const allRoots = [...new Set(roots.flatMap(r => [r, realOf(r)]))]
  // 只要输入路径和它的真实路径都落在同一套允许根集合内，就算合法；
  // /Volumes/Iris -> / 这类软链，真实路径 '/' 不在任何允许根内，仍会被拒。
  if (withinAny(absPath, allRoots) && withinAny(real, allRoots)) return true

  // 系统盘白名单：词法路径与真实路径的一级段都要在白名单里，避免软链把拒绝项夹带进来。
  if (isSystemTop(absPath) && isSystemTop(real)) return true
  return isSystemPath(absPath) && isSystemPath(real)
}

export function createGuard(roots) {
  const list = (roots && roots.length ? roots : defaultRoots()).map(r => resolve(r))
  return {
    roots: list,
    assertAllowed(p) {
      if (typeof p !== 'string' || !p.trim()) throw Object.assign(new Error('缺少路径'), { status: 400 })
      const abs = resolve(p)
      if (!isAllowed(abs, list)) throw Object.assign(new Error('路径不在允许范围内：' + list.join('、')), { status: 403 })
      return abs
    },
    isAllowed(p) { return isAllowed(resolve(p), list) }
  }
}
