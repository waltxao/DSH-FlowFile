// Client 侧格式化工具（纯函数，无 DOM 依赖）。
// 方向 A / WIG A23：大小与时间一律走 Intl.*，不手写单位换算与日期拼接。
function fdSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, i)
  const digits = i === 0 ? 0 : (value >= 100 ? 0 : value >= 10 ? 1 : 2)
  return new Intl.NumberFormat('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value) + ' ' + units[i]
}

function fdTime(iso) {
  if (!iso) return '—'
  const d = new Date(typeof iso === 'string' && /^\d+$/.test(iso) ? Number(iso) : iso)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
}

// 时间归一（第 25 轮）：接口给的 mtime 是 ISO 字符串，但旧代码有几处按毫秒数比较
// （Number(iso) → NaN → 恒为「很久以前」），结果「近 7 天修改」永远是 0。
// 所有时间比较一律先过这个函数，返回毫秒；无法解析时返回 0（视作远古，不误判为「刚改过」）。
function fdTimeMs(v) {
  if (v === null || v === undefined || v === '') return 0
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const s = String(v)
  if (/^\d+$/.test(s)) { const n = Number(s); return Number.isFinite(n) ? n : 0 }
  const t = new Date(s).getTime()
  return Number.isNaN(t) ? 0 : t
}

function fdKind(e) { return e && e.isDir ? '文件夹' : (e && e.ext ? String(e.ext).replace(/^\./, '').toUpperCase() + ' 文件' : '文件') }
function fdBase(p) { return String(p || '').split('/').filter(Boolean).pop() || '/' }
// 父目录：太长时保留首尾两段，中间用省略号，避免撑破属性格
function fdParent(p) {
  const parts = String(p || '').split('/').filter(Boolean)
  if (parts.length < 2) return '/'
  const dirs = parts.slice(0, -1)
  if (dirs.length <= 2) return '/' + dirs.join('/')
  return '/' + dirs[0] + '/…/' + dirs[dirs.length - 1]
}
function fdPct(a, b) { return b > 0 ? Math.round(a * 100 / b) : 0 }
