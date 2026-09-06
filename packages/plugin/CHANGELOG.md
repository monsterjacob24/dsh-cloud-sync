# Changelog

## 0.1.6

### 修复

- **恢复弹窗手动路径输入框宽度随输入漂移**
  根因：`flex: 1 1 0%` 在 dsh 渲染环境里对 `<input>` 的宽度分配不稳定，
  输入内容后宽度会变长（或缩窄）。
  修复：改为显式 `flex: 1 1 auto; width: 100%; max-width: 100%;
  box-sizing: border-box`，不依赖 flex 对 input 的宽度分配。

- **跨机恢复支持相对路径与 `~` 展开（落位路径规范化）**
  根因：恢复时用户改选的落位路径只接受绝对路径，输入 `my-app` 这类
  相对路径时按进程工作目录解析导致「目标目录不存在」失败。
  修复：新增 `normalizeTargetCwd`——`~` / `~/…` 展开到本机 home，相对路径
  按本机 home 解析，绝对路径原样；两台机器 home 不同也能各自落到
  home 下的同名目录，并学习来源→本机的路径映射。

## 0.1.5

### 修复

- **状态自愈：曾被「ENOENT 静默跳过」污染的会话恢复上传**
  根因：旧版把 locate 失败的会话按「未物化」静默记录 `localRevision` 却
  从未上传过一个字节，`needsSync` 因此永远判定「已同步」——即使修复了
  文件名推导，这些会话也不会重新进同步队列（表现为「成功 0」且无报错）。
  修复：
  - `needsSync` 自愈判定：`uploadedBytes === 0` 且无恢复抑制标记的条目
    一律视为待同步，被污染的会话自动重新上传，无需手工清理 state；
  - `markRestoredSynced` 写入 `restoredAt` 标记区分「恢复落位待续写」
    的合法抑制条目，自愈判定不误伤（恢复后未续写不回传）。

## 0.1.4

适配 dsh 0.1.3-alpha.1（源码版）的两处兼容修复：

### 修复

- **恢复会话弹窗所有会话被误标"版本不兼容"、checkbox 无法勾选**
  根因：`LOCAL_FORMAT_VERSION` 写死为 `0`，而 dsh 的 `SESSION_FORMAT_VERSION`
  实际为 `2`（rc.1 与 0.1.3-alpha.1 均如此），导致云端目录里每一行都满足
  `formatVersion > 0` 而被禁用。
  修复：常量更正为 `2`；同时恢复目录的兼容基准改为动态取本机会话 header
  的 `version`（即本机运行时的 `SESSION_FORMAT_VERSION`），上游未来升级
  格式版本后随本地新会话自适应，仅本地无任何会话时才落到常量兜底。

- **"立即全部同步"成功 0：v1 宿主日志文件名漏了格式代（`vN`）段**
  根因：dsh 0.1.3-alpha.1 的 jsonl 后端日志文件按格式代命名
  （`session.v2.jsonl.zstd`），而 persistence-port 仍按 rc.1 旧形态推导
  `session.jsonl.zstd`，`stat` 必然 ENOENT；该 ENOENT 又被"未物化会话"
  的静默跳过逻辑吞掉——会话从未上传，引擎却显示全部已同步。
  修复：
  - `locateDerived` 按会话 `header.version` 生成当前代文件名
    （`v0 → session.jsonl`、`vN>0 → session.vN.jsonl`，与 dsh
    `session-format/filename.ts` 一致），并按"当前代 zstd → v0 旧形态
    zstd → 当前代明文 → v0 明文"优先级探测；
  - 引擎 ENOENT 分支不再无条件静默：会话目录中存在 canonical 日志
    （`session[.vN].jsonl[.zstd]`）而推导路径缺失时按布局失配报错
    （计入"失败"并展示错误），只有目录中无日志文件（真未物化：v1 后端
    lock 先建目录、首个 append 才物化日志）才静默记录 revision 跳过。

## 0.1.3

适配 dsh 0.1.3-alpha.1 的 `SessionPersistence` API 收敛：

- 新增 `persistence-port` 双版本兼容层：运行时探测宿主形态，v0（rc.1）
  透传 `listSnapshots/list/locate`，v1 以 `list()` 作快照枚举并按 jsonl
  磁盘布局推导落位路径（复刻 `projectKey`/`encodeSegment` 编码）；
- 引擎对 v1 "已创建未物化" 会话（首个 append 前无日志文件）的 ENOENT
  静默跳过，不计失败、不进退避。

## 0.1.2

- npm 发布链路与 `dsh plugin add` 安装修复。

## 0.1.1 / 0.1.0

- 初始版本：端到端加密上传、增量同步、云端恢复对话框、路径映射、
  启动检查等（M1–M4）。
