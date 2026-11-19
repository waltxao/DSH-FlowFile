// 无打包器构建：把 client 侧纯脚本拼进 window.__ModuleLoader__.load 包装。
// 契约照抄 dsh-media-desk/dist/client.js 首尾；React 由宿主模块表提供。
// 约定：所有 client 源文件不用模板字符串，因此拼接安全。
//
// bundle 内部 id 必须等于包名：实测官方 dsh-media-desk（包名 dsh-media-desk）bundle id 也是
// "dsh-media-desk"，dsh-better-sidebar 同样是全名。2026-11-20 冷启动白屏事故的根因就是这里
// 曾用短标识 "flowfile"：宿主 boot manifest 按包名下发，bundle 却注册了另一个 id，
// 导致 @deepseek-ai/dsh-client-modules 二次加载时两次注册，报 duplicate factory registration，
// 侧栏入口消失。热更新时被掩盖，重启才暴露。教训：永远用全名 dsh-flowfile，别信"短名可以"的旧笔记。
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
  'window.__ModuleLoader__.load({id:"dsh-flowfile",factory:(require)=>{',
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
