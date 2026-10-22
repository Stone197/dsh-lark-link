<p align="center">
  <img src="./assets/logo.svg" alt="dsh-lark-link logo" width="360"/>
</p>

<h1 align="center">🪶 dsh-lark-link</h1>

<p align="center">
  <b>DeepSeek Harness × 飞书/Lark + 微信 统一桥接</b> — 一个插件，两个 IM 通道：飞书与微信同时接入你的 DSH 智能体
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-lark-link"><img src="https://img.shields.io/npm/v/dsh-lark-link?color=cb3837&label=npm&logo=npm" alt="npm"/></a>
  <img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="MIT"/>
  <img src="https://img.shields.io/badge/node-%3E%3D24-green" alt="node"/>
  <img src="https://img.shields.io/badge/DSH-0.2.1--rc.2-blue" alt="DSH"/>
  <img src="https://img.shields.io/badge/channels-Feishu%20%2B%20WeChat-2ea44f" alt="channels"/>
</p>

---

# 中文

**DeepSeek Harness × 飞书/Lark + 微信 统一桥接插件** —— 把同一个 DSH 智能体同时装进飞书和微信：扫码 30 秒上线、消息零丢失、**每轮运行一张实时卡片**（思考 / 工具调用 / 摘要 / 终止按钮）、每会话独立 Agent、两个通道共用一套设置页与命令目录。

