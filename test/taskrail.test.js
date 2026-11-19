// 第 18 轮 · A 方案「右侧任务栏」失败测试先行（m08080 不满 / m08088 定稿）。
// 用户四点不满：①已执行任务没有落点 ②字太大内容少 ③错位 ④聊天看不到上下文。
// A 方案结构：取消整幅底部 dock；右栏加宽 380 改「任务历史常驻 + 对话常驻 + 预览折叠」三段；
// 行高 44→30；顶栏 subbar 单行 nowrap 消除错位。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const app = fs.readFileSync(new URL('../src/client-app.js', import.meta.url), 'utf8')
const browse = fs.readFileSync(new URL('../src/client-browse.js', import.meta.url), 'utf8')
const css = fs.readFileSync(new URL('../src/client-style.js', import.meta.url), 'utf8')
const dist = fs.readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')
const tahoeUi = fs.readFileSync(new URL('../src/client-tahoe-ui.js', import.meta.url), 'utf8')
const tahoe = fs.readFileSync(new URL('../src/client-tahoe.js', import.meta.url), 'utf8')

// 第 20 轮（m09643）：任务历史从「右栏常驻段」搬进 AI 抽屉的「任务历史」tab。
// 原意「执行过的批次有落点、可撤销、接真实数据」一条不删，判据换成新骨架。
test('① 任务历史在 AI 抽屉 tab 里，接真实 /ops/batches，且每条带撤销', () => {
  assert.ok(tahoeUi.includes('任务历史'), '抽屉要有任务历史 tab')
  assert.match(tahoeUi, /\/ops\/batches|props\.tasks/, '任务列表数据来自 props.tasks（app 里由 ffBatches 喂）')
  assert.match(tahoeUi, /props\.onUndo/, '每条可撤销要有回调')
  assert.match(tahoeUi, /撤销/, '要有撤销文案')
  assert.match(app, /ffBatches\(/, 'client-app 必须调 ffBatches 读真实批次')
  assert.match(app, /ffUndo\(/, '撤销必须真的走 ffUndo')
})

test('② 对话在 AI 抽屉里，消息与计划卡上下文完整保留', () => {
  assert.ok(tahoeUi.includes('function FF_TDrawer'), 'AI 抽屉组件存在')
  assert.match(tahoeUi, /messages: props\.messages|props\.messages/, '抽屉吃 messages（上下文由 app 持有，不截断）')
  assert.match(tahoeUi, /FF_PlanCard/, '抽屉里仍渲染计划卡')
  assert.ok(app.includes('messages: chatMsgs'), 'client-app 把完整消息历史喂给抽屉')
  assert.ok(tahoe.includes('.fd-root .drawer'), '需要抽屉样式（在 client-tahoe.js）')
  assert.equal(tahoeUi.includes('scrollTop'), false, '抽屉不再强制滚到底（上下文可回看）')
})

test('③ 行高 44→30 且第二行 subbar 单行不换行（消除错位）', () => {
  assert.ok(css.includes('--fd-row-h:30px'), '行高变量应为 30px')
  assert.equal(css.includes('--fd-row-h:44px'), false, '旧 44px 行高应移除')
  assert.equal(/\.fd-subbar\{[^}]*flex-wrap:\s*wrap/.test(css), true === false,
    '.fd-subbar 不得 flex-wrap:wrap（错位根因）')
})

test('④ 右栏加宽到 380px（任务+对话双段放得下）', () => {
  assert.ok(app.includes('rightW: 380'), 'FD_LAYOUT_DEF.rightW 应为 380')
  assert.ok(css.includes('--fd-right-w:380px'), 'CSS 右栏宽度变量应为 380px')
})

test('⑤ 预览段折叠保留，智能识别功能不丢', () => {
  assert.ok(app.includes('previewOpen') || app.includes('fd-rail-preview'), '右栏要有预览折叠开关')
  assert.ok(app.includes('fd-preview-h') && app.includes('智能识别'), '智能识别预览仍在（功能不丢）')
})

test('⑥ dist/client.js 已重建含 Tahoe 结构层全部标记', () => {
  assert.ok(dist.includes('function FF_TDrawer'), 'bundle 缺 FF_TDrawer')
  assert.ok(dist.includes('function FF_TSidebar'), 'bundle 缺 FF_TSidebar')
  assert.ok(dist.includes('.fd-root .sidebar'), 'bundle 缺 .sidebar 样式')
  assert.ok(dist.includes('--fd-row-h:30px'), 'bundle 缺新行高')
  assert.ok(dist.includes('data-tier'), 'bundle 缺灵动底坞三档')
  const iSide = dist.indexOf("className: 'sidebar'")
  const iCoord = dist.indexOf("className: 'coord'")
  const iStage = dist.indexOf("className: 'stage'")
  const iDrawer = dist.indexOf('h(FF_TDrawer')
  assert.ok(iSide > 0 && iCoord > iSide && iStage > iCoord && iDrawer > iStage,
    '结构顺序应为 侧栏 → 协调栏 → 舞台 → 抽屉，当前 ' + iSide + '/' + iCoord + '/' + iStage + '/' + iDrawer)
})
