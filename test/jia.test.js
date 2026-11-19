// 甲 · 文件全幅（第 6 轮）→ 第 7 轮 VSCode 式改版后同步：旧断言按新规格重写
// 第 7 轮规格（docs/FlowFile-第7轮规格-VSCode改版-定稿.md）：fd-drawer / FF_NavTabs / FF_Chat 移除，
// 改为 fd-tree + fd-tabbar + fd-right（fd-right-top + fd-aidock）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join, dirname } from "node:path"
var here = dirname(fileURLToPath(import.meta.url))
var src = readFileSync(join(here, "../src/client-app.js"), "utf8")
var browse = readFileSync(join(here, "../src/client-browse.js"), "utf8")
var style = readFileSync(join(here, "../src/client-style.js"), "utf8")
var dist = readFileSync(join(here, "../dist/client.js"), "utf8")
var tahoeUi = readFileSync(join(here, "../src/client-tahoe-ui.js"), "utf8")

test("① VSCode 布局三段齐备（fd-tree / fd-tabbar / fd-right）", () => {
  assert.ok(style.includes(".fd-tree"), "CSS fd-tree")
  assert.ok(style.includes(".fd-tabbar"), "CSS fd-tabbar")
  assert.ok(style.includes(".fd-right"), "CSS fd-right")
  assert.ok(style.includes(".fd-dock"), "CSS fd-dock（第 13 轮对话搬到整幅底栏）")
})

test("② 旧甲方案抽屉与 tab 条已移除", () => {
  assert.ok(!src.includes("fd-drawer"), "fd-drawer removed from app")
  assert.ok(!src.includes("FF_NavTabs"), "FF_NavTabs removed from app")
  assert.ok(!browse.includes("FF_NavTabs"), "FF_NavTabs removed from browse")
})

test("③ 右键菜单含 findDup / findSim（对目标生效）", () => {
  assert.ok(src.includes("findDup"), "app 分发 findDup")
  assert.ok(src.includes("findSim"), "app 分发 findSim")
})

test("④ 选中即自动跑识别与时间线（showMeta 内自动调）", () => {
  assert.ok(/showMeta[\s\S]*loadTimeline\(e\.path\)[\s\S]*loadRecognize\(e\.path\)/.test(src), "showMeta 自动执行")
})

// 第 20 轮（m09643）：对话从 FF_AiDock 迁到 FF_TDrawer（设计稿 .drawer 抽屉形态），
// 原意图「对话有独立容器、旧 FF_Chat 不再使用」保留。
test("⑤ AI 对话走 FF_TDrawer 抽屉，旧 FF_Chat 与 FF_AiDock 都不再挂载", () => {
  assert.ok(src.includes("FF_TDrawer"), "app 用 Tahoe 抽屉 FF_TDrawer")
  assert.ok(!src.includes("h(FF_Chat"), "旧 FF_Chat 已移除")
  assert.ok(!src.includes("h(FF_AiDock"), "旧 FF_AiDock 已不再挂载（组件保留供回退）")
  assert.ok(tahoeUi.includes("function FF_TDrawer"), "client-tahoe-ui.js 定义 FF_TDrawer")
})

test("⑥ bundle 含 VSCode 关键符号", () => {
  assert.ok(dist.includes("fd-tree"), "bundle 有 fd-tree")
  assert.ok(dist.includes("fd-tabbar"), "bundle 有 fd-tabbar")
  assert.ok(dist.includes("FF_AiDock") || dist.includes("fd-aidock"), "bundle 有 AiDock")
})