import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('tree: listDirForTree 调用 ffList（api.js 实际函数名，fdList 是笔误会导致树永不展开）', async () => {
  const app = await readFile(new URL('../src/client-app.js', import.meta.url), 'utf8')
  assert.ok(app.includes('ffList('), 'client-app.js 应调用 ffList')
  assert.ok(!app.includes('fdList'), 'client-app.js 不得引用不存在的 fdList')
  const api = await readFile(new URL('../src/api.js', import.meta.url), 'utf8')
  assert.ok(/function ffList\(/.test(api), 'api.js 必须定义 ffList')
})