> `0.7.0` 是**单包双通道**版本：飞书引擎来自 `dsh-lark-link`，微信通道完整移植自 [`pan17/dsh-wechat`](https://github.com/pan17/dsh-wechat)（MIT），交互显示方式参考 [`zarazhangrui/lark-coding-agent-bridge`](https://github.com/zarazhangrui/lark-coding-agent-bridge)。

## 🌟 为什么选 dsh-lark-link

- **一个插件两个通道**：装一次，飞书 + 微信同时在线；各自扫码/登录，共用配置文件、设置页、帮助目录与 DSH 会话体系
- **零丢失**：出站 Outbox + 入站 WAL 双持久化，进程崩溃 / 插件热更 / dsh 重启，消息和回答都补得回来
- **一次运行一张卡**：思考折叠面板 + 工具调用面板（>3 自动折叠）+ 运行状态 + 流式摘要 + ⏹ 终止按钮，和 bridge 同款交互
- **零学习成本**：切换类命令都是可点卡片；DSH 原生命令（`/goal` `/compact` …）直接用；skill 无前缀
- **真 Agent**：bash / 文件 / 子代理 / 工作流全套工具，IM 里跑完整 Harness
- **统一控制台**：DSH 设置里同时出现 `Lark / 飞书` 与 `WeChat` 两个面板，扫码、监控、热调配置、指令帮助一站完成

## ✨ 特性

### 交互（bridge 风格，飞书）

| 能力 | 说明 |
| ---- | ---- |
| 🌊 **实时运行卡片** | 每轮对话只有一张 CardKit 2.0 卡片：正文、思考、工具调用在同一张卡上刷新，不再刷屏 |
| 🧠 **思考折叠面板** | 运行中展开「🧠 思考中」，结束后收起为「思考完成，点击查看」 |
| 🧰 **工具调用面板** | ✅/❌/⏳ + DSH 工具中文名 + 参数摘要 + 输入/输出代码块；字段 800 字、输出 1200 字、总长 2500 字三级截断 |
| ☕ **>3 工具自动折叠** | 超过 3 个工具时，历史调用折叠为「☕ N 个工具调用（已结束）」，运行中始终展开最新一条 |
| 📊 **流式摘要 + 状态行** | 卡片摘要显示「思考中 / 正在调用工具 / 正在输出 / 已完成」；运行结束落最终卡 |
| ⏹ **卡片内终止** | 终止按钮带 HMAC 签名（TTL + 会话/群绑定 + 一次性 nonce），点击即停当前任务 |
| 🃏 **可点按钮卡片** | `/help` `/status` `/ws list` 等返回按钮卡片；`/mode` `/permission` `/model` 单选卡片 |
| ⌨️ **防抖合并** | 1 秒内连续发送的同会话消息合并为一轮；Agent 运行中消息自动排队，不丢失 |

### 飞书通道

| 能力 | 说明 |
| ---- | ---- |
| 🎯 **一键认证** | `/lark setup` 扫码创建飞书应用（自动订阅消息事件 + 群聊全量 + 表情权限 + 用户基本信息），30 秒上线；也支持 `DSH_LARK_APP_ID/SECRET` 手动通道 |
| 🧠 **多模式 Agent** | Standard / PTC / 极简 / Cordis preset + GUI 自建 preset，`/mode` 单选卡片即切 |
| 🎛 **权限分级** | 只读 / 工作区写 / Full access，`/permission` 卡片即切 |
| 💬 **意图确认转发** | 模型提问（`ask_user_question`）→ 飞书意图确认卡片（选项 / 多选 / 自定义输入） |
| 😊 **表情回执** | 收到消息随机表情「已收到」；完成打 **DONE ✅** |
| 💪 **出站零丢失** | 持久 Outbox（JSONL + 至少一次 + 幂等键 + 分航道并行 + 失败离队 + 周期清理） |
| 📥 **入站请求补发** | 处理中途崩溃/重启，启动后自动重新触发该用户消息；`/lark replay` 手动补发/丢弃 |
| 🛡 **连接自愈** | probe 驱动重连 + QuotaGovernor 熔断自动解除 + 断连补偿 |
| 📎 **入站多媒体** | 图片 → 视觉模型看图；文件 → 有界文本提取进提示词 |
| 📤 **出站多媒体** | 模型经 `lark_send_local_file` 回传本地图片/文件 |
| 🩺 **一键诊断** | `/doctor` → ZIP 诊断包（session log + 脱敏配置 + ISSUE.md） |
| 🔄 **会话管理** | `/new` `/resume` `/workspace` `/cd` `/ws` `/sessions`，按会话独立持久化工作区/模型/模式 |
| 👥 **访问控制** | `allowlist` 白名单、`groupPolicy` 群聊策略、`denyList` 命令兜底 |

### 微信通道（移植自 dsh-wechat）

| 能力 | 说明 |
| ---- | ---- |
| 📱 **iLink 扫码登录** | 设置页 `WeChat` 面板直接出二维码；沿用 `~/.dsh-wechat` 登录态，从 dsh-wechat 升级无需重新扫码 |
| 💬 **双向收发** | 文字 / 图片 / 文件 / 语音；文本自动分片、限流缓存 `/next` |
| 🔐 **审批 / 提问双端同弹** | 微信与 GUI 同步收到权限卡和提问卡，谁先答谁生效 |
| 🔀 **/at 引用** | 引用其它会话或文件，把「截图 + 问题」合成一轮 |
| 🗣 **输出节奏** | `/silent` 静默、`/final` 结论模式、`/merge` 打字合并、`/media` 媒体合并 |
| 🔔 **跨会话推送** | `/notify` 决策/任务完成提醒 |
| 🛠 **会话/工作区/模型/权限** | `/session` `/workspace` `/cd` `/preset` `/model` `/perm` `/reasoning` `/enter` 与 GUI 同源 |
| 📖 **指令帮助** | 设置页内嵌指令帮助（21 条命令，示例可复制）；微信 `/help` 两级帮助 |

## 🚀 快速开始

**前置**：Node.js ≥ 24，已安装 DeepSeek Harness（桌面版或 `npm i -g @deepseek-ai/dsh`）。

**安装**（官方 `dsh plugin` 机制，包以 `dsh.bundle` + `cordis.patch.yml` 分发）：

```bash
# 1. 安装插件（推荐显式版本号，绕开镜像 tag 缓存）
dsh plugin --profile web add dsh-lark-link@latest --ignore-scripts

#    本地 tarball（离线/内网友好）
dsh plugin --profile web add ./dsh-lark-link-<version>.tgz --ignore-scripts

# 2. 启动 / 重启 DSH
dsh web
```

> `--ignore-scripts`：飞书 SDK 的传递依赖 protobufjs 带一个可忽略的 postinstall，pnpm 11 安全策略会拦截；加上即可。
> `--profile`：插件装到哪个 profile（web / tui / headless），与你的 DSH 运行 profile 保持一致；桌面版通常是 `desktop`。

**飞书**：GUI 输入框执行 `/lark setup` → 扫码 → `/lark start`，然后在飞书里给机器人发消息。
**微信**：打开 **设置 → WeChat** → 扫码登录；已有 `~/.dsh-wechat` 登录态会自动复用。

两个通道都启动后，飞书和微信可以同时给同一个 DSH 工作区派任务；每边每个会话有独立的 Agent 与工作区配置。

## ⌨️ 命令

### DSH 侧（GUI 或终端）

```
/lark setup              扫码一键建飞书应用（或 DSH_LARK_APP_ID/SECRET 手动通道）
/lark start|stop|restart|status      桥接生命周期与全链路健康
/lark replay [list|drop <id>|auto on|off]   入站请求补发管理
/lark uninstall-clean    清除飞书凭据与飞书状态目录
```

### 飞书侧

| 类别 | 命令 | 行为 |
| ---- | ---- | ---- |
| 选择类 | `/mode` `/permission` `/model` | 单选按钮卡片，点选即切换 |
| 目标类 | `/goal [目标\|pause\|resume\|clear]` | 启动长任务自主执行 / 暂停 / 恢复 / 清除 |
| 状态类 | `/status` `/sessions` `/help` | 状态按钮卡片 / 会话列表 / 帮助卡片 |
| 会话类 | `/new` `/resume [序号\|id]` `/stop` | 新会话 / 恢复历史会话 / 停当前任务 |
| 工作区 | `/workspace <路径>` `/cd <路径>` `/ws [list\|add\|use\|remove\|status]` | 切换工作区 / 同 `/workspace` / 收藏与复用工作空间 |
| 诊断 | `/doctor` | ZIP 诊断包 |
| 热改 | `/lark-config key=value` | 如 `streaming.runCard=false`、`inboundMerge.enabled=false`、`groupPolicy=open` |
| DSH 命令 | `/compact` 等 | 原生执行，结果回飞书 |
| 多媒体 | 发图片/文件 | 图片→视觉模型；文件→文本提取 |
| 意图确认 | 模型提问 | 自动转飞书意图确认卡片 |

### 微信侧

| 类别 | 命令 | 行为 |
| ---- | ---- | ---- |
| 帮助/状态 | `/help` `/h` `/status` | 命令一览 / 全链路状态 |
| 会话 | `/session`（`/s`）`list` `switch` `pin` `new` `status` | 会话管理（与 GUI 同源） |
| 工作区 | `/workspace`（`/ws`）`list` `switch` `add`；`/cd <路径>` | 工作区管理 |
| 模型/预设 | `/preset`（`/p`）`/model` `/reasoning` | 切换 preset / 模型 / 推理等级 |
| 权限 | `/perm` `status` `list` `switch` `default` | 权限管理 |
| 输出节奏 | `/silent` `/final` `/merge` `/media` `/enter` | 静默 / 结论 / 打字合并 / 媒体合并 / 繁忙策略 |
| 引用与推送 | `/at` `/notify` `/history` `/flush` `/surface` | 引用、跨会话提醒、历史、取回结论、提示词注入 |
| 其它 | `/stop` `/next` `/rq` | 停止 / 继续发送 / 关闭待处理卡 |

> 一切 `/` 消息要么桥处理，要么原样交给 DSH；skill 无前缀，直接描述任务即可。

## ⚙️ 常用配置

飞书配置通过 `/lark-config` 热改并持久化：

| 配置键 | 默认 | 说明 |
| ------ | ---- | ---- |
| `groupPolicy` | `open` | 群聊触发：`open`（免 @）/ `mention` / `keywords` / `reply` |
| `agentPreset` | `ptc` | Agent preset（standard/ptc/minimal/cordis 或 GUI 自建） |
| `permissionMode` | `danger-full-access` | read-only / workspace-write / danger-full-access |
| `streaming.runCard` | `true` | **bridge 风格实时运行卡片**；关掉回退纯文本 |
| `streaming.enabled` | `false` | 旧版单 markdown 流式卡片（与 runCard 独立） |
| `inboundMerge.enabled` | `true` | 连续消息防抖合并 |
| `inboundMerge.silenceMs` | `1000` | 合并静默窗口 |
| `reactions.enabled` | `true` | 表情回执 |
| `allowlist` | `[]` | open_id 白名单（空 = 所有人） |
| `denyList` | `[]` | 命令前缀拒绝兜底 |
| `workspaceRoot` | `` | 桥会话工作区根目录 |
| `attachments.retentionHours` | `168` | 入站媒体保留时长（0 = 永久） |

微信配置在 **设置 → WeChat** 面板中维护，写入 `~/.dsh-wechat/config.json`，键名与 dsh-wechat 一致；登录态、同步游标、审计日志均沿用原目录，从独立插件升级无需重新扫码。插件级开关可在 `cordis.patch.yml` 的 `wechat:` 块配置（`enabled` / `storageDir` / `silent` / `finalOnly` / `mergeEnabled` 等）。

## 🧱 架构

```
dsh-lark-link（一个 Cordis bundle 插件）
├── 飞书引擎  src/host|inbound|outbound|sessions|presentation|application
│   └── 传输 / Outbox / Inbound WAL / CardKit 2.0 / 命令路由 / 会话管理
├── 微信通道  src/wechat/**（移植自 dsh-wechat）
│   ├── weixin/   iLink 长轮询、扫码登录、媒体上传下载
│   ├── bridge/   微信会话、命令、审批/提问卡、合并与静默
│   ├── adapter/  入站/出站消息与过程展示
│   └── plugin.ts applyWechatChannel(ctx, config) → disposer
├── 统一帮助  src/help/catalog.ts（两端 /help 唯一文案源）
└── 客户端    src/client/**（一个 bundle 注册 Lark/飞书 + WeChat 两个设置页）
```

- 两端各自维护会话与 Agent，但共用同一个插件生命周期、设置页入口与帮助目录
- 微信通道只在宿主挂载了 webServer 时启动，并复用自身 HTTP 前缀 `/wechat/api/*`
- 运行卡片失败会自动回退 durable outbox；命令卡片发送失败会自动回退纯文本，内容不丢

## 🔁 从旧版迁移

- **从 dsh-lark-plus / 旧 dsh-lark-link 升级**：`/lark setup` 的凭据仍存在 DSH credentials（`LARK_LINK_APP`），状态目录仍为 `~/.dsh/lark-link`，直接升级即可；新版本默认启用运行卡片与防抖合并，可用 `/lark-config` 关闭。
- **从 dsh-wechat 升级**：微信登录态在 `~/.dsh-wechat`（token / sync-buf / state / audit），本插件默认复用该目录，无需重新扫码；原 `send_wechat` 工具、`/wechat/api/*` 路由、设置页 section id 均保持不变。若同时安装 dsh-wechat，请禁用其一，避免两个 iLink 长轮询同时消费消息。

## 🛠 开发

```bash
npm install
npm run check       # tsc --noEmit
npm test            # 飞书侧 node:test（412+）
npm run test:wechat # 微信侧 vitest（985+）
npm run build       # tsdown → dist/（宿主 ESM + client bundle）
npm pack            # 可分发 tarball
```

> 构建/微信测试需要能加载 rolldown 原生模块的 Node；若 DSH 桌面版内置 Node 因签名策略无法加载，请改用系统 `node`（如 `/opt/homebrew/bin/node`）。

**测试**：飞书侧 `test/**/*.test.ts`（node:test）+ 微信侧 `tests-wechat/**/*.test.ts`（vitest）。CI 在 push/PR 时跑类型检查、两套测试与构建。

## 🙏 致谢

- 微信通道移植自 [`pan17/dsh-wechat`](https://github.com/pan17/dsh-wechat)（MIT；其 `src/weixin`、`src/adapter` 又源自 wechat-opencode / `@tencent-weixin/openclaw-weixin`，文件头保留出处）
- 实时运行卡片、工具折叠、防抖合并与卡片按钮交互参考 [`zarazhangrui/lark-coding-agent-bridge`](https://github.com/zarazhangrui/lark-coding-agent-bridge)（MIT）
- 飞书引擎基于本项目 `0.6.0`（`amlyczz/dsh-lark-link`）

## 📄 许可

MIT — 自由使用、修改、分发。本项目为社区插件，与 DeepSeek、飞书/Lark、腾讯微信均无隶属关系。

---

# English

**DeepSeek Harness × Feishu/Lark + WeChat unified bridge** — one plugin, two IM channels. Put the same DSH agent inside Feishu **and** WeChat: QR onboarding in 30 seconds, zero message loss, one live run card per turn (reasoning / tool panels / summary / stop button), per-chat agents, and a shared settings console.

## 🌟 Highlights

- **One plugin, two channels** — install once, run Feishu and WeChat side by side; each channel keeps its own login, while config, settings UI, help catalog and DSH session model are shared.
- **Zero message loss** — durable Outbox + Inbound WAL survive crashes, plugin hot-reloads and DSH restarts.
- **Bridge-style live run card** — one CardKit 2.0 card per turn with a reasoning panel, tool-call panels (auto-collapsed after 3), footer status, streaming summary and a signed ⏹ stop button.
- **Zero learning curve** — toggles are tappable cards; native DSH commands (`/goal`, `/compact`, …) run as-is; skills need no prefix.
- **Real agent** — full tool belt (bash / files / subagents / workflows) from chat.
- **Unified console** — `Lark / 飞书` and `WeChat` sections in DSH Settings: QR login, live metrics, hot config, command help.
- **WeChat parity** — ported from [`pan17/dsh-wechat`](https://github.com/pan17/dsh-wechat): iLink long-poll, media in/out, approval & question mirroring, `/at`, silent/final modes, merge, cross-session notifications.

## 🚀 Quickstart

```bash
# Node.js >= 24, DeepSeek Harness installed
dsh plugin --profile web add dsh-lark-link@latest --ignore-scripts
dsh web

# Feishu: run /lark setup (scan QR), then /lark start
# WeChat: Settings -> WeChat -> scan QR (an existing ~/.dsh-wechat login is reused)
```

Both channels can drive the same DSH workspace simultaneously; each chat gets its own agent, workspace, model and preset overrides.

## ⌨️ Commands

- **Feishu**: `/mode` `/permission` `/model` (single-select cards), `/goal`, `/status`, `/sessions`, `/help`, `/new`, `/resume`, `/stop`, `/workspace`, `/cd`, `/ws`, `/doctor`, `/lark-config key=value`, native DSH commands, media, intent-confirmation cards.
- **WeChat**: `/help`, `/status`, `/session|/s`, `/workspace|/ws`, `/cd`, `/preset|/p`, `/model`, `/perm`, `/reasoning`, `/enter`, `/silent`, `/final`, `/merge`, `/media`, `/at`, `/notify`, `/history`, `/flush`, `/surface`, `/stop`, `/next`, `/rq`.
- **DSH side**: `/lark setup|start|stop|restart|status|replay|uninstall-clean`.

## ⚙️ Configuration

Feishu keys are hot-reloadable via `/lark-config` (`groupPolicy`, `agentPreset`, `permissionMode`, `streaming.runCard` default **true**, `streaming.enabled` default false, `inboundMerge.enabled` default **true**, `allowlist`, `denyList`, `workspaceRoot`, attachments…). WeChat settings live in the `WeChat` settings panel and `~/.dsh-wechat/config.json` (same keys as dsh-wechat); plugin-level switches live under `wechat:` in `cordis.patch.yml`.

## 🧱 Architecture

A single Cordis bundle plugin: the Feishu engine (`src/host|inbound|outbound|sessions|presentation|application`) and the ported WeChat channel (`src/wechat/**`, contract `applyWechatChannel(ctx, config) -> disposer`) share one plugin lifecycle; `src/help/catalog.ts` is the single help-text source and `src/client/**` registers both settings sections.

## 🛠 Development

```bash
npm run check && npm test && npm run test:wechat && npm run build
```

412+ node:test cases (Feishu) and 985+ vitest cases (WeChat). Use a system Node when the DSH-app-bundled Node cannot load the rolldown native binding.

## 🙏 Credits & License

WeChat channel ported from [`pan17/dsh-wechat`](https://github.com/pan17/dsh-wechat) (MIT). Run-card / queue / card-button interaction modeled on [`zarazhangrui/lark-coding-agent-bridge`](https://github.com/zarazhangrui/lark-coding-agent-bridge) (MIT). Feishu engine based on `dsh-lark-link 0.6.0`. MIT licensed; not affiliated with DeepSeek, Feishu/Lark or Tencent WeChat.
