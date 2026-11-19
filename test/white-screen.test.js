import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 白屏回归：真机点开 FlowFile 后宿主报
//   "slot entry crashed in 'main': TypeError: Cannot read properties of undefined (reading 'map') at FF_Chat"
// 根因 = loadModels() 首次 setModels 把 models 从 null 变成 {busy:true}（无 routes），
// FF_Chat 里 (models ? models.routes : []).map(...) 于是对 undefined 调 .map。
// 之前 144 项全绿但没测到：假 React/独立验收稿/SSR 首态都碰不到 useEffect 触发的中间态。

const BUNDLE = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')

function loadProbe() {
  // fakeReact.createElement 只收集参数，但参数在调用前已求值 —— 足以触发 .map 崩溃，
  // 且不依赖外部 react-dom / mh 缓存路径，测试自洽可复跑。
  const react = {
    createElement: (...args) => ({ args }),
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
  }
  const window = { __ModuleLoader__: { load(desc) { window.__factory = desc.factory } } }
  const probe = BUNDLE.replace(
    'return module.exports}});',
    'window.__probe={FF_Chat:FF_Chat};return module.exports}});'
  )
  const req = (name) => { if (name === 'react') return react; throw new Error('unexpected require: ' + name) }
  new Function('window', 'require', probe)(window, req)
  window.__factory(req)
  return window.__probe
}

const baseProps = { open: true, messages: [], input: '', planProps: {} }

test('白屏回归 ①：models=null（初始态）FF_Chat 不崩溃', () => {
  const p = loadProbe()
  assert.doesNotThrow(() => p.FF_Chat(Object.assign({}, baseProps, { models: null })))
})

test('白屏回归 ②：models={busy:true}（loadModels 中间态，无 routes）FF_Chat 不崩溃', () => {
  const p = loadProbe()
  // 当前实现会抛 "Cannot read properties of undefined (reading 'map')"
  assert.doesNotThrow(() => p.FF_Chat(Object.assign({}, baseProps, { models: { busy: true } })))
})

test('白屏回归 ③：routes 元素缺 models 字段时 FF_Chat 不崩溃', () => {
  const p = loadProbe()
  assert.doesNotThrow(() => p.FF_Chat(Object.assign({}, baseProps, {
    models: { routes: [{ provider: 'x', available: true }], busy: false }
  })))
})

test('白屏回归 ④：正常 models.routes 仍能渲染出模型选项', () => {
  const p = loadProbe()
  assert.doesNotThrow(() => p.FF_Chat(Object.assign({}, baseProps, {
    models: { autoLabel: 'auto', currentKey: 'auto', busy: false,
      routes: [{ provider: 'p', available: true, models: ['m1', 'm2'] }] }
  })))
})
