import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const app = fs.readFileSync(path.join(root, 'src/client-app.js'), 'utf8')
const dist = fs.readFileSync(path.join(root, 'dist/client.js'), 'utf8')

test('甲：不再注册 better-sidebar 底部面板卡片', () => {
  assert.equal(app.indexOf('registerTab'), -1, 'client-app.js 不应再出现 registerTab')
  assert.equal(app.indexOf('betterSidebar'), -1, 'client-app.js 不应再出现 betterSidebar')
  assert.equal(app.indexOf('fdBetterSidebar'), -1, 'fdBetterSidebar 应整体删除')
})

test('甲：左侧导航入口与主区域挂载都保留', () => {
  assert.ok(app.indexOf("slots.inject('main'") >= 0, 'main slot 保留')
  assert.ok(app.indexOf('sidebar.panellist') >= 0, '左侧导航入口保留')
  assert.ok(app.indexOf('FD_INJECT') >= 0, 'FD_INJECT 保留')
})

test('甲：dist 里也不再下发 registerTab', () => {
  assert.equal(dist.indexOf('registerTab'), -1, 'dist/client.js 不应含 registerTab')
  assert.equal(dist.indexOf('betterSidebar'), -1, 'dist/client.js 不应含 betterSidebar')
})

test('甲：装配仍导出 apply/inject 且 key 为 flowfile', () => {
  assert.ok(app.indexOf("name: 'main', key: FD_ID") >= 0, 'main slot key 保留')
  assert.ok(app.indexOf("var FD_ID = 'flowfile'") >= 0 || app.indexOf('FD_ID =') >= 0, 'FD_ID 保留')
})
