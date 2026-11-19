// 标签规则表：逐行搬自 flowfinder-native/rust-core/src/core/tags.rs:43-90 与 :144-151。
// 诚实标注：这是扩展名 + 文件大小的规则分类，不是 AI 语义识别；语义识别在 recognize.js。
export const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024

const GROUPS = [
  { category: 'image', name: '图片', color: '#FF6B35', exts: 'jpg jpeg png gif heic heif tiff tif bmp webp raw cr2 nef arw dng svg ico psd ai sketch' },
  { category: 'video', name: '视频', color: '#FF3B30', exts: 'mp4 mov avi mkv m4v wmv flv webm mpg mpeg 3gp mts m2ts' },
  { category: 'audio', name: '音频', color: '#AF52DE', exts: 'mp3 wav flac aac m4a ogg wma aiff aif opus mka' },
  { category: 'document', name: '文档', color: '#007AFF', exts: 'pdf doc docx txt rtf pages odt md markdown tex epub mobi' },
  { category: 'spreadsheet', name: '表格', color: '#34C759', exts: 'xls xlsx csv numbers ods tsv' },
  { category: 'presentation', name: '演示', color: '#FF9500', exts: 'ppt pptx key odp' },
  { category: 'code', name: '代码', color: '#5856D6', exts: 'swift rs py js ts tsx jsx go java kt c cpp cc cxx h hpp rb php sh bash zsh fish lua r scala clj ex exs elm hs ml nim v zig dart vue svelte json yaml yml toml xml ini conf env gradle cmake make mk dockerfile gitignore' },
  { category: 'archive', name: '归档', color: '#8E8E93', exts: 'zip rar 7z tar gz bz2 xz lz lzma zst dmg iso img pkg deb rpm' }
]

const EXT_MAP = new Map()
for (const group of GROUPS) for (const ext of group.exts.split(' ')) if (ext) EXT_MAP.set(ext, group)

export function classifyEntry(name, size, isDir) {
  const tags = []
  if (isDir) { tags.push({ name: '文件夹', color: '#007AFF', category: 'folder' }); return tags }
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  const group = EXT_MAP.get(ext)
  if (group) tags.push({ name: group.name, color: group.color, category: group.category })
  if (Number.isFinite(size) && size > LARGE_FILE_THRESHOLD) tags.push({ name: '大文件', color: '#FF3B30', category: 'large_file' })
  return tags
}

export function allGroups() { return GROUPS.map(g => ({ name: g.name, color: g.color, category: g.category })) }

/** 按文件名取分类 category（不认识就空串）。预设方案用它，不依赖宿主回传的 tags。 */
export function categoryOfName(name) {
  const g = EXT_MAP.get(extOf(name))
  return g ? g.category : ''
}

export const IMAGE_EXTS = new Set('jpg jpeg png gif heic heif tiff tif bmp webp'.split(' '))
export const TEXT_EXTS = new Set('txt md markdown json js ts jsx tsx csv html htm xml yaml yml log ini conf toml'.split(' '))

export function extOf(name) {
  const dot = String(name).lastIndexOf('.')
  return dot > 0 ? String(name).slice(dot + 1).toLowerCase() : ''
}
