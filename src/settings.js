// 设置与安全策略（第 17 轮 m07721）：智能识别默认关闭、可选本地 AI、可选预识别。
//
// 三条硬约束（写死在这里，不交给 UI）：
// 1. 默认关闭：DEFAULT_SETTINGS.ai.mode = 'off'。用户不动设置，就永远不会发生任何模型调用。
// 2. 未经允许不上传：'host' 模式必须 allowCloud === true 才放行；'local' 模式只允许 loopback 端点。
//    任何不满足的组合都返回 allowed:false，调用方据此回落「纯规则卡片」，而不是偷偷上传。
// 3. 模型输出仍是不可信输入：派生标签只从 PRESET_TAGS 白名单里取，绝不把模型自由文本直接当标签。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'

export const SETTINGS_VERSION = 1

// 白名单标签：派生标签只能从这里取。中英文都不用模型的原话。
export const PRESET_TAGS = [
  '图片', '截图', '照片', '设计稿', '视频', '音频', '文档', '表格', '演示',
  '代码', '归档', '安装包', '大文件', '可清理', '重要', '未知来源'
]

export const DEFAULT_SETTINGS = {
  version: SETTINGS_VERSION,
  ai: {
    // off = 完全关闭（默认）；local = 本地 Ollama/兼容端点；host = 宿主默认模型（可能上传）
    mode: 'off',
    localBaseUrl: 'http://127.0.0.1:11434/v1',
    localModel: '',
    allowCloud: false,
    timeoutMs: 60000
  },
  recognize: {
    // 预识别：开启后进入目录时主动识别首层文件（默认关闭，因为会产生模型调用）
    preScan: false,
    preScanDepth: 1,
    preScanLimit: 20,
    cacheDays: 30,
    autoTags: true
  }
}

const MODES = ['off', 'local', 'host']

function int(n, def, lo, hi) {
  const v = Number(n)
  if (!Number.isFinite(v)) return def
  return Math.max(lo, Math.min(hi, Math.round(v)))
}

function str(v, def, max) {
  if (typeof v !== 'string') return def
  const s = v.trim()
  return s ? s.slice(0, max) : def
}

/** 任何脏配置都收敛到安全侧：非法 mode 一律 off，allowCloud 只认 true。 */
export function normalizeSettings(raw) {
  const o = (raw && typeof raw === 'object') ? raw : {}
  const ai = (o.ai && typeof o.ai === 'object') ? o.ai : {}
  const rc = (o.recognize && typeof o.recognize === 'object') ? o.recognize : {}
  const mode = MODES.includes(ai.mode) ? ai.mode : 'off'
  return {
    version: SETTINGS_VERSION,
    ai: {
      mode,
      localBaseUrl: str(ai.localBaseUrl, DEFAULT_SETTINGS.ai.localBaseUrl, 300),
      localModel: str(ai.localModel, '', 120),
      allowCloud: ai.allowCloud === true,
      timeoutMs: int(ai.timeoutMs, DEFAULT_SETTINGS.ai.timeoutMs, 5000, 180000)
    },
    recognize: {
      preScan: rc.preScan === true,
      preScanDepth: int(rc.preScanDepth, 1, 1, 2),
      preScanLimit: int(rc.preScanLimit, 20, 1, 200),
      cacheDays: int(rc.cacheDays, 30, 0, 3650),
      autoTags: rc.autoTags !== false
    }
  }
}

export function settingsDir() { return process.env.FLOWFILE_HOME || join(homedir(), '.flowfile') }
export function settingsPath(dir) { return join(dir || settingsDir(), 'settings.json') }

export function loadSettings(p) {
  const file = p || settingsPath()
  try {
    if (!existsSync(file)) return normalizeSettings(null)
    return normalizeSettings(JSON.parse(readFileSync(file, 'utf8')))
  } catch (e) {
    return normalizeSettings(null)
  }
}

