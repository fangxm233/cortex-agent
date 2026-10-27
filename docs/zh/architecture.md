# Cortex 架构 {#cortex-architecture}

Cortex 是一个面向机器人学与 AI/ML 的自主研究智能体系统。它采用服务器-客户端架构：**agent-server** 编排工作——对话及其智能体运行、定时任务、聊天平台集成、Web UI 和 MCP 工具——而远程 **agent clients** 通过 WebSocket 连接，在远程机器上执行命令。关于这些子系统的深入说明，参见 [memory.md](./memory.md)、[scheduling.md](./scheduling.md) 和 [mcp.md](./mcp.md)。

## 软件包 {#packages}

仓库是一个 pnpm workspace。其中两个包发布到 npm；其余的包要么被构建进这两个包，要么单独部署。

| 包 | 路径 | 用途 |
|---------|------|---------|
| `@cortex-agent/server` | `agent-server/` | 主服务器：Slack 与飞书适配器、Web UI 宿主、TUI 网关、LLM 编排、定时任务、MCP 工具。提供五个 CLI 可执行文件：`cortex`、`cortex-browser`、`cortex-hook`、`cortex-evidence-export`、`cortex-signal`。发布的包还携带构建好的 web 应用和客户端 bundle |
| `@cortex-agent/client` | `client/` | 轻量级远程智能体守护进程（`cortex-client`）。通过 WebSocket 连接，在本地执行 shell/文件命令 |
| `@cortex-agent/web` | `web/` | 基于 Vite + React 的浏览器应用，含桌面与移动端布局。构建到 `web/dist`，由服务器的 Web UI 宿主提供 |
| `@cortex-agent/desktop` | `desktop/` | Tauri v2 桌面与 Android 外壳。通过 `cortexui://` scheme 提供 web 应用，来源是自带的副本，或从服务器下载的更新 bundle |
| `@cortex-agent/ui-contract` | `packages/ui-contract/` | 仅类型的重新导出，导出服务器的 Web UI router 和 DTO 类型，web 应用基于它编译 |
| `@cortex-agent/deepseek-relay-worker` | `packages/deepseek-relay-worker/` | Cloudflare Worker，为无法直连 DeepSeek 的主机做中转 |
| 插件 | `agent-server/defaults/plugins/` | 包含技能的内置插件包（`cortex-system`、`cortex-board`、`cortex-feishu`）。不是 npm 包——运行时作为目录原地读取 |

### Server 软件包与发布 {#server-package-and-release}

npm server 包包含拆分 chunk 的 JavaScript bundle、PI 运行时及资源文件、Web SPA、client bundle、
默认配置和许可证声明，运行时仍为 Node.js。npm 另行安装 `agent-browser`、Photon WASM 和可选的
`sharp`；大部分 JavaScript 库已在 bundle 内。桌面安装器通过自带的 Node 安装同一个 npm 包。

postinstall 按 agent-browser launcher 的规则保留当前主机的二进制，包括 Linux libc 区分和
Windows ARM64 fallback；遇到未知包布局则保留原样。这减少的是安装后磁盘占用，不是包含全部平台
二进制的 browser tarball 下载量。Node、Chrome 和用户数据不计入 server 包。postinstall 还会在已初始化
的 Cortex home 写入重启触发文件，让运行中的 daemon 在空闲时加载安装好的更新。

`publish-server.yml` 构建 workspace，通过
`node agent-server/scripts/bundle.mjs <全新暂存目录>` 生成发布包，再将该目录打成 tarball。
CI 把 tarball 安装到临时 prefix，用无凭据的 home 和隔离端口运行 `bundle-smoke.mjs`；
冒烟成功才发布同一个 tarball。包中保留 Cortex 的 `LICENSE`、esbuild legal comments，
并携带收录第三方声明及许可证全文的 `THIRD_PARTY_NOTICES.txt`。缺独立许可证文件的包使用共享 SPDX 标准全文，
附包内已有的作者/版权元数据；嵌入的 QuickJS-NG 引擎另附上游声明。notices 生成完全离线。
Web source maps 单独作为 release 资产。

源码 checkout 的 `dist/` 保留普通 TypeScript 构建产物。源码模式 daemon 通过发布所用的同一个
`bundle.mjs` 暂存待安装的包，不替换 checkout 的 `dist/` 或 package manifest。
本地重建另生成 JavaScript source maps，仅保留在本机，不进入 npm tarball。

## Agent-Server 架构：六层结构 {#agent-server-architecture-six-layers}

`agent-server/src/` 下的 agent-server 代码组织为六层（L0 到 L5），另有两个各自有规则的适配器目录。运行时每层只能从其下方的层导入；仅类型导入可以跨层。这些规则由 `agent-server/.dependency-cruiser.cjs` **在测试时强制执行**——`npm test` 会运行 `depcruise`，出现任何运行时违规即失败（`npm run test:quick` 跳过这一步）。

```
L0  core/          → (no runtime dependencies)
L1  store/         → core
L2  events/        → core
L3  domain/        → core, store, events, platform, agent-adapter
L4  orchestration/ → core, store, events, domain, platform, agent-adapter
L5  entry/         → everything (composition root)

    platform/      → core, events
    agent-adapter/ → core, store, events
```

`orchestration/` 还必须没有导入环。

- **`agent-adapter/`** —— 两个 LLM 后端的抽象（Claude Code 和 PI）。`domain/runs/adapters.ts` 是组装这些适配器的唯一位置。
- **`platform/`** —— 消息与传输层：Slack 和飞书适配器、TUI 网关、同时运行多个平台的组合适配器（`adapters/`）、Web UI HTTP 宿主（`ui-http/`），以及服务器上的 Chrome 和 agent-browser 进程调用（`browser/`）。

另一个目录 **`tui/`** 是 `cortex tui` 运行的 Ink 终端客户端。它只通过 TUI 网关的 WebSocket 与服务器通信，共用网关的协议类型和 i18n 字符串，没有自己的分层规则。

