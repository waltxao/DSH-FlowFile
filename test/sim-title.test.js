import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('sim: FF_SimPanel 标题不得输出 [object Object]（target 为 {path,name} 时用 target.path）', async () => {
  const ui = await readFile(new URL('../src/client-ui.js', import.meta.url), 'utf8')
  const line = ui.split('\n').find(l => l.includes('相似文件 · '))
  assert.ok(line, '标题行存在')
  assert.ok(line.includes('target.path'), '标题应取 target.path')
})