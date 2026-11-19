// sharp 可选加载器：宿主 profile（hoisted node_modules）里已装 0.35.5。
// 本机源码目录直接跑测试时解析不到，降级为 null（图片相似标 unsupported，不阻断其它能力）。
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

let cached
export function loadSharp() {
  if (cached !== undefined) return cached
  const anchors = [import.meta.url, join(homedir(), '.dsh', 'profiles', 'desktop', 'package.json')]
  for (const a of anchors) {
    try { const s = createRequire(a)('sharp'); if (typeof s === 'function') { cached = s; return cached } }
    catch (e) { /* 继续下一个锚点 */ }
  }
  cached = null
  return cached
}
