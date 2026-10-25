# 遥测 {#telemetry}

Cortex 会发送匿名的崩溃报告和使用统计，用来修复崩溃，并把精力投到真正有用的地方。遥测从不包含你的对话、提示词、文件、项目名或机器名，每个安装只用一个随机的安装 ID 标识。遥测默认开启。`cortex init` 会询问，桌面应用会在安装完成后的第一个页面上提供这个选项，你也可以随时在 **设置 → 隐私** 中关闭。

本页列出发送的全部内容、不发送的内容，以及如何查看、停止或删除这些数据。上报格式只由一个文件定义：[`agent-server/src/domain/telemetry/schema.ts`](https://github.com/fangxm233/cortex-agent/blob/main/agent-server/src/domain/telemetry/schema.ts)。服务端、收集端和本页都以它为准。

## 发送方式 {#how-it-is-sent}

服务端把事件排队存放在 `<CORTEX_HOME>/data/telemetry/`，再通过 HTTPS 分批发给运行在 Cloudflare Workers 上的收集端。崩溃在几秒内发出。其他排队的事件在服务端启动 30 秒后发一次，运行满十分钟后每五分钟发一次。心跳最多每 24 小时发一次，第一次在服务端启动约十分钟后。当天的使用汇总在该 UTC 日结束后发送。

每次上传十秒超时，不会阻塞或拖慢你的工作。上传失败会按退避重试，间隔从一分钟开始，最长六小时。被收集端拒收的批次直接丢弃。

每个批次都以一个描述本次安装的信封开头：

| 字段 | 含义 |
|---|---|
| `installId` | 每个安装生成一次的随机 UUID。桌面应用在安装向导中生成它，并交给它安装的服务端，因此安装过程和之后的使用共用同一个 ID |
| `version` | Cortex 版本 |
| `channel` | `release`；从源码运行或调试构建并且主动开启时为 `dev` |
| `installForm` | `desktop`（由桌面应用安装）、`npm`（npm 全局安装）或 `other` |
| `os`、`osRelease`、`arch` | 操作系统、它的主版本号（如 `6` 或 `10`）和 CPU 架构 |
| `nodeMajor` | Node.js 主版本号。桌面应用在安装向导中发送的步骤此项为空 |
| `uiLang` | 界面语言：`en`、`zh` 或 `other` |
| `schema`、`sentAt` | 格式版本和发送时间 |

收集端会附上 Cloudflare 为每个请求给出的两位国家代码，不保存 IP 地址。

## 发送的内容 {#what-is-sent}

### 崩溃 {#crashes}

服务端、守护进程、Web UI、桌面或 Android 应用崩溃时会发送崩溃报告。服务端记录自己的崩溃，守护进程重启崩溃的服务端进程也会被记录。Web UI 的渲染错误和窗口错误经由服务端上报。桌面或 Android 应用 panic 时会先把它保存下来，下次启动时由 Web UI 经服务端转发。

| 字段 | 含义 |
|---|---|
| `component` | `server`、`daemon`、`web`、`desktop` 或 `android` |
| `kind` | `uncaughtException`、`unhandledRejection`、`childExit`（服务端进程退出后由守护进程重启）、`renderError` 和 `windowError`（Web UI），或 `panic`（桌面和 Android 应用） |
| `errorName`、`message`、`stack` | 错误类型，以及经过[脱敏](#how-text-is-redacted)的消息和调用栈。消息截断为 300 个字符，调用栈最多 30 帧 |
| `groupKey` | 把同一种崩溃归为一组：错误类型加上 Cortex 自身代码中的第一帧（`TypeError@dist/domain/x.js#run`）、Web UI 的资源文件，或 panic 发生的位置（`panic@src/setup.rs:123`） |
| `uptimeS` | 进程已运行的秒数 |
| `route` | 仅 Web UI：路由模式，如 `/m/session/:sessionId`。从不发送具体路径 |
| `buildStamp` | Web UI 的构建标记或应用版本 |
| `client` | Web UI 运行在哪个应用中：`desktop`、`android` 或 `browser` |
| `exit` | 仅子进程退出：退出码或信号，以及重启前的等待时间 |
| `suppressed` | 同一组中被频率限制压下、没有单独发送的报告数 |

每组崩溃每小时最多发送一次，每个安装每天最多发送 20 份崩溃报告。

### 未导致崩溃的错误 {#errors-that-did-not-crash}

Cortex 记录了但没有导致崩溃的错误不逐条发送，而是汇总进每日汇总。`errors.byModule` 统计当天每个内部日志模块（如 `lifecycle`）报告的错误数。`errors.samples` 最多保留五种不同的错误，每种带有模块、分组键、脱敏后的消息和出现次数。

### 每日心跳 {#daily-heartbeat}

心跳描述这个安装的配置情况：

| 字段 | 含义 |
|---|---|
| `backends` | 登录可用的后端：`claude`、`pi` |
| `claudeBilling` | Claude 的付费方式：`plan`（订阅）、`api` 或 `none` |
| `piProviders` | 凭据可用的 PI provider，经过[规范化](#how-names-are-normalized) |
| `projects` | 项目数 |
| `onlineClients`、`clientPlatforms` | 已连接的远程机器数，以及按操作系统的分布 |
| `activeSessions24h` | 过去 24 小时内活跃的会话数 |
| `uptimeH` | 服务端已运行的小时数 |
| `settings` | 一组固定设置的开关状态：`teamEnabled`、`serverAutoUpdate`、`serverUpdateDisable`、`autoResume`、`bgContinuation`、`streamDeltas`、`clientHotReloadEnabled`、`storeArchiveEnabled`、`providerUsageCollectionEnabled`、`claudeWindowWarmupEnabled`、`feishuSkillsInWeb`、`memoryIndexRegenEnabled` |

### 升级与迁移 {#upgrades-and-migrations}

每次服务端升级都会上报 `from` 和 `to` 版本、`method`（`auto`、`prompt` 或 `manual`）、`stage` 和 `durationS`。npm 安装这一步的 stage 是 `installed` 或 `failed`；之后按下次启动是否运行新版本分为 `confirmed` 或 `unconfirmed`；启动时发现版本变了但没有对应的升级记录则为 `version-changed`。失败时附带一个分类（`network`、`permission`、`npm`、`disk`、`timeout` 或 `other`）和脱敏后的消息。

启动时运行的数据迁移失败时，报告会写明是哪个迁移（它的版本和它修改的内置文件，如 `2026.6.22:config/profiles.json`），并附带错误分类（`io`、`parse`、`permission` 或 `other`）和脱敏后的消息。

### 上手步骤 {#onboarding-steps}

每个上手步骤每个安装只发送一次，用来看出新用户卡在哪一步。服务端上报这些步骤：

| 步骤 | 附加信息 |
|---|---|
| `server_init_completed` | — |
| `provider_authed` | 第一个完成的回合所用的后端（`claude` 或 `pi`） |
| `first_session`、`first_turn_completed` | — |
| `first_remote_client`、`first_worker`、`first_schedule` | — |

服务端存在之前，没有别的组件能报告安装过程是否顺利，所以桌面应用把自己的安装步骤直接发给收集端。这些步骤是 `setup_started`、`server_installed` 或 `server_install_failed`、`init_completed` 或 `init_failed`，以及 `daemon_started` 或 `daemon_start_failed`。失败的步骤只带一个分类（`network`、`permission`、`disk`、`timeout`、`cancelled` 或 `other`），从不带错误文本。

### 每日使用汇总 {#daily-usage-rollup}

每个 UTC 日一份汇总，只包含计数，不包含单个事件。时长和百分比按固定区间计数（例如耗时不超过 5 秒、不超过 15 秒……直到超过一小时的回合数），从不发送具体数值。

| 部分 | 统计内容 |
|---|---|
| 回合健康度 | 每个后端、provider、模型和付费方式一行（最多 100 行）。每行包含完成、失败、取消和触发限流的回合数；失败分类（`auth`、`rate_limit`、`network`、`adapter_crash`、`timeout`、`other`）；重试次数；模型回退次数；完成回合的首个输出耗时；回合时长；回合结束时的上下文占用；自动和手动压缩次数；以及输入、输出、缓存读取和缓存写入的 token 数。`customApi` 给出自定义 provider 的 API 类型，如 `openai-completions` |
| 功能 | 创建会话、启动 worker、运行子智能体、打开看板、创建和触发定时任务、创建和触发等待点、使用浏览器会话的次数；以及提交、批准和驳回计划，提问和回答问题，连接远程机器的次数 |
| 工具 | 每个[规范化](#how-names-are-normalized)后的工具名的调用次数和出错次数（最多 200 个工具） |
| 入口 | 各渠道的消息数（`desktop`、`android`、`browser`、`feishu`、`slack`、`tui`、`other`），以及各 Web UI 操作（如 `sessions.send`）的调用次数 |
| 智能体活动 | 你打断的回合数、被新消息替换的回合数、每个会话回合数的分布（不发送会话 ID），以及 worker 和子智能体运行的完成、失败、取消次数 |
| 性能 | 当天每次服务端启动（最多十次）各启动阶段的耗时；事件循环延迟（每分钟 99 分位值的中位数和最大值）；Web UI 加载耗时（首字节、首次渲染、可交互）；实时更新的重连次数；远程机器断开次数 |
| 错误 | 上文所述的错误汇总 |

## 从不发送的内容 {#what-is-never-sent}

- 对话、提示词、模型输出或任何文件的内容
- 命令、工具输入或工具结果
- 文件名、路径、项目名、会话标题或会话 ID
- 机器名、主机名、用户名或邮箱地址
- IP 地址。收集端只保留 Cloudflare 根据请求得出的国家
- 你自己起的名字：自定义 provider、自定义模型和第三方 MCP 工具会按下文规则替换

## 名称如何规范化 {#how-names-are-normalized}

来自你配置的名称在上传前会与公开列表比对：

- **Provider 和模型。** Claude 后端的 provider 一律上报为 `anthropic`。Claude 模型名出现在 Cortex 内置的 Anthropic 模型列表或 PI SDK 自带的模型目录中时保留原名。PI 的 provider 和模型出现在这份自带目录中时保留原名。你在 `~/.pi/agent/models.json` 中定义的 provider 上报为 `custom` 并附带其 API 类型，它的模型上报为 `custom`。其余一律为 `other`。
- **工具。** Claude Code 和 PI 的内置工具保留原名，Cortex 自己的 MCP 工具（`mcp__cortex-…`）也保留原名。其他 MCP 工具上报为 `mcp_other`，其余工具上报为 `other`。

Web UI 操作名、日志模块名、迁移名和设置名都来自 Cortex 自己的代码。本地汇总文件在当天上传之前保存的是原始名称，上传时才做规范化。

## 文本如何脱敏 {#how-text-is-redacted}

崩溃消息、调用栈和错误样本在排队前就会脱敏：

- Cortex 安装目录内的路径改写为相对于安装目录的路径。其他任何平台上的文件路径都替换为 `<path>`。
- URL 保留协议和路径。主机替换为 `<host>`（回环地址除外），查询串、片段和登录凭据被删除。
- 邮箱地址替换为 `<email>`。API 密钥、较长的十六进制或 base64 字符串等类似机密替换为 `<secret>`，IPv4 地址替换为 `<ip>`。
- 你的主目录、机器的主机名和你的用户名如果仍然出现，分别替换为 `<home>`、`<host>` 和 `<user>`。

## 什么情况下不发送 {#when-nothing-is-sent}

满足以下任一条件时，服务端不记录也不发送任何内容：

- 在 **设置 → 隐私** 中关闭了遥测（即 `telemetryEnabled` 设置）。
- 服务端的环境变量或 `$CORTEX_HOME/config/.env` 中设置了 `CORTEX_TELEMETRY=0`。它优先于设置。
- `DO_NOT_TRACK` 被设为空值、`0`、`false`、`no`、`off` 以外的任何值。
- 服务端从源码目录运行（目录中仍有 `src/`，或设置了 `CORTEX_REPO`）。设置 `CORTEX_TELEMETRY=1` 可让源码目录主动开启，其报告标记为 `dev`。
- Cortex 主目录为基准测试运行做了封存（`CORTEX_CONFIG_IMMUTABLE=1`）。
- 构建中没有收集端地址。正式发布的构建都带有地址，`CORTEX_TELEMETRY_ENDPOINT` 可以覆盖它。你可以把它指向自己的 HTTP 端点，看清楚到底会发出什么。

在以上任一条件成立期间，服务端还会删除已排队的事件和当天的计数。如果是这些条件而不是开关让遥测处于关闭状态，**设置 → 隐私** 页面会说明原因。桌面应用的安装步骤会照常发送，除非桌面应用的环境变量中设置了 `CORTEX_TELEMETRY=0` 或 `DO_NOT_TRACK`。

## 查看排队的内容 {#inspecting-what-is-queued}

所有等待发送的内容都在 `<CORTEX_HOME>/data/telemetry/`（默认为 `~/.cortex/data/telemetry/`）：

| 文件 | 内容 |
|---|---|
| `install-id` | 安装 ID |
| `outbox.jsonl` | 等待发送的事件，每行一个 JSON 对象，与实际发出的内容完全一致。上限 2 MB，满了先丢最旧的事件 |
| `outbox.sending.jsonl` | 正在上传或等待重试的事件 |
| `rollup-YYYY-MM-DD.json` | 某个 UTC 日的累计计数，每五分钟和关机时保存一次。超过七天仍未发出的日汇总会被丢弃 |
| `state.json` | 上次心跳的时间、上次见到的版本、已发送的上手步骤，以及等待确认的升级 |
| `crash-limits.json` | 崩溃频率限制的计数 |

桌面应用把自己的文件放在其应用数据目录下的 `telemetry` 文件夹中：`install-id`、`setup.json`（安装向导的语言和已发送的安装步骤），以及 `native-crash.json`（等待转发的 panic）。

## 关闭遥测 {#turning-it-off}

- 桌面应用、Android 应用或浏览器工作台的 **设置 → 隐私** 中有 **帮助我们改进 Cortex** 开关。关闭后立即停止记录，并删除已排队的事件和当天的计数。安装 ID 会保留，以便你之后申请删除数据。
- `cortex init` 会询问是否发送匿名统计（默认是）。脚本化安装通过 answers 文件的 `telemetry` 字段设置：`{"telemetry": {"enabled": false}}`。
- 桌面应用安装完成后的第一个页面（Provider 设置页）上也有同一个 **帮助我们改进 Cortex** 开关，服务端一就绪你就可以做出选择。
- `$CORTEX_HOME/config/settings.json` 中的 `"telemetryEnabled": false` 与该开关是同一个设置。
- 在服务端的环境变量或 `$CORTEX_HOME/config/.env` 中设置 `CORTEX_TELEMETRY=0` 或 `DO_NOT_TRACK=1`，无论设置如何都会关闭遥测。

## 保留期与删除 {#retention-and-deletion}

收集端收到的数据不设过期时间，以便跨版本比较版本普及和崩溃趋势。崩溃按分组保存，每组只保留最新的一条样本，所以反复出现的崩溃只会增加计数，不会增加新记录。这些数据只有项目维护者可以查看。

如需删除你的数据，请发邮件到 [privacy@fangxm.me](mailto:privacy@fangxm.me)，附上你的安装 ID。安装 ID 可以在 **设置 → 隐私** 中复制。这个 ID 是随机生成的，不关联任何其他信息，只有这封邮件会把它和你联系起来，删除完成后邮件不会保留。

## Claude Code 自身的遥测 {#claude-codes-own-telemetry}

Cortex 运行 Claude Code 后端时，Claude Code 可能会向 Anthropic 发送它自己的遥测。这部分遥测由 Claude Code 自己的设置和环境变量控制，不受本开关影响。
