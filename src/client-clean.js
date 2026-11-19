// FlowFile 清理面板（第 6 个 tab）。
// 铁律：候选来自 GET clean/candidates 的规则枚举，面板自己不编路径、不枚举目录、不执行删除。
// 两道默认不勾：① 候选清单默认全不勾 ② 生成的清理计划项也默认全不勾（hookPlan defaultChecked:false）。
// 删除一律走 FF_PlanCard 的既有执行门：勾选 → dry-run → 二次确认 → trash -v → 可撤销。
// 纯脚本 + React.createElement，不用 JSX、不用模板字符串，由 scripts/build.mjs 拼进 client bundle。

var FF_CLEAN_RISK_LABEL = { low: "低风险", medium: "需留意" }

function ffCleanTone(c) {
  if (c && c.risk === "medium") return "warm"
  if (c && c.category === "duplicate") return "cool"
  return "neutral"
}

function FF_CleanPanel(props) {
  var data = props.data, loading = props.loading, error = props.error
  var onRescan = props.onRescan, onPlan = props.onPlan, onClearPlan = props.onClearPlan
  var cleanPlan = props.cleanPlan, planProps = props.planProps
  var pickedState = React.useState({}), picked = pickedState[0] || {}, setPicked = pickedState[1]

  if (loading) return h("div", { className: "fd-panel" }, h(FF_Msg, { text: "正在按规则枚举可清理候选…" }))
  if (error) return h("div", { className: "fd-panel" },
    h("div", { className: "fd-err fd-msg" }, error),
    h("div", { className: "fd-actions" }, h("button", { className: "fd-btn", onClick: onRescan }, "重新枚举")))
  if (!data) return h("div", { className: "fd-panel" },
    h("div", { className: "fd-panel-h" }, "清理"),
    h(FF_Msg, { text: "点「重新枚举」按规则列出可清理候选。清理只覆盖本机用户目录，不碰网络卷。" }),
    h("div", { className: "fd-actions" }, h("button", { className: "fd-btn", onClick: onRescan }, "重新枚举")))

  var candidates = data.candidates || []
  var summary = data.summary || { count: 0, bytes: 0, byCategory: {} }
  var chosenPaths = candidates.filter(function (c) { return !!picked[c.path] }).map(function (c) { return c.path })
  function toggle(p) { var n = Object.assign({}, picked); n[p] = !n[p]; setPicked(n) }

  var catChips = Object.keys(summary.byCategory || {}).map(function (k) {
    var c = summary.byCategory[k]
    return h("span", { key: k, className: "fd-chip neutral", style: { marginRight: 6, marginBottom: 4 } },
      (FF_CLEAN_CATEGORY_LABEL[k] || k) + " " + c.count + " 项 · " + fdSize(c.bytes))
  })

  var rows = candidates.length ? candidates.map(function (c) {
    return h("label", { key: c.path, className: "fd-check" },
      h("input", { type: "checkbox", checked: !!picked[c.path], onChange: function () { toggle(c.path) } }),
      h("span", null,
        h("b", null, c.name), " ",
        h("span", { className: "fd-chip " + ffCleanTone(c) }, FF_CLEAN_CATEGORY_LABEL[c.category] || c.category), " ",
        h("span", { className: "fd-chip " + (c.risk === "medium" ? "warm" : "neutral") }, FF_CLEAN_RISK_LABEL[c.risk] || c.risk), " ",
        h("span", { className: "fd-num" }, fdSize(c.size)),
        h("div", { className: "fd-note" }, c.reason),
        h("div", { className: "fd-note" }, c.path)
      )
    )
  }) : [h(FF_Msg, { key: "empty", text: "没有符合规则的可清理候选（大文件 / 久未使用 / 重复副本 / 旧安装包）。" })]

  var planCard = cleanPlan && cleanPlan.batchId
    ? h(FF_PlanCard, Object.assign({ plan: cleanPlan }, planProps || {}))
    : null

  return h("div", { className: "fd-panel" },
    h("div", { className: "fd-panel-h" }, "清理 · " + summary.count + " 项候选 · 合计 " + fdSize(summary.bytes),
      h("button", { className: "fd-btn", onClick: onRescan }, "重新枚举")),
    h("p", { className: "fd-note" }, "只列本机用户目录（homedir）内的已索引文件与 ~/Downloads 旧安装包；明确排除 /Volumes 与 SMB 卷，跳过凭据、模型权重、锁文件、记忆配置与隐藏目录。规则只负责「找出来」，删除一律进回收站且可逐字节撤销，永不永久删除。"),
    h("div", { style: { margin: "6px 0" } }, catChips),
    h("div", { className: "fd-card" },
      h("h4", null, "候选清单 · 默认全部不勾选"),
      rows,
      h("div", { className: "fd-actions" },
        h("button", { className: "fd-btn", disabled: !chosenPaths.length,
          onClick: function () { if (onPlan) onPlan(chosenPaths); setPicked({}) } }, "生成清理计划（" + chosenPaths.length + " 项）"),
        cleanPlan && cleanPlan.batchId ? h("button", { className: "fd-btn", onClick: onClearPlan }, "放弃这次计划") : null
      )
    ),
    planCard ? h("div", { style: { marginTop: 10 } },
      h("p", { className: "fd-note" }, "下方是刚生成的清理计划：请逐项勾选，预检后二次确认再执行，执行结果可撤销。计划项默认不勾选；若扫描后文件发生变化，预检会拦下该项。"),
      planCard) : null
  )
}