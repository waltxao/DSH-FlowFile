// 第 16 轮（m07634）：右栏预览顺序改为「缩略图 → 智能识别 → 变更时间线 → 属性与标签」。
// 用户原话：「智能识别应该放置在预览的最上方，在缩略图下方」。
// 现状（改前）：右栏只有 预览标题 → 属性与标签 → 智能识别 → 变更时间线，而且**根本没有缩略图**。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../src/client-app.js', import.meta.url), 'utf8')
const browse = readFileSync(new URL('../src/client-browse.js', import.meta.url), 'utf8')
const dist = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')

test('P1 右栏有缩略图块（fd-prev-thumb），且排在智能识别之前', () => {
  assert.ok(app.indexOf('fd-prev-thumb') > 0, '右栏应有 .fd-prev-thumb 缩略图块')
  const iThumb = app.indexOf('className: \'fd-prev-thumb\'')
  // 注意：文件里多处出现「智能识别」字样（注释、提示文案），这里锚定真正的 h4 标题节点。
  const iRec = app.indexOf("'fd-preview-h' }, '智能识别'")
  assert.ok(iThumb > 0, '缩略图块要在')
  assert.ok(iRec > 0, '智能识别要在')
  assert.ok(iThumb < iRec, '缩略图必须排在智能识别之前（当前 ' + iThumb + ' vs ' + iRec + '）')
})

test('P2 智能识别排在属性与标签之前', () => {
  // 注意：文件里多处出现「智能识别」字样（注释、提示文案），这里锚定真正的 h4 标题节点。
  const iRec = app.indexOf("'fd-preview-h' }, '智能识别'")
  const iAttr = app.indexOf("h('aside', { className: 'fd-aside' }")
  assert.ok(iRec > 0 && iAttr > 0)
  assert.ok(iRec < iAttr, '智能识别必须在属性之前（当前 ' + iRec + ' vs ' + iAttr + '）')
})

test('P3 选中图片时真的去取缩略图（不是只画个框）', () => {
  assert.ok(app.indexOf('previewThumb') > 0, '应有 previewThumb 状态')
  assert.ok(/ffThumb\([^)]*,\s*(3|4|5|6)\d\d\)/.test(app), '预览缩略图要按大尺寸取（>=300）')
  assert.ok(app.indexOf('canThumb') > 0, '预览缩略图应复用 canThumb 判断')
})

test('P4 非图片给占位而不是空白（不假装有图）', () => {
  assert.ok(app.indexOf('fd-prev-thumb-ph') > 0 || app.indexOf('fd-prev-nothumb') > 0, '非图片要有占位块')
})

test('P5 dist 已同步', () => {
  assert.ok(dist.indexOf('fd-prev-thumb') > 0, 'dist 应含右栏缩略图')
})

test('P6 预览忙碌用计数而不是布尔（否则先回来的请求会把“识别中”提前关掉）', () => {
  assert.ok(app.indexOf('panelBusyCount') > 0, '应有 panelBusyCount 计数')
  assert.ok(app.indexOf('function panelBusyAdd') > 0, '应有 panelBusyAdd')
  assert.equal(app.indexOf('setPanelBusy('), -1, '旧的布尔 setPanelBusy 必须退场')
  assert.ok(app.indexOf('var panelBusy = panelBusyCount > 0') > 0, 'panelBusy 应由计数派生')
})