### 第 0 层：`core/` — 共享内核 {#layer-0-core-shared-kernel}

其他各层共同依赖的共享内核：类型、路径常量、设置，以及内存中的运行与会话状态。它在运行时不导入其他层；可以导入它们的类型，hook bus 条目、环境定义这类 core 类型就是这样引用归属别处的结构。

| 文件 | 用途 |
|------|---------|
| `paths.ts` | 规范路径常量：`INSTALL_ROOT`、`DEFAULTS_DIR`、`DATA_DIR`（`~/.cortex/`）、`CONFIG_DIR`、`STORE_DIR`（`data/`）、`CONTEXT_DIR`、`PROJECTS_DIR`、`WORKSPACE_DIR`（`tmp/`）、`PLUGINS_DIR`、`PROMPTS_DIR`、`HOOKS_DIR`、`LOGS_DIR`、`AGENT_CWD`、`CLAUDE_CONFIG_HOME`，以及守护进程 PID 文件和重启触发文件 |
| `settings.ts`、`settings-spec.ts` | `config/settings.json` 中的运行时设置：带默认值和旧变量的键 schema、校验、缓存快照和热重载（参见 [configuration.md](./configuration.md#configsettingsjson)） |
| `utils.ts` | 工具函数：`chunkText`、`formatDurationCompact`、`todayISO`、`listProjectDirs`、`readableTimestamp`、npm prefix 解析 |
| `atomic-write.ts` | `atomicWrite(filePath, data)` / `atomicWriteSync` —— 写入 `.tmp.<pid>.<ts>.<rand>` 后 `fs.rename`；`mutateFileAtomically` 用于读-改-写 |
| `json-repository.ts` | 通用 `JsonRepository<T>` 基类：`read()`、`write()`、`mutate(fn)`、`flush()`。首次 I/O 时惰性清理孤立的 `.tmp.*` 文件。损坏 JSON 备份机制 |
| `async-mutex.ts` | `AsyncMutex` 类——基于 Promise 的互斥锁，用于串行化异步磁盘写入。在整个存储层中使用，防止并发写坏文件 |
| `log.ts` | `createLogger(tag)` —— 控制台 + 按日滚动的文件输出，保留 14 天 |
| `i18n.ts`、`locales/` | 系统生成消息的英文与中文字符串；由 `CORTEX_LANG` 或 `!lang` 偏好选择语言 |
| `cli-utils.ts` | `formatHelp`、`formatError`、`readStdinSync`、`readStdinBufferSync`、`cliError` —— 共享 CLI 格式化 |
| `status-format.ts` | 纯格式化：`computeElapsed`、`formatMetricsSuffix`、`buildSessionTag`、`buildUserProcessingMessage`、`renderTurnStatus` |
| `rebuild-progress.ts` | 监督器发布到 `daemon-rebuild.json` 的热重建进度记录：纯步骤状态迁移（`planRebuildProgress`、`startRebuildStep`、`finishRebuildStep`、`settleRebuildProgress`），以及一个永不抛异常的读取 |
| `run-registry.ts` | `RunRegistry` —— 当前存活执行的唯一内存索引，以 executionId 为键、按频道建索引。向 EventBus 发布 `agent.*` 生命周期事件 |
| `session-holds.ts` | `SessionHolds` —— "会话是否忙"的另一半：回合已结束但后台工作仍在继续，带按所有者区分的句柄、替代与停止 |
| `session-state.ts` | `sessionState(sessionId)` / `channelEngineBusy()` —— 存活执行与 hold 的唯一汇合点，也是判断会话是否忙的唯一位置 |
| `agents/` | 子代理角色加载（`roles.ts`），以及两个后端共用的委托 schema、模型选择和编排（`subagent/`） |
| `types/agent-types.ts` | `Backend`、`AgentResult`、`AgentProgress`、`AskUserQuestionInfo`，以及 todo、上下文用量、附件和通知的结构 |
| `types/environment-types.ts` | 执行环境类型：`AgentDefinition`（对应一个 `config/environments/*.json` 文件），以及一次运行打开时使用的 `ResolvedEnvironment` |
| `config-generator.ts` | 新安装的配置文件初始化，以及每次启动时写入的 MCP 配置 |
| `gateway-generator.ts` | API 网关 YAML 生成 |
| `models-generator.ts` | 默认模型与收藏 JSON 生成 |

### 第 1 层：`store/` — 持久化 {#layer-1-store-persistence}

所有写操作都经 `AsyncMutex` 串行化，防止并发写入造成损坏。该层使用两种仓库模式：

- **模式 A（JsonRepository 委托）**：`JsonRepository<T>` 的简单 CRUD 包装。用于 schedule-repo、cost-repo、board-repo、waitpoint-repo、provider-state-repo 以及大多数其他仓库。所有写入都经过 `atomicWrite()`。
- **模式 B（内存 Map + 即发即忘持久化）**：读走同步的内存 `Map`，写走异步持久化链。用于 execution-repo，那里读延迟很重要，崩溃后数据陈旧可以接受。

| 文件 | 用途 |
|------|---------|
| `outbound-queue.ts` | 基于 WAL 的持久化出站消息队列。30 分钟 TTL，200 条压缩，5 秒排空循环。合并对同一条消息的连续更新 |
| `conversation-ledger-repo.ts` | `session-registry-repo.ts` 的外观层——提供相同的按频道回合 API（`initConversation`、`beginTurn`、`addResponseTs`、`completeTurn`、`rollbackTo`），自身没有文件 |
| `session-registry-repo.ts` | 基于 JSONL 的 UUID 会话注册表，也是会话记录、频道→会话绑定以及按频道的对话头与回合的唯一所有者。回放仅追加日志（`put`/`patch`/`delete-intent`/`delete-commit`/`bind`/`unbind`/`turn`/`conversation`）、接纳会话，并在日志增长后压缩快照 |
| `conversation-history-repo.ts` | `data/conversation-history/` 下按会话的 transcript JSONL，Web UI 据此渲染对话 |
| `execution-repo.ts` | 模式 B 仓库：`startLocalExecution`、`completeExecution`、`failExecution`、`cancelExecution`。启动时 `markMissingRunningExecutionsStale` 把已不存活的运行标为陈旧；超过七天的终态记录归档到 `data/archive/` |
| `project-dir-repo.ts` | `projectName → machineName → dirPath`，支持反向频道查找 |
| `schedule-repo.ts` | 定时任务持久化。`ScheduleTask` 接口；`schedules.json` 与进程外的写入方共用 |
| `cost-repo.ts` | 费用存为 JSONL（仅追加），预算存为 JSON。启动时修剪超过 90 天的记录 |
| `models-repo.ts` | 同步缓存读取器。`startModelsWatcher()` 用于热重载 |
| `waitpoint-repo.ts`、`provider-state-repo.ts`、`board-repo.ts` | Waitpoint、提供商限流状态与恢复队列，以及看板注册表 |
| `team-inbox-repo.ts`、`team-outbox-repo.ts` | 团队 lead 与其 worker 之间的消息，跨重启保留 |
| `hook-registry.ts`、`hook-writer.ts` | 钩子注册表：内置声明之上叠加 `config/hooks/`，以及钩子开关背后的写入器 |
| `version-migrations.ts` | `$CORTEX_HOME` 的一次性升级迁移，启动时运行 |

### 第 2 层：`events/` — 事件总线 {#layer-2-events-event-bus}

同步、类型安全的事件总线，带 JSONL 日志。

| 文件 | 用途 |
|------|---------|
| `event-types.ts` | `CortexEvent` 可区分联合，分组见下文，另加两个元事件（`event-bus.handler-failed`、`event-logger.dropped`） |
| `event-bus.ts` | `EventBus` 类 —— `subscribe(type, handler)` / `publish(event)`。同步扇出。异步处理器即发即忘。对 `event-bus.handler-failed` 有重入保护。提供用于 SIGTERM 排空的关闭钩子 |
| `event-logger.ts` | 订阅 `'*'`，1024 条环形缓冲区，100ms 刷新间隔，`logs/events/` 下按日滚动的 JSONL，保留 14 天。由 [`config/settings.json`](./configuration.md#configsettingsjson) 中的 `eventLog` 设置控制（旧环境变量 `CORTEX_EVENT_LOG=off` 作为已弃用的回退读取） |

**事件类别：**

- **Session**：`session.message`、`session.message.delta`、`session.message.delivered`、`session.status`、`session.turn`、`session.turn.completed`、`session.todos`、`session.context-usage`、`session.context-compacted`、`session.rewound`、`session.decision`、`session.board`、`session.interaction`、`session.tool-images`、`session.debug.updated`
- **Interaction**：`plan.submitted`、`plan.approved`、`ask-user.requested`、`ask-user.answered`
- **Agent lifecycle**：`agent.started`、`agent.completed`、`agent.failed`、`agent.superseded`
- **Auth**：`auth.required`、`auth.recovered`
- **Board**：`board.updated`、`board.style-updated`
- **System**：`system.notice`、`config.changed`、`llm.active-count-delta`、`rate-limit.changed` 和 `ui.mutate-invoked`

### 第 3 层：`domain/` — 业务逻辑 {#layer-3-domain-business-logic}

最厚的一层。每个领域关注点一个子目录。

| 子目录 | 用途 |
|-------------|---------|
| `agents/` | 引擎选择、收藏、模型记忆、执行环境（`agents/environments/`）、子代理运行器和凭据：一次运行可以配置成什么。启动运行属于 `runs/` |
| `runs/` | 运行层：`startRun` 与 `AgentRun` 所有权对象、`RunRequest` 的引擎选择/spec/提示解析及其共享构建器（`builders.ts`）、后端中立的 `RunEvent` 流，以及 `SessionEngines` 池 |
| `sessions/` | 会话生命周期与记录、会话钩子管道（`onNew`、`onMessageEnd`、关闭前）及可选的智能体注入、团队会话，以及保留期清理 |
| `executions/` | 基于 `store/execution-repo.ts` 的执行注册表访问，以及存活执行的清理与停止 |
| `auth/` | Claude Code、PI 和 Codex 的凭据与登录流程、认证状态与过期监视，以及登录后的网关同步 |
| `pi-providers/` | 自定义 PI 提供商：`cortex auth provider` 背后的模型目录条目和网关路由 |
| `costs/` | 费用追踪、网关管理、用量采集、账户读数与 banked reset、按提供商感知的速率限制 |
| `scheduling/` | 持久化调度引擎，加上由设置驱动的内置作业控制器。`Scheduler` 热重载用户定时任务，每次触发都新开一个会话；记忆索引重建等内置作业拥有自己的守护进程计时器 |
| `waitpoints/` | Waitpoint 服务：布设、信号解析、过期，以及唤醒会话的通知（参见 [waitpoints.md](./waitpoints.md)） |
| `boards/` | 看板服务、路径与 slug、重新渲染已打开看板的文件监视器，以及把决策投射到看板上 |
| `plugins/` | 插件目录、内置与用户插件加载、技能投射，以及插件 MCP 服务器 |
| `projects/` | 项目注册表：脚手架、扫描 `context/projects/`，以及项目元数据 |
| `memory/` | 记忆/索引管理。`index-regen.ts` 从 YAML frontmatter 和访问日志重建生成的 index.md 文件（CLI：`cortex memory regen`）。上下文变更的文件监视器。AGENTS.md 扫描与注入，以及规则加载器 |
| `hooks/` | 供 Web UI 使用的钩子注册表只读视图 |
| `monitor/` | GPU 和磁盘资源监控 |
| `system/` | 主机层面的事务：doctor 检查、更新状态与提示、系统通知及其历史，以及 `rebuild-hold.ts` —— 由监督器下推、供准入判断读取的"不开新回合"状态 |
| `browser/` | Agent 浏览器的 broker（`broker.ts`）：每个会话一个租约，把会话绑定到服务器或设备上 Chrome 里它自己的 tab，空闲 10 分钟后关掉这个 tab，并记录用户的接管状态（见 [agent-browser.md](./agent-browser.md)） |
| `remote/` | 通过 WebSocket 的远程设备管理。基于 SSH 的客户端引导；客户端根据服务器推送的 bundle 自我更新 |
| `mcp/` | 内置的 Cortex MCP 服务器及其工具模块（参见 [mcp.md](./mcp.md)） |
| `ui-service/` | Web UI 的后端：tRPC `AppRouter`（`app-router.ts`）、其 query 与 mutation 处理器，以及把实时事件流式推送给 UI 的事件总线订阅（`subscribe.ts`） |
| `tui-session/` | TUI 网关的会话握手与切换 |
| `benchmark/` | 生产基准证据：attempt 身份与日志，以及 `cortex-evidence-export` 背后的导出 |

### 第 4 层：`orchestration/` — 消息路由和执行 {#layer-4-orchestration-message-routing-and-execution}

将平台消息连接到领域逻辑。hook-bridge（本层的一部分）详见 [hooks.md](./hooks.md)。

| 文件 | 用途 |
|------|---------|
| `conduit-queue.ts` | 按 conduit 的串行 Promise 队列。确保每个对话同一时刻只运行一个回合，并允许 `!cancel` 丢弃排队中的尾部 |
| `orchestrator.ts` | 把每条入站消息交给 `AgentRunner` |
| `agent-runner.ts` | 默认智能体路径的准入：路由、回合中注入、排队，以及一个回合所需的会话与租约解析。回合本体属于 `turn/turn.ts` |
| `session-gateway.ts` | `deliverToSession()` —— 除入站平台消息外，所有进入对话回合的事物（web 发送、定时触发、智能体结果、恢复、waitpoint 唤醒）的唯一入口 |
| `session-events.ts` | 发布 Web UI 和 TUI 渲染的 `session.*` 事件：消息、增量、状态、回合、todo、上下文用量 |
| `runtime.ts` | `PlatformAdapter` + `EventBus` 的编排持有者，由组合根注入一次 |
| `conversation-request.ts` | `prepareConversationRequest()` —— 为普通聊天回合组装 `RunRequest`：智能体 spec 加首回合的环境信息块 |
| `turn/turn.ts` | `Turn` / `openTurn()` —— 一个对话回合的唯一所有者：状态消息、账本回合追踪、会话租约、`startRun`、观察者扇出、终态渲染、`running:true/false` 括号 |
| `turn/turn-prep.ts` | 调用方在 `openTurn` 之前要解析的内容：回合的文件、会话记录与使用租约 |
| `turn/terminal.ts` | 回合的终态渲染：状态封存、账本的回合完成、错误正文、错误会话持久化 |
| `turn/turn-tracking.ts` | 回合簿记中账本的那一半：开始、快照、接受，以及等待期间的替代窗口 |
| `turn/active-turns.ts` | 按频道的回合状态：回合注册的流式回调、编辑替代标记 |
| `turn/background-hold.ts` | "回合已结束但会话未结束"的统一 hold 生命周期：忙碌括号、`SessionHolds` 注册、运行订阅、六种终态判定 |
| `turn/hold-render-platform.ts` | 被 hold 回合在 Slack/飞书上的渲染——后台阶段运行期间的状态行及其封存 |
| `turn/hold-render-web.ts` | 被 hold 回合在 web 上的渲染——续写的正文、工具和通知，发送到会话事件流上 |
| `mid-turn-inject.ts`、`session-compact.ts`、`session-rewind.ts` | 把消息引导进正在运行的回合、按请求压缩，以及把对话回退到更早的回合 |
| `subagent-*.ts`、`team-*.ts` | 把后台子代理结果和团队 worker 报告投递到其父会话或 lead 会话 |
| `waitpoint-*.ts` | Waitpoint 信号接入、周期性清扫、从已连接设备排空暂存的信号，以及唤醒通知 |
| `session-retention-controller.ts` | 在启动时、每 6 小时以及保留期设置变更时运行会话保留清理 |
| `resume-dispatcher.ts` | 限流恢复队列：窗口重置后继续被用量限制中断的会话 |
| `busy-tracker.ts` | 追踪活跃 LLM 数量，向父守护进程发送 IPC `busy`/`idle` |
| `human-answer-backstop.ts` | 等待人工自由文本回复的频道的叶子注册表，每个进入会话的入口都会查询它，使回复被消费而不是开启新回合 |
| `routing/message-router.ts` | 平台消息入口：在适配器上注册入站消息处理器，并委托给 orchestrator |
| `routing/commands/` | `!command` 处理器，每个命令族一个模块：`cancel`、`channel`、`compact`、`cost`、`device`、`lang`、`login`（含 `login-custom`）、`mode`、`nvtop`、`orient`、`restart`、`schedule`、`sendfile`、`session`、`status`、`tail`、`usage`（含 `usage-reset`）。`index.ts` 把命令词——`!agent`、`!backend`、`!model`、`!thinking`、`!new`、`!resume`、`!usage` 等——映射到这些模块 |
| `routing/webhook.ts` | 回环 webhook 服务器（`WEBHOOK_PORT`，默认 3001）：钩子回调、`cortex-signal`、`cortex-browser` 租约（`browser-webhook.ts`）、子代理、团队和看板回调 |
| `routing/hook-bridge.ts` | PreToolUse 钩子 → EventBus 桥接。发布 `plan.submitted` 和 `ask-user.requested` |
| `routing/hook-bridge-subscribers.ts` | 把问题或提交的计划转为交互记录的订阅者，各个界面将其渲染为卡片 |
| `interactions/` | AskUserQuestion 流程、计划审批状态机、按钮/模态框动作路由 |

### 第 5 层：`entry/` — 组合根 {#layer-5-entry-composition-root}

| 文件 | 用途 |
|------|---------|
| `app.ts` | **组合根**。加载 `.env` 并迁移旧设置，然后依次连接 EventBus → event logger → hook bridge → RunRegistry/plan approvals/busy tracker → platform adapters → outbound queue → auth watch → scheduler → commands → interactions → message handler → Web UI host → platform connect → client manager → webhook → memory watcher |
| `shutdown.ts` | SIGTERM 处理：一个有序的关闭步骤列表，前一步失败后续步骤照样执行，最后退出 |
| `daemon.ts` | 进程监督器。Fork `app.js`，监视 `$CORTEX_REPO/src` 以自动重建（设置了 `CORTEX_REPO` 时），监视 `.restart` 触发文件，带指数退避的崩溃恢复（1s→30s 上限）。发布逐步骤的重建进度，在 install/restart 之前等待 app 空闲，并在这段窗口内拦住新回合（见下文） |
| `daemon-notice.ts` | 下行 IPC 的 app 侧：把 `rebuild-aborted` 变成系统通知、把 `rebuild-hold` 变成准入侧的闸门，并在监督器断开连接时解除闸门 |
| `cortex-cli.ts`、`cli.ts` | `cortex` CLI 入口。分派到 `init`、`config`、`auth`、`doctor`、`feishu`、`restart`、`setup-gateway`、`ui`、`client`、`install`、`schedule`、`memory`、`start`、`daemon`、`tui`，各自在独立的 `*-cli.ts` 模块中实现（参见 [cli-reference.md](./cli-reference.md)） |
| `browser-cli.ts`、`hook-cli.ts`、`signal-cli.ts`、`production-evidence-export-cli.ts` | `cortex-browser`、`cortex-hook`、`cortex-signal` 和 `cortex-evidence-export` 可执行文件 |
| `init.ts` | 交互式首次初始化 |
| `start-ui-http.ts`、`ui-http-gate.ts`、`ui-service-wiring.ts` | 在 `CORTEX_UI_HTTP` 开启时启动 Web UI 宿主，并连接它所提供的 `UiService` |
| `startup-helpers.ts` | 清理日志、确保 MCP 配置 |
| `startup-notify.ts` | 向管理频道发送启动私信 |
| `platform-connect.ts` | 启动各平台适配器。TUI 网关绑定完成后启动流程才继续；Slack 和飞书在后台连接，启动从不等待网络握手（出站消息走它们的 HTTP API，不走长连接）。连接失败会在 5 秒、30 秒、2 分钟后重试，之后报告为错误通知；60 秒后仍在连接的平台报告为警告 |

### 热重建：发布的进度与回合闸门 {#hot-rebuild-published-progress-and-the-turn-hold}

`CORTEX_REPO` 指向 checkout 的 `agent-server` 目录时，源码改动会让监督器重新构建各软件包、
重新安装自身，并替换 app 进程。构建分三条并发 lane 进行。其中一条是有序链——
先 `server`，再 `ui-contract`，最后 `web-typecheck`——因为 ui-contract 重新导出 server 构建出的
类型，而 web 的类型检查依赖 ui-contract 的构建产物。另外两条 `web-bundle` 和
`web-depcruise` 只读 web 源码，一开始就与它并行。每条 lane 都会跑到底，
任何一步失败都会在安装之前终止这次重建，并发出一条点名每个失败步骤的通知。
构建成功后，`bundle.mjs` 在全新 stage 中生成发布布局，带 `cortexBundle: true` 标记。
构建或 stage 失败时，现有安装和 app 保持不变。已装包同样为打包版，且外部依赖声明与 stage 一致时，
fast install 整体替换 `dist`、`web`、`defaults`、`vendor`、`scripts` 目录及包元数据，保留 `node_modules`。
它不是叠加覆盖，因此过时的 hash chunk 会被清除。依赖改变或已装包为未打包版时，
在 stage 内执行 `npm pack --ignore-scripts`，再向原 prefix 执行 `npm install -g`。

本地 stage 包含映射到打包前可读 JavaScript 的 linked source maps。npm tarball 排除这些文件；
完整安装成功后，本地安装器从 stage 补复制 maps。daemon 发现 app 入口的 map 时，
以 `--enable-source-maps` 启动 app；发布包不带 server maps。daemon 自己发起的安装跳过 postinstall
重启通知，由 daemon 直接重启 app；外部 npm 升级仍通过 postinstall 通知 daemon，在空闲时重启 app。

`CORTEX_REBUILD_BUNDLE=0` 是恢复选项，选择普通未打包 build 和源码 fast install / pack-install 路径。
从打包版退回该布局需要完整替换。开关在 daemon 启动时读取：在空闲维护窗口运行
`CORTEX_REBUILD_BUNDLE=0 cortex daemon restart-self`，再运行 `cortex daemon restart` 请求源码重建。
将同样命令里的值设为 `1` 可恢复打包重建。源码重建替换的是安装文件和 app，不是运行中的监督器；
daemon 代码变更须在新版 daemon 文件安装后，通过 `restart-self` 生效。两种布局都保留 `CORTEX_HOME`。

**进度写在文件里，不在内存里。** 流水线在第一步之前就把完整计划写入
`$STORE_DIR/daemon-rebuild.json`——这个 checkout 会跑的步骤（上述构建步骤，随后是打包模式下的
`bundle`、`install` 和 `restart`）、哪些正在进行、每一步如何结束（`done`、`failed`、
`skipped`），其中 `install` 步骤还记录它走的是快速 staged-rename 路径还是
`npm pack` + `npm install -g`。只能用文件：流水线的最后一个动作就是替换掉本该保存这份
状态的进程，所以内存里的任何东西都无法告诉新的 `app.js`，催生它的那次
重建做了什么。`system.daemonStatus` 读取这条记录，daemon 页面渲染它，
重建进行时每秒轮询一次。`daemonPid` 不是当前存活监督器的 `running` 记录会被丢弃，
而不是永远显示下去；终态记录则会保留，这样"上次重建在 `web-typecheck` 失败"
在重启之后依然可读。终态有 `succeeded`、
`aborted` 和 `deferred`。

**流水线中危险的那一半会等待 app 空闲。** 构建步骤读取仓库、
写入 `dist/`，打包写入独立 stage；`install` 步骤替换运行中 `app.js` 加载的文件，`restart`
则杀掉它。因此 busy/idle 会检查两次：构建之前一次，准备完成后再一次，因为构建
要花数分钟，这期间完全可能有回合正当地开始。第二道门发现子进程忙碌时，
会把触发暂存到 `pendingRebuild`、把记录发布为 `deferred`，并在下一次转为空闲时
重跑整条流水线——真实工作会被等待而不是被拒绝，因为被拒绝的回合不等于被延迟的
回合（waitpoint 唤醒或后台智能体的结果会被直接丢掉）。

**在进程被替换的那几秒里不开新回合。** 进入 `install` 或 `restart`——或
排队一次重启——会让监督器通过 fork IPC 下发 `rebuild-hold`，准入侧
（`agent-runner.ts`）会在追踪、入队或回合中注入之前就拒绝：
此刻开始的回合会被片刻之后的 SIGTERM 变成孤儿，它的后端 CLI 还在往
无人读取的管道里写。范围刻意收窄——绝不包括构建阶段——因此它能拦到的只有
落在空闲检查与 SIGTERM 之间那个 tick 级竞争窗口里的消息。正在打字的人
会在频道内收到一条点明当前阶段的回复；没人等待的回调或系统消息
则变成一条 warning 级系统通知，点明丢掉的是什么。闸门带一个
五分钟租约，由每条阶段消息续期，因此中途死掉的监督器无法永久让 app
静音，而 IPC `disconnect` 会立即解除闸门。

## LLM 后端适配器 {#llm-backend-adapter}

`agent-adapter/` 目录在统一接口之后抽象两个 LLM 后端：

| 后端 | 适配器 | 备注 |
|---------|---------|-------|
| Claude Code | `claude/adapter.ts` | 无状态引擎适配器：打开一个 Claude 进程会话（print 模式）、spawn-args 构建器、事件解析器与转换器 |
| PI | `pi/adapter.ts` | 无状态引擎适配器：打开一个进程内 PI 会话、MCP 桥接、钩子桥接、工具垫片 |

会话池位于 `domain/runs/engines.ts`（`SessionEngines`），不在任何一个适配器里。

每个适配器把各自后端的事件转换为统一的 `NormalizedEvent` 结构（`normalize/`）和 `RunEvent` 流（`run-events.ts`）。`capabilities.ts` 文件声明 `Capability` 枚举，以及 Claude 和 PI 的能力集。运行、会话与引擎如何组合，参见 [backends.md](./backends.md)。

## 平台适配器 {#platform-adapter}

`platform/adapter.ts` 定义 `PlatformAdapter` 接口。Slack（`adapters/slack.ts`）、飞书（`adapters/feishu.ts`）和 TUI 网关（`adapters/tui/`）实现它，`adapters/composite-adapter.ts` 把在线的平台合并为一个适配器，将每次出站调用路由到拥有该 conduit 的平台（`slack:`、`feishu:`、`tui-`）。Web UI 不经过这个接口；它通过 `domain/ui-service/` 读取和驱动会话（参见 [Web UI 协议](#web-ui-protocol)）。

| 成员 | 用途 |
|--------|---------|
| `name` / `capabilities` | 身份标识与平台支持的能力 |
| `start` / `stop` | 生命周期 |
| `onMessage` / `onMessageEdit` / `onAction` / `onModalSubmit` | 事件注册 |
| `postMessage` / `updateMessage` / `deleteMessage` | 出站消息 |
| `postInteractive` | 带按钮的交互式消息 |
| `openModal` | 模态框 |
| `markQueued` / `unmarkQueued` | 排在运行中回合之后的消息上的排队标记 |
| `uploadFile` / `downloadFile` | 文件操作 |
| `openOutputStream` | 在智能体输出到达时即时渲染的流 |
| `bindProjectConduit` / `unbindProjectConduit` / `getProjectConduits` / `resolveInboundProject` | 项目 ↔ 频道绑定 |
| `ownsConduit` | 某个 conduit id 是否属于本平台 |
| `getPermalink` / `adminChannelKey` / `setAdminChannel` | 工具方法，以及用于系统通知的管理频道 |

`OutputStream`（`platform/output-stream.ts`，Slack、飞书和分块实现位于 `adapters/` 下）把回合的输出送到聊天平台：已提交的文本、可变区域（如状态行，后续编辑会原地更新），以及交互式消息；内容被切分为平台接受的块，并排队以保证更新按序到达。

## WebSocket 协议（服务器 ↔ 客户端） {#websocket-protocol-server-client}

WebSocket 协议用于**远程设备命令执行**，不承载聊天或 UI 流量。服务器通过 `startClientManager()` 运行 WebSocket 服务器（默认端口 3002，`CORTEX_CLIENT_PORT`）。每个连接都在 `x-cortex-token` 头中出示客户端 token。完整的跨机器方案——部署、网络拓扑和安全——参见 [cross-machine.md](./cross-machine.md)。

### 消息流 {#message-flow}

1. **客户端连接** → 发送 `{ type: 'hello', device, platform, capabilities, gpuCount, bundleHash, pid? }`
2. **服务器校验** → 缺少设备名时以 `4001` 关闭，`machines.json` 未列出该设备时以 `4005` 关闭，该设备已连接时以 `4002` 关闭
3. **心跳** → 客户端每 5 秒发送 `{ type: 'heartbeat', device, timestamp }`。设备静默 15 秒后服务器关闭连接（代码 `4003`）
4. **命令分发** → 服务器发送 `{ type: 'command', commandId, action, params }`。客户端执行并以 `{ type: 'result', commandId, success, data, error }` 回复
5. **更新** → `bundleHash` 与服务器的客户端 bundle 不一致时，服务器发送 `{ type: 'update', hash, files }`；客户端安装后回复 `update-result`，并以新 bundle 重启
6. **流** → `open-stream`（TCP 端口转发）和 `open-file-stream`（文件传输）要求客户端回拨一条单独的 WebSocket 传输字节；回调中指定了未知流的连接以 `4004` 关闭

### 命令动作 {#command-actions}

客户端支持这些远程动作：`bash`（带超时/后台的 shell 执行）、`read`（支持文本/图像/PDF 的文件读取）、`write`（带 CRLF 检测的文件写入）、`edit`（支持 replace_all 的文本替换）、`glob`（排除 VCS 目录的文件 glob）、`grep`（带分页的 ripgrep）、`file.stat`（传输前的元数据探测）。

### 客户端架构 {#client-architecture}

客户端（`client/src/client.ts`）是一个轻量级 WebSocket 守护进程，维护持久连接。它支持带指数退避的自动重连（1s→30s 上限）。它不启动也不托管长时间运行的任务：那类任务独立运行，并通过 [waitpoint](./waitpoints.md) 回报。

## Web UI 协议 {#web-ui-protocol}

浏览器工作台、桌面应用和移动应用都通过同一个 HTTP 宿主（`platform/ui-http/`）与服务器通信，它在 `CORTEX_UI_HTTP` 开启时启动。它监听 `127.0.0.1:3004`（`CORTEX_UI_PORT`）；远程访问经由隧道或局域网代理（参见 [browser-access.md](./browser-access.md) 和 [desktop-app.md](./desktop-app.md)）。

- **tRPC** 位于 `/trpc/` 下。query 和 mutation 是针对 `domain/ui-service/app-router.ts` 中 `AppRouter` 的普通 HTTP 请求；web 应用从 `packages/ui-contract` 获取类型。
- **实时事件**通过 Server-Sent Events 上的单个 `subscribe` 订阅传递。客户端指定想要的事件类型，可限定到某个项目或会话，服务器经有界队列转发总线上匹配的 `CortexEvent`，客户端跟不上时发送 `ui-subscribe.dropped`。订阅流式文本的客户端会先收到一份进行中的助手消息快照。
- **认证**按顺序检查：携带客户端 token 或已配对应用自己设备 token 的 `x-cortex-token` 头（桌面和移动应用）、token 登录得到的 `cortex_ui` 会话 cookie（`/api/ui/login`、`/api/ui/logout`、`/api/ui/session`），或 Cloudflare Access JWT。应用和浏览器用一次性配对码接入（`/api/ui/pair`、`/api/ui/pairing-code`）；已配对的应用通过 `/api/ui/devices` 与 `/api/ui/devices/revoke` 查看和撤销。非同源的浏览器来源需要在 `uiCorsOrigins` 设置中添加条目。
- **其他路由**：文件下载与附件上传（`/api/files/download`、`/api/attachments/upload`）、看板资源（`/api/boards/asset`）、桌面应用下载的 web bundle 更新（`/api/ui-ota/manifest.json`、`/api/ui-ota/bundle.zip`）、原生应用更新清单（`/api/app-update/manifest.json`）、到远程机器的端口转发（`/api/forward/*`，配合 `/forward` WebSocket），以及 agent 浏览器：会话列表、接管和输入文本（`/api/browser/*`），实时画面走 `/api/browser/stream` WebSocket。
- 同一个宿主还提供构建好的 web 应用，因此浏览器从同一个源加载 UI 及其 API。

TUI 使用端口 3003（`CORTEX_TUI_PORT`）上单独的 WebSocket 网关，钩子和信号则通过端口 3001 上的回环 webhook 到达服务器。

## 事件总线拓扑 {#event-bus-topology}

EventBus 在 `app.ts` 中创建。`runRegistry`、`planApprovals` 和 `busyTracker` 构造时没有依赖，再通过 `setBus(bus)` 连接；其他组件都以参数形式接收总线。

| 组件 | 发布 | 订阅 |
|-----------|-----------|------------|
| `runRegistry` | `agent.started/completed/failed/superseded` | — |
| `eventLogger` | `event-logger.dropped` | `'*'`（所有事件 → JSONL） |
| `hookBridge` | `plan.submitted`、`ask-user.requested` | — |
| `routing/hook-bridge-subscribers.ts` | — | `plan.submitted`、`ask-user.requested` |
| `planApprovals` | `plan.approved` | — |
| `interactionHandlers` | `ask-user.answered` | — |
| `busyTracker` | `llm.active-count-delta`（待处理的后台任务） | `llm.active-count-delta`，计数后发送 IPC `busy`/`idle` |
| `orchestration/session-events.ts` | `session.*` | — |
| `domain/auth/` | `auth.required`、`auth.recovered` | `auth.*`（认证监视） |
| `domain/boards/` | `board.updated` | `board.updated`（看板监视器） |
| `domain/system/system-notice.ts` | `system.notice` | — |
| `app.ts` | `config.changed`、`rate-limit.changed` | `session.status`（会话 hold） |
| `resume-dispatcher.ts` | — | `agent.completed/failed/superseded` |
| `team-delivery.ts`、`subagent-delivery.ts` | — | `session.turn.completed`、`session.status` |
| `domain/ui-service/` | `ui.mutate-invoked` | 每个 UI 订阅请求的事件类型 |

## 状态存储 {#state-storage}

Cortex 把所有状态存放在 `~/.cortex/` 下的文件系统中。没有数据库——所有内容都是磁盘上的 JSON 或 JSONL，其中 session registry 和 history 路径刻意采用面向追加的设计。下表路径相对于 `~/.cortex/`；完整目录树见 [configuration.md](./configuration.md#file-hierarchy)。

| 路径 | 用途 |
|------|---------|
| `data/agent-state.json` | 频道引擎选择、模型记忆、新会话选择与默认智能体 |
| `config/models.json` | 默认引擎选择与收藏模型列表 |
| `config/budget.json` | 每日和每月预算上限 |
| `config/environments/` | 执行环境——每个环境一个 JSON 文件 |
| `data/schedules.json` | 持久化定时任务列表 |
| `data/boards.json` | 看板注册表：每个看板的所属项目、slug、标题、创建时间和最近使用时间（新建、有会话接入或文件变化）。页面本身在项目上下文的 `boards/<slug>/` 下 |
| `data/session-registry.jsonl` | 仅追加的 JSONL 日志，也是会话记录、频道→会话绑定以及按频道的对话头与回合的唯一所有者。事件：`put`/`patch`/`delete-intent`/`delete-commit`/`bind`/`unbind`/`turn`/`conversation`；启动时流式回放以重建 live 和 pending 状态。压缩保留 live 记录 + 绑定 + live 回合；当日志事件数超过 `max(512, live×4, 2×compacted)`——其中 `compacted` 是一次压缩会写出的事件数——或文件同时超过 16 MB 与上次压缩后大小的两倍时运行。一次性升级迁移会导入已退役的 `sessions.json` 和 `conversation-ledger.json`，并将它们重命名为 `*.pre-2026.9.14.bak` |
| `data/retention-candidates.json` | history 与 PI 清理用的两轮确认孤儿候选 |
| `data/conversation-history/` | 以稳定 Cortex session id 为键的按会话 transcript/history JSONL |
| `data/executions.json` | 统一执行注册表 |
| `data/archive/` | 超过一周的终态执行记录，从 `executions.json` 中移出 |
| `data/provider-state.json` | 提供商用量、限流窗口，以及按提供商归属的恢复队列 |
| `data/waitpoints.json` | Waitpoint 及其信号 |
| `data/team-inbox.json`、`data/team-outbox.json` | 团队 lead 与 worker 之间的消息 |
| `data/ui-sessions.json` | Web UI 的浏览器登录会话 |
| `browser/profile/` | 服务器上 agent 浏览器的 profile：cookie 和登录状态 |
| `data/daemon-rebuild.json` | 监督器发布的热重建记录：计划、逐步骤状态与耗时，以及上次重建的终态结果 |
| `data/costs.jsonl` | 每次调用的费用记录（90 天滚动） |
| `logs/sessions/` | 用于保留保护/清理的 Claude capture 日志 |
| `logs/sessions-pi/` | 以后端 session id 为键的 PI transcript bundle |
| `logs/` | 守护进程和后端日志，以及 `logs/events/` 下的每日事件日志 |

session registry 是一个仅追加的日志，而非可变的 JSON 文件。`session-registry-journal.ts` 持有一个仅追加 JSONL 文件，其中 `put` 和 `delete-intent` 事件携带完整的会话记录，最后以 `delete-commit` 完成删除。delete intent 还会固化通过校验的 Claude turn-backup 清理 manifest，因此之后的重试不依赖一份可能已被先前部分清理删掉的账本。启动时先把任何遗留的 `session-registry.json` 文件迁移进日志、为该遗留文件写一份备份、截断任何未结束的尾部，然后逐行流式回放日志，恢复内存中的 `live` 和 `pending` map。日志过大时，压缩会重写一份最小快照：每个 live 会话一条完整记录事件，加上每个待删除项一条 `delete-intent` 事件。

会话保留与注册表变更分开协调。`session-retention-controller.ts` 在 app 启动时于后台启动一轮 `session-retention.ts` 清理——启动流程不等待它，session registry 自身的锁把它与其他会话变更串行化——之后每 6 小时运行一次，`sessionRetentionDays` 热重载时还会经去抖立即重跑。启动时的这一轮在任何已就绪的提供商恢复分派之后开始，排队中的直接恢复会保留其稳定的追踪 id 作为存活保护。协调器会重试待处理的 delete commit，用一次追加为所有过期的空闲会话写入注册表 delete intent，然后按每批 100 个处理：每批用一次追加释放它们的频道绑定与对话，删除它们的文件，再用一次追加提交清理成功的会话。停止控制器会在批次之间中止清理，未提交的删除保持 pending，留待下一轮。它还会清理孤儿 `conversation-history`、清理孤儿 PI transcript bundle、清理不活跃的 Claude capture 日志、清理孤儿 `tmp/tool-images/` 会话目录，并同步 Claude 用户的 `cleanupPeriodDays`。

## 命名约定 {#naming-conventions}

- **执行 ID**：`exec_<kind>_<base36-ts>_<4-rand>`（如 `exec_local_1a2b3c_xyzw`）
- **定时任务 ID**：8 位十六进制字符（来自 `randomBytes(4)`）
- **会话 ID**：UUID 在注册表和 UI 中标识会话。未设置标签的会话显示 UUID 的前 8 个字符。`/resume` 接受完整 UUID 或至少 6 个字符且唯一的前缀。
- **看板 ID**：8 位十六进制字符（来自 `randomBytes(4)`）。看板目录名是其标题的 slug，slug 被占用时加数字后缀；标题中没有可用于 slug 的字符时用 `board-<id>`。
- **Waitpoint ID**：`wp_` 后接 12 位十六进制字符（来自 `randomBytes(6)`）；每个 waitpoint 还带有供 `cortex-signal` 使用的专属 secret。
- **文件格式**：所有 TypeScript 使用 `.ts` 和 ESM 导入风格（`import { X } from './foo.js'`）
