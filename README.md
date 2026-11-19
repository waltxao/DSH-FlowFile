# FlowFile

把「文件管理」做成 DeepSeek Harness 的一项能力：在左侧工作台点开 **FlowFile**，主区域打开一块全幅文件工作台，本机磁盘与已经挂载的 SMB 卷都在同一处浏览，并且可以直接用自然语言下指令。

> 方向是「把文件管理装进 AI」，不是「往文件管理器里塞一个 AI 输入框」。所以它长在对话旁边，而不是另一个独立 App。

## 功能

### 文件管理
浏览本机用户目录、系统盘（Applications / Library / opt / usr）与 macOS 已挂载的 SMB 卷。支持面包屑导航、可输入地址栏、前进后退、列表 / 网格 / 分栏三种视图、列排序、多选、右键菜单、QuickLook 预览、标签读写、在 Finder 中显示。

所有写操作都不自动执行，走同一条执行链：**AI 出计划 → 逐项勾选 → 预检 → 二次确认 → 串行执行 → 可撤销**。移动与重命名使用 `fs.rename`；删除一律进系统回收站并写下恢复清单，可逐字节校验恢复。

### 文件查重
三级判据：大小分桶 → 头尾各 4 KB 的 SHA-256 部分哈希 → 全文件 SHA-256。结果按组展示，给出「保留建议」，不自动删除任何一项。

### 相似文件
图片用 dHash（9×8 灰度，汉明距离阈值 6），文本用 SimHash（阈值 8），再叠加文件名归一化、类型与大小的弱信号。弱信号会标出来，且不允许批量操作。

### 变更时间线
扫描差异与执行链上的写操作都会记进事件表，可按文件或按目录回看。数据落在本地 SQLite，重启后仍在。

### 智能识别
本地采集可观测信号（下载来源、Spotlight 元数据、图片尺寸、Finder 标签、文本首段），交给宿主默认模型生成「这是什么 / 从哪来 / 怎么用 / 能否清理」，每条结论带置信度与证据。证据不足时只列已知信号，「来源未知」是明确的一等状态，不会编一个网址出来。信号在本机采集，只把摘要文本交给模型，不上传文件内容。

### 清理
按规则枚举用户目录内的已索引文件与旧安装包，分「大文件 / 久未使用 / 重复副本 / 旧安装包」四类。候选项与生成的计划默认全不勾选，删除同样走执行链。明确排除网络卷、凭据目录、模型权重、锁文件与隐藏目录。

### 工作台内对话
底部抽屉可以直接对「当前目录 + 选中文件」说话。回复可以是文本、识别卡片或整理计划卡片，计划卡片可逐项勾选后进入执行链。消息落本地 SQLite，刷新后还在。

## 安装

需要 DeepSeek Harness 桌面版（`engines.dsh` 约束 `>=0.2.1-rc.5 <0.3.0`）。

```bash
# 从本地目录安装（开发时用 link: 方式，改代码即生效）
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add /path/to/flowfile

# 卸载
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop remove flowfile
```

安装后在左侧工作台列表点 **FlowFile** 即可打开。修改 `src/client-*.js` 之后需要执行 `npm run build` 重新生成 `dist/client.js`；修改 host 侧文件需要触发一次 profile recomposition（`remove` + `add`）。

## 开发

```bash
npm run build    # 拼装 dist/client.js（无打包器，纯脚本拼接）
npm test         # node --test test/*.test.js
```

客户端是一组纯脚本模块，由 `scripts/build.mjs` 拼进 `window.__ModuleLoader__.load` 包装，React 由宿主模块表提供，不引入构建工具链。

## 架构

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 界面 | `src/client-*.js` | 工作台 UI、视图状态、快捷键、抽屉 |
| 路由 | `src/host.js` | `/flowfile/*` 前缀路由，鉴权与参数校验 |
| 能力 | `src/{ops,clean,dedup,similar,recognize,timeline,tags,meta}.js` | 扫描、哈希、识别、计划生成 |
| 存储 | `src/db.js` | 本地 SQLite（`~/.flowfile/index.db`，WAL） |
| 边界 | `src/path-guard.js` | 路径白名单与软链展开 |

数据全部落在 `~/.flowfile/`：`index.db` 存索引、事件、标签与批次；`RESTORE-MANIFEST-<batchId>.json` 存删除恢复清单；`thumbs/` 存缩略图缓存。不写 DSH 工作区，不修改 app.asar。

## 路径边界

默认允许 `~/`、`/Volumes` 下真实挂载的卷，以及系统盘上的 `/Applications`、`/Library`、`/opt`、`/usr`。词法路径与 realpath 展开后的路径都必须在允许范围内，以此挡住 `/Volumes/Iris -> /` 这类软链逃逸。`.ssh`、`.gnupg`、`.aws`、`.kube`、`Keychains` 与私钥类文件一律拒绝。不实现 SMB 协议、不挂载新共享，只读系统已经挂载的 `/Volumes/<share>`。

## 许可

MIT
