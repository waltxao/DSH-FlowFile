import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const app = fs.readFileSync(path.join(root, 'src/client-app.js'), 'utf8')
const css = fs.readFileSync(path.join(root, 'src/client-style.js'), 'utf8')
const dist = fs.readFileSync(path.join(root, 'dist/client.js'), 'utf8')

test('可调布局：三栏与右栏上下都靠 CSS 变量而不是写死像素', () => {
  assert.ok(css.indexOf('--fd-tree-w') >= 0, '目录树宽度应走 CSS 变量')
  assert.ok(css.indexOf('--fd-right-w') >= 0, '右栏宽度应走 CSS 变量')
  assert.ok(css.indexOf('--fd-dock-h') >= 0, '底部对话 dock 高度应走 CSS 变量')
  assert.ok(css.indexOf('.fd-splitter') >= 0, '需要分隔条样式')
})

test('可调布局：不再有 .fd-right{width:340px} 与 .fd-tree{width:210px} 写死', () => {
  assert.equal(/\.fd-tree\{width:\d+px/.test(css), false, '.fd-tree 不应写死宽度')
  assert.equal(/\.fd-right\{width:\d+px/.test(css), false, '.fd-right 不应写死宽度')
})

// 第 20 轮（m09643）：新骨架是设计稿的固定比例卡片（侧栏 222 + 卡片 flex + 检查器 282），
// 不再有左树/右栏/底栏三根可拖分隔条；但「尺寸不写死 + 用户偏好持久化」两条原意必须保留。
test('可调布局：拖拽状态机与持久化仍在（骨架不再需要三条分隔条）', () => {
  assert.ok(app.indexOf('fdStartDrag') >= 0, '需要拖拽启动函数 fdStartDrag（保留给后续可调项）')
  assert.ok(app.indexOf('dragRef') >= 0, '需要拖拽游标 dragRef')
  assert.ok(app.indexOf('flowfile.layout') >= 0, '布局需要持久化到 localStorage')
  assert.ok(app.indexOf('fdLoadDensity') >= 0 && app.indexOf('fdSaveDensity') >= 0, '密度偏好需可持久化')
  assert.equal(app.includes('fdStartDrag(\'tree\''), false, '新骨架不再有左树分隔条（侧栏固定 222px）')
})

test('可调布局：预览区不再被 max-height 截断', () => {
  assert.equal(/\.fd-right-top\{[^}]*max-height:55%/.test(css), false, '预览区不应再靠 max-height:55% 截断')
  assert.ok(css.includes('.fd-right-top{flex:1 1 auto'), '预览区应占满右栏剩余高度')
})

test('可调布局：dist 已同步', () => {
  assert.ok(dist.indexOf('--fd-right-w') >= 0, 'dist 应含右栏变量')
  assert.ok(dist.indexOf('fd-splitter') >= 0, 'dist 应含分隔条')
})
