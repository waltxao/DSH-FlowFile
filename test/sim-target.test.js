import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('sim: 右键查找相似后 FF_SimPanel 必须拿到 target（sim.target 优先于 selected，否则面板永远空态）', async () => {
  const app = await readFile(new URL('../src/client-app.js', import.meta.url), 'utf8')
  const line = app.split('\n').find(l => l.includes('FF_SimPanel'))
  assert.ok(line, 'FF_SimPanel 渲染存在')
  assert.ok(line.includes('sim.target'), 'FF_SimPanel target 应优先用 sim.target')
})