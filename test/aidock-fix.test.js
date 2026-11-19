import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// 第 13 轮规格变更（m06568 ①「预览窗格的对话框不太对，重新放回下方dock栏」）：
// 原断言锁的是「右栏断层修复 = right-top 收缩 + aidock 抢占右栏剩余空间」。
// 对话搬到整幅底栏后这组结构性前提不再成立，断言按新规格重写为「右栏不再装对话 + dock 独立成条」。

test('dock: 右栏预览区独占右栏，不再被对话挤成半截', async () => {
  const css = await readFile(new URL('../src/client-style.js', import.meta.url), 'utf8')
  assert.ok(css.includes('.fd-right-top{flex:1 1 auto'), 'fd-right-top 应占满右栏（对话已搬走，不再需要为它让位）')
  assert.equal(css.includes('.fd-aidock{'), false, '旧右栏对话容器 .fd-aidock 应移除')
  assert.ok(css.includes('.fd-dock{flex:0 0 auto;height:var(--fd-dock-h)'), '对话改为整幅底栏 .fd-dock，高度走变量')
})

// 第 20 轮（m09643）结构重排：对话从「整幅底栏 / 右栏常驻」改为设计稿的「灵动底坞 + AI 抽屉」两件套。
// 原意图（对话不塞在预览窗格里、不挤压右栏）保留，判据换成新骨架的位置。
test('dock: 灵动底坞在文件空间卡内、AI 抽屉独立成层，不再挤右栏', async () => {
  const app = await readFile(new URL('../src/client-app.js', import.meta.url), 'utf8')
  const pane = app.indexOf("className: 'pane focused'")
  const dock = app.indexOf('h(FF_TDock')
  const insp = app.indexOf('h(FF_TInspector')
  const drawer = app.indexOf('h(FF_TDrawer')
  assert.ok(pane > 0 && dock > pane, 'FF_TDock 必须在文件空间卡（pane）内，是卡片里的灵动底坞')
  assert.ok(insp > dock, '检查器在文件卡之后渲染')
  assert.ok(drawer > insp, 'AI 抽屉是 main 的最后一层（.drawer 绝对定位覆盖）')
  assert.equal(app.includes('fd-splitter-h'), false, '右栏里的「预览|对话」横分隔条应移除')
})
