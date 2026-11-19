import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recognizeSystem, buildSignalsUser, validateCard } from '../src/recognize.js'

test('recognize：system 禁止编造来源，from 必须来自 where_from', () => {
  assert.ok(recognizeSystem().indexOf('禁止编造') > 0)
  assert.ok(recognizeSystem().indexOf('unknown') > 0)
})

test('recognize：白名单只留 7 字段、来源未知不编造', () => {
  const sig = { where_from: null, name: 'x', size: 10 }
  const card = validateCard({
    what: '一个文件', from: 'https://编造.com', usage: '用来测试', cleanable: 'yes',
    confidence: 5, evidence: ['a', 'b', 'c'], evil: 'rm -rf /'
  }, sig)
  assert.equal(card.from, 'unknown')
  assert.equal(card.confidence, 1)  // 钳到 1
  assert.equal(card.sourceUnknown, true)
  assert.equal(card.evil, undefined)  // 白名单外字段不进卡片
  assert.equal(card.evidence.length, 3)
  for (const k of ['what', 'from', 'usage', 'cleanable', 'confidence', 'evidence']) assert.ok(k in card)
})

test('recognize：有真实 where_from 且模型照抄才保留', () => {
  const sig = { where_from: 'https://www.doubao.com/' }
  const c1 = validateCard({ what: '文档', from: 'https://www.doubao.com/', usage: 'x', cleanable: 'no', confidence: 0.8, evidence: [] }, sig)
  assert.equal(c1.from, 'https://www.doubao.com/')
  assert.equal(c1.sourceUnknown, false)
  const c2 = validateCard({ what: '文档', from: 'https://别处.com', usage: 'x', cleanable: 'no', confidence: 0.8, evidence: [] }, sig)
  assert.equal(c2.from, 'unknown')
})

test('recognize：buildSignalsUser 只列已知信号', () => {
  const u = buildSignalsUser({ where_from: null, name: 'a.txt', size: 12, content_type: 'public.text', finder_tags: ['红'] })
  assert.ok(u.indexOf('where_from') < 0)
  assert.ok(u.indexOf('a.txt') > 0)
  assert.ok(u.indexOf('public.text') > 0)
})
