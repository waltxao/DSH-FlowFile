// 无打包器构建：把 client 侧纯脚本拼进 window.__ModuleLoader__.load 包装。
// 契约照抄 dsh-media-desk/dist/client.js 首尾；React 由宿主模块表提供。
// 约定：所有 client 源文件不用模板字符串，因此拼接安全。
//
// bundle id 与包名不必相同：官方 dsh-media-desk 的包名是 dsh-media-desk，bundle id 是 "media-desk"。
// 这里刻意保留短标识 "flowfile"——宿主按 id 缓存已加载的模块，把 id 跟着包名一起改，
// 会让旧缓存实例与新 bundle 用同一个 id 各注册一次，页面直接 white-screen（duplicate factory registration）。
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// browse-core.js 是 ESM（供 node --test 导入）；拼进 bundle 前逐行剥掉顶层 "export " 前缀。
// 这样纯逻辑只写一份，Node 测试与浏览器运行时共用同一份源码。
// 注意：presets.js 是 host 侧模块（含 import rules.js），不进 client bundle ——
// 浏览器侧只通过 /flowfile/preset 与 /flowfile/presets 两个接口拿数据（api.js 的 ffPresetPlan / ffPresets）。

const esmParts = ['src/browse-core.js', 'src/clean-core.js']
const plainParts = [
  'src/client-style.js',
  'src/client-tahoe.js',
  'src/icons-lucide.js',
  'src/api.js',
  'src/format.js',
  'src/client-ui.js',
  'src/client-browse.js',
  'src/client-tahoe-ui.js',
  'src/client-clean.js',
  'src/client-app.js'
]
let body = ''
for (const p of esmParts) {
  const src = await readFile(join(root, p), 'utf8')
  body += src.split('\n').map(line => /^export\s/.test(line) ? line.replace(/^export\s+/, '') : line).join('\n').trim() + '\n\n'
}
for (const p of plainParts) body += (await readFile(join(root, p), 'utf8')).trim() + '\n\n'

const bundle = [
  'window.__ModuleLoader__.load({id:"flowfile",factory:(require)=>{',
  'const module={exports:{}};const exports=module.exports;',
  'var React=require("react");',
  body,
  'var __ff={apply:fdApply,inject:FD_INJECT};',
  'module.exports=Object.assign(Object.defineProperty({},"__esModule",{value:true}),__ff);',
  'return module.exports}});'
].join('\n')

await mkdir(join(root, 'dist'), { recursive: true })
await writeFile(join(root, 'dist/client.js'), bundle, 'utf8')
console.log('built dist/client.js', Buffer.byteLength(bundle), 'bytes')
