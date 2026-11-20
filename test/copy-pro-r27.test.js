import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ui = readFileSync(join(here, '../src/client-tahoe-ui.js'), 'utf8')
const style = readFileSync(join(here, '../src/client-tahoe.js'), 'utf8')
const build = readFileSync(join(here, '../scripts/build.mjs'), 'utf8')

// 第 27 轮（m12160 诉求 3）：移除全部测试相关的界面文案，所有文本专业、严谨。
// 设计：badge 不再写「测试版」，改为构建期从 package.json 注入真实版本号（单一事实源，发版不撒谎）。
test('侧栏 badge 不再出现「测试版」字眼', () => {
  assert.ok(!ui.includes('测试版'), 'client-tahoe-ui.js 不应再有「测试版」badge 文案')
  assert.ok(!style.includes('sb-tag-beta'), 'client-tahoe.js 不应再保留警告色 beta 样式类')
})

test('badge 用 FF_VERSION 占位符（源文件不含硬编码版本）', () => {
  assert.ok(ui.includes("FF_VERSION"), 'client-tahoe-ui.js 应有 FF_VERSION 占位符')
  assert.ok(!/v\d+\.\d+\.\d+/.test(ui), 'client-tahoe-ui.js 不应硬编码版本号字符串')
})

test('构建脚本注入版本：读 package.json + replaceAll(FF_VERSION)', () => {
  assert.ok(build.includes("package.json"), 'build.mjs 应读取 package.json 取版本')
  assert.ok(build.includes("FF_VERSION"), 'build.mjs 应引用 FF_VERSION')
  assert.ok(build.includes("replaceAll"), 'build.mjs 应 replaceAll 注入版本')
})
