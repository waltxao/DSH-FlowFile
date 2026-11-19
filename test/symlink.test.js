import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGuard } from '../src/path-guard.js'

test('符号链接逃逸：软链指向允许范围外 / 根目录都必须拒绝（复刻 /Volumes/Iris -> /）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ff-guard-'))
  try {
    const root = join(tmp, 'allowed'), outside = join(tmp, 'outside')
    mkdirSync(root); mkdirSync(outside)
    symlinkSync(outside, join(root, 'escape'))
    symlinkSync('/', join(root, 'iris'))
    const guard = createGuard([root])
    assert.equal(guard.assertAllowed(root), root)
    assert.equal(guard.isAllowed(join(root, 'escape', 'secret.txt')), false)
    assert.equal(guard.isAllowed(join(root, 'iris', 'etc', 'passwd')), false)
    assert.throws(() => guard.assertAllowed(join(root, 'iris', 'etc', 'passwd')), e => e.status === 403)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
