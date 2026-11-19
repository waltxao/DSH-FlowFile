import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callModel } from '../src/llm.js'

// 复刻 resolveCallWithInfo 的关键行为：reasoning 存在时 effective = requested ?? defaultEffort。
// FlowFile 的结构化短调用必须显式传 configure 把 effort 压到最低档，否则会走默认 High 而 90s 超时。
const MODEL_INFO = {
  reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' },
  defaultMaxTokens: 4096
}

function mockCtx(log) {
  return {
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) }
      if (name === 'llm') return {
        async prepareCall(config, signal, configure) {
          log.configure = configure
          const controls = {}
          if (config.maxTokens !== undefined) controls.maxTokens = config.maxTokens
          const proposed = configure === undefined ? config : { ...configure(controls, MODEL_INFO), provider: config.provider, model: config.model }
          const effort = proposed.reasoningEffort ?? MODEL_INFO.reasoning.defaultEffort
          const resolved = { ...proposed, reasoningEffort: effort }
          log.resolved = resolved
          return {
            config: resolved,
            stream: async function* () { yield { type: 'text-delta', text: '{"reply":"ok"}' } }
          }
        }
      }
      return undefined
    }
  }
}

test('callModel 必须传 configure 回调，把结构化短调用压到最低思考档', async () => {
  const log = {}
  const out = await callModel(mockCtx(log), { system: 's', user: 'u', maxTokens: 800 })
  assert.equal(out, '{"reply":"ok"}')
  assert.equal(typeof log.configure, 'function', 'prepareCall 必须收到第三个 configure 回调')
  assert.equal(log.resolved.reasoningEffort, 'low', '结构化调用应使用最低思考档 low，而不是默认 high')
})

test('callModel 通过 diag 回传思考档/耗时/流式块数（诊断探针）', async () => {
  const log = {}
  const diag = {}
  const out = await callModel(mockCtx(log), { system: 's', user: 'u', maxTokens: 800, diag })
  assert.equal(out, '{"reply":"ok"}')
  assert.equal(diag.reasoningEffort, 'low')
  assert.equal(diag.defaultEffort, 'high')
  assert.deepEqual(diag.efforts, ['low', 'high'])
  assert.equal(diag.chunks, 1)
  assert.equal(typeof diag.ms, 'number')
  assert.ok(diag.textLen > 0)
})

test('callModel 模型抛错时 diag 记录 error/aborted/chunks', async () => {
  const diag = {}
  const ctx = {
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      if (name === 'llm') return {
        async prepareCall() {
          return { config: {}, stream: async function* () { yield { type: 'finish', reason: { kind: 'aborted' } } } }
        }
      }
    }
  }
  await assert.rejects(() => callModel(ctx, { system: 's', user: 'u', diag }), /模型调用失败/)
  assert.equal(diag.chunks, 0)
  assert.ok(typeof diag.ms === 'number')
})