export function saveSettings(p, next) {
  const file = p || settingsPath()
  const clean = normalizeSettings(next)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(clean, null, 2), 'utf8')
  } catch (e) { /* 只读卷：不阻断 UI，下次读回默认值 */ }
  return clean
}

/** 只认本机回环：127.0.0.0/8、::1、localhost。内网 IP 与公网一律不是「本地」。 */
export function isLocalEndpoint(url) {
  let u
  try { u = new URL(String(url || '')) } catch (e) { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/** 上传策略：决定这次识别能不能把信号发出去、发到哪。 */
export function uploadPolicy(settings) {
  const s = normalizeSettings(settings)
  if (s.ai.mode === 'off') {
    return { allowed: false, uplink: 'none', reason: '识别已关闭（默认），只显示规则标签，不调用任何模型' }
  }
  if (s.ai.mode === 'local') {
    if (!isLocalEndpoint(s.ai.localBaseUrl)) {
      return { allowed: false, uplink: 'none', reason: '本地 AI 只能指向本机回环地址（127.0.0.1 / localhost / ::1），当前地址不是本机' }
    }
    return { allowed: true, uplink: 'local', reason: '本地 AI：数据不出本机', baseUrl: s.ai.localBaseUrl, model: s.ai.localModel }
  }
  if (!s.ai.allowCloud) {
    return { allowed: false, uplink: 'none', reason: '宿主模型可能由 AI 服务商处理，需要先在设置页显式勾选「同意上传」；未勾选时不上传任何内容' }
  }
  return { allowed: true, uplink: 'cloud', reason: '宿主模型：文件元数据可能被 AI 服务商处理（已显式授权）' }
}

/** 从识别卡片派生白名单标签。模型说什么都只当「线索」，最终只输出 PRESET_TAGS 里的词。 */
export function deriveTags(card, entry) {
  const c = (card && typeof card === 'object') ? card : {}
  const e = entry || {}
  const hay = [c.what, c.usage, c.from, e.ext, e.name].filter(v => typeof v === 'string').join(' ').toLowerCase()
  const out = []
  const add = (t) => { if (PRESET_TAGS.includes(t) && out.indexOf(t) < 0) out.push(t) }
  const has = (re) => re.test(hay)

  if (has(/截图|screenshot|截屏/)) add('截图')
  else if (has(/照片|photo|相机|camera/)) add('照片')
  else if (has(/png|jpg|jpeg|gif|webp|heic|tiff|bmp|图片|image/)) add('图片')
  if (has(/设计|figma|sketch|草稿|mockup|原型/)) add('设计稿')
  if (has(/视频|mp4|mov|mkv|avi|video/)) add('视频')
  if (has(/音频|mp3|wav|flac|m4a|audio/)) add('音频')
  if (has(/表格|xlsx|csv|spreadsheet/)) add('表格')
  if (has(/演示|ppt|pptx|keynote|slide/)) add('演示')
  if (has(/pdf|docx|word|文档|document|markdown|\.md\b/)) add('文档')
  if (has(/源码|代码|\.js\b|\.ts\b|\.py\b|\.swift\b|code/)) add('代码')
  if (has(/归档|压缩|zip|rar|7z|tar|gz/)) add('归档')
  if (has(/安装包|dmg|pkg|installer/)) add('安装包')
  if (c.cleanable === 'yes') add('可清理')
  if (c.from && c.from !== 'unknown') add('重要')
  if (c.from === 'unknown' || c.sourceUnknown) add('未知来源')
  return out
}

/** 缓存 key：路径 + 大小 + 修改时间 + 模式。任一变化即视为新条目。 */
export function cacheKeyFor(entry, mode) {
  const e = entry || {}
  const seed = [String(e.path || ''), String(e.size == null ? '' : e.size), String(e.mtime || ''), String(mode || 'off')].join('|')
  return createHash('sha256').update(seed).digest('hex').slice(0, 32)
}
