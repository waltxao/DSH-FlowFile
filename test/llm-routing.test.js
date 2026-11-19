import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectRoute } from '../src/llm.js'

// 复现真机缺陷：agentDefaultModel 给的是 workbuddy/hy4free（主对话模型），
// 插件 ctx.llm 通道对它 90s 零块。media-desk 的可用范式是钉一个真正可流式的文本模型。
// selectRoute 必须：优先用户/设置覆盖，其次在已公布的 provider 里挑文本模型，
// 且默认跳过 workbuddy 的 hy4* 系列（已知插件通道不可流式），最后才退回 default。
const PROVIDERS = [
  { provider: 'deepseek-official', models: ['deepseek-flash', 'deepseek-v4-pro'] },
  { provider: 'workbuddy', models: ['hy4free', 'hy4std', 'deepseek-v4.1-flash', 'glm-5.3-flash'] },
  { provider: 'agnes-ai', models: ['agnes-2.5-flash', 'agnes-3.0-flash', 'agnes-image-2.5-flash', 'agnes-video-2.5-flash'] },
]
const DEFAULT = { provider: 'workbuddy', model: 'hy4free' }

test('selectRoute：默认模型是 workbuddy/hy4free 时必须换到可流式文本模型', () => {
  const r = selectRoute({ defaultSelection: DEFAULT, providers: PROVIDERS, override: null })
  assert.ok(r && r.provider && r.model)
  assert.notDeepEqual(r, DEFAULT, '不能照抄主对话模型 workbuddy/hy4free')
  assert.ok(!/^hy4/.test(r.model), '必须跳过 hy4* 系列')
  assert.ok(!/image|video|embed|rerank/i.test(r.model), '必须是文本模型')
})

test('selectRoute：优先用 override（用户/设置钉住的模型），但排除图像/视频模型', () => {
  const r = selectRoute({ defaultSelection: DEFAULT, providers: PROVIDERS, override: { provider: 'agnes-ai', model: 'agnes-2.5-flash' } })
  assert.deepEqual(r, { provider: 'agnes-ai', model: 'agnes-2.5-flash' })
  const bad = selectRoute({ defaultSelection: DEFAULT, providers: PROVIDERS, override: { provider: 'agnes-ai', model: 'agnes-image-2.5-flash' } })
  assert.notEqual(bad.model, 'agnes-image-2.5-flash')
})

test('selectRoute：override 的 provider 不在清单里时退回自动选择', () => {
  const r = selectRoute({ defaultSelection: DEFAULT, providers: PROVIDERS, override: { provider: 'ghost', model: 'x' } })
  assert.notEqual(r.provider, 'ghost')
  assert.notDeepEqual(r, DEFAULT)
})

test('selectRoute：default 本身是可用文本模型时保留它', () => {
  const r = selectRoute({ defaultSelection: { provider: 'agnes-ai', model: 'agnes-2.5-flash' }, providers: PROVIDERS, override: null })
  assert.deepEqual(r, { provider: 'agnes-ai', model: 'agnes-2.5-flash' })
})

test('selectRoute：清单为空时如实返回 null，不瞎猜', () => {
  assert.equal(selectRoute({ defaultSelection: DEFAULT, providers: [], override: null }), null)
  assert.equal(selectRoute({ defaultSelection: null, providers: [], override: null }), null)
})
