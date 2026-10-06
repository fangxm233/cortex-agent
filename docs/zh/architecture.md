# Cortex 架构 {#cortex-architecture}


Cortex 是一个用于机器人学和 AI/ML 的自主研究智能体系统。它采用服务器-客户端架构运行：**agent-server** 编排工作——对话及其智能体运行、定时任务、聊天平台集成和 MCP 工具——而远程 **agent clients** 通过 WebSocket 连接在远程机器上执行命令。关于这些子系统的深入探讨，参见 [memory.md](./memory.md)、[scheduling.md](./scheduling.md) 和 [mcp.md](./mcp.md)。

## 两个软件包 {#two-packages}

Cortex 由两个 npm 包和一组插件组成：

| 包 | 路径 | 用途 |
|---------|------|---------|
| `@cortex-agent/server` | `agent-server/` | 主服务器：Slack 机器人、LLM 编排、定时任务、MCP 工具。提供四个 CLI 可执行文件：`cortex`、`cortex-hook`、`cortex-evidence-export`、`cortex-signal`。 |
| `@cortex-agent/client` | `client/` | 轻量级远程智能体守护进程。通过 WebSocket 连接，在本地执行 shell/文件命令。 |
| 插件 | `plugins/cortex-*` | 包含技能的插件包。不是 npm 包——在运行时作为目录加载。 |

## Agent-Server 架构：六层结构 {#agent-server-architecture-six-layers}

`agent-server/src/` 中的 agent-server 代码组织为六个严格层次（L0 到 L5）。运行时每层只能从更低编号的层导入；仅类型导入可以跨层。此约束由 `agent-server/.dependency-cruiser.cjs` **在测试时强制执行**——`depcruise` 规则作为 `npm test` 的一部分运行，任何运行时违规都会导致构建失败。

```
L0  core/          → （无运行时依赖）
L1  store/         → core
L2  events/        → core
L3  domain/        → core、store、events
L4  orchestration/ → core、store、events、domain
L5  entry/         → 所有层（组合根）
```

另外两个目录位于层次结构之外，因为它们被多个层导入：

- **`agent-adapter/`** — 两个 LLM 后端的抽象（Claude Code 和 PI）
- **`platform/`** — 消息平台抽象（Slack）

### 第 0 层：`core/` — 共享内核 {#layer-0-core-shared-kernel}

其他各层共同依赖的共享内核：类型、路径常量、设置，以及内存中的运行与会话状态。它不在运行时导入其他层；可以导入它们的类型，hook bus 条目、环境定义这类 core 类型就是这样引用归属别处的结构。

| 文件 | 用途 |
|------|---------|
| `paths.ts` | 规范路径常量：`INSTALL_ROOT`、`DATA_DIR`（`~/.cortex/`）、`CONFIG_DIR`、`STORE_DIR`、`CONTEXT_DIR`、`PROJECTS_DIR`、`WORKSPACE_DIR`、`PLUGINS_DIR`、`PROMPTS_DIR`、`HOOKS_DIR`、`LOGS_DIR` |
| `utils.ts` | 工具函数：`chunkText`、`formatDurationCompact`、`todayISO`、`listProjectDirs`、`readableTimestamp` |
| `async-mutex.ts` | `AsyncMutex` 类——基于 Promise 的互斥锁，用于序列化异步磁盘写入。在整个存储层中使用，防止并发文件损坏 |
| `log.ts` | `createLogger(tag)` — 控制台 + 按日滚动文件输出，保留 14 天 |
| `cli-utils.ts` | `formatHelp`、`formatError`、`readStdinSync`、`cliError` — 共享 CLI 格式化 |
| `status-format.ts` | 纯格式化：`computeElapsed`、`formatMetricsSuffix`、`buildSessionTag`、`buildUserProcessingMessage` |
| `rebuild-progress.ts` | 监督器发布到 `daemon-rebuild.json` 的热重建进度记录：纯步骤状态迁移（`planRebuildProgress`、`startRebuildStep`、`finishRebuildStep`、`settleRebuildProgress`），以及一个永不抛异常的读取 |
| `run-registry.ts` | `RunRegistry` — 活跃运行与后台 hold 的唯一内存索引。回答 `sessionState(sessionId)`，并向 EventBus 发布 `agent.*` 生命周期事件 |
| `types/agent-types.ts` | `AgentResult`、`AgentHandle`、`AgentProgress`、`AskUserQuestionInfo` |
| `types/environment-types.ts` | 执行环境类型：`AgentDefinition`（对应一个 `config/environments/*.json` 文件），以及一次运行所用的解析结果 `ResolvedEnvironment` |
| `config-generator.ts` | 新安装的配置文件初始化 |
| `gateway-generator.ts` | API 网关 YAML 生成 |
| `profile-generator.ts` | 配置 JSON 生成 |

### 第 1 层：`store/` — 持久化 {#layer-1-store-persistence}

所有写操作通过 `AsyncMutex` 序列化以防止并发写入损坏。该层使用两种仓库模式：

- **模式 A（JsonRepository 委托）**：`JsonRepository<T>` 的简单 CRUD 包装器。用于 schedule-repo、session-repo、channel-repo、session-registry-repo、cost-repo。所有写入通过 `atomicWrite()`（写入 `.tmp.<pid>.<ts>` 然后 `fs.rename`）。
- **模式 B（内存 Map + 即发即忘持久化）**：同步内存 `Map` 用于读，异步持久化链用于写。用于 execution-repo，其中读延迟很重要，崩溃时数据陈旧是可接受的。

| 文件 | 用途 |
|------|---------|
| `json-repository.ts` | 通用 `JsonRepository<T>` 基类：`read()`、`write()`、`mutate(fn)`、`flush()`。首次 I/O 时惰性清理孤立的 `.tmp.*` 文件。损坏 JSON 备份机制 |
| `atomic-write.ts` | `atomicWrite(filePath, data)` — 写入 `.tmp.<pid>.<ts>` 然后 `fs.rename` |
| `outbound-queue.ts` | 基于 WAL 的持久化出站消息队列。30 分钟 TTL，200 条目压缩，5 秒排放循环。合并对同一消息的连续更新 |
| `conversation-ledger-repo.ts` | `session-registry-repo.ts` 的外观层——提供相同的每频道轮次 API（`initConversation`、`beginTurn`、`addResponseTs`、`completeTurn`、`rollbackTo`），自身不再持有文件 |
| `session-registry-repo.ts` | 基于 JSONL 的 `cortex-XXXX` 短名称注册表，也是会话记录、频道→会话绑定以及每频道对话头与轮次的唯一所有者。回放仅追加日志（`put`/`patch`/`delete-intent`/`delete-commit`/`bind`/`unbind`/`turn`/`conversation`）、接纳会话，并在日志膨胀后压缩快照 |
| `execution-repo.ts` | 模式 B 仓库。完整 CRUD：`startLocalExecution`、`registerDispatchExecution`、`completeExecution`、`failExecution`。通过 `reconcileStaleDispatches` 进行异步陈旧检测 |
| `channel-repo.ts` | `projectName → channelId` 映射 |
| `project-dir-repo.ts` | `projectName → machineName → dirPath` 带反向频道查找 |
| `schedule-repo.ts` | 调度持久化。`ScheduleTask` 接口，`ScheduleTarget` 联合类型 |
| `cost-repo.ts` | JSONL 格式费用（仅追加），JSON 格式预算。启动时 90 天修剪 |
| `profile-repo.ts` | 混合同步/异步读取器。`startProfileWatcher()` 用于热重载 |

### 第 2 层：`events/` — 事件总线 {#layer-2-events-event-bus}

同步、类型安全的事件总线，带 JSONL 日志。

| 文件 | 用途 |
|------|---------|
| `event-types.ts` | `CortexEvent` 可区分联合：用户事件加两个元事件（`event-bus.handler-failed`、`event-logger.dropped`）。类别：message/interaction、agent lifecycle、session、system |
| `event-bus.ts` | `EventBus` 类 — `subscribe(type, handler)` / `publish(event)`。同步扇出。异步处理器即发即忘。`event-bus.handler-failed` 的重入保护。SIGTERM 排放的关闭钩子 |
| `event-logger.ts` | 订阅 `'*'`，1024 条环形缓冲区，100ms 刷新间隔，按日滚动 JSONL，14 天保留。由 [`config/settings.json`](./configuration.md#configsettingsjson) 中的 `eventLog` 设置控制（设为 `false` 即关闭；旧变量 `CORTEX_EVENT_LOG=off` 仍作为已弃用的回退可用） |

**事件类别：**

- **Message/interaction**：`session.message`、`plan.submitted`、`plan.approved`、`ask-user.requested`、`ask-user.answered`
- **Agent lifecycle**：`agent.started`、`agent.completed`、`agent.failed`、`agent.superseded`
- **System**：`system.notice`、`config.changed`、`llm.active-count-delta`、`scheduler.tick`、`rate-limit.changed`

### 第 3 层：`domain/` — 业务逻辑 {#layer-3-domain-business-logic}

最厚的层。每个领域关注点一个子目录；下表覆盖其中主要的几个。

| 子目录 | 用途 |
|-------------|---------|
| `agents/` | profile、执行环境（`agents/environments/`）、子代理角色与凭据：一次运行可以被配置成什么。启动运行属于 `runs/` |
| `runs/` | 运行层：`startRun` 与 `AgentRun` 所有权对象、`RunRequest` 的 profile/spec/提示解析、后端中立的 `RunEvent` 事件流，以及 `SessionEngines` 池 |
| `sessions/` | 会话生命周期。钩子管道（onNew、onMessageEnd），带 VirtualMessage 显示和可选的智能体注入 |
| `executions/` | `store/execution-repo.ts` 的薄重导出 |
| `costs/` | 费用追踪、网关管理、按提供商感知的速率限制 |
| `scheduling/` | 持久化调度引擎与 settings-backed 内置作业控制器。`Scheduler` 热重载用户调度，每次触发都新开一个会话；记忆索引重建等内置作业拥有 daemon 计时器 |
| `memory/` | 内存/索引管理。`memory-index-regen.ts` 从 YAML frontmatter 重建 index.md。上下文更改的文件监视器。AGENTS.md 扫描和注入 |
| `monitor/` | GPU 和磁盘资源监控 |
| `system/` | 主机层面的事务：doctor 检查、更新状态与提示、系统通知及其历史，以及 `rebuild-hold.ts` —— 由监督器下推、供准入判断读取的"拒绝新 turn"状态 |
| `remote/` | 通过 WebSocket 的远程设备管理。基于 SSH 的客户端部署，通过 npm update 的热重载 |
| `mcp/` | 内置的 Cortex MCP 服务器及其工具模块（参见 [mcp.md](./mcp.md)） |

### 第 4 层：`orchestration/` — 消息路由和执行 {#layer-4-orchestration-message-routing-and-execution}

将平台消息连接到领域逻辑。hook-bridge（本层的一部分）详见 [hooks.md](./hooks.md)。

| 文件 | 用途 |
|------|---------|
| `channel-queue.ts` | 每频道串行 Promise 队列。确保每个频道一次只能运行一个智能体 |
| `orchestrator.ts` | 把每条入站消息交给 `AgentRunner` |
| `agent-runner.ts` | 默认智能体路径的准入：路由、轮中注入、排队，以及一个回合所需的会话、租约与浏览器解析。回合本体属于 `turn/turn.ts` |
| `resume-dispatcher.ts` | 限流恢复队列：窗口重置后继续被用量限制中断的会话 |
| `busy-tracker.ts` | 追踪活跃 LLM 数量，向父守护进程发送 IPC `busy`/`idle` |
| `lifecycle.ts` | 智能体成功/错误处理、编辑重试、AskUserQuestion 恢复、轮次追踪 |
| `superseded-edits.ts` | 消息编辑废弃标记 |
| `routing/message-router.ts` | Slack 消息入口点。标准化技能命令并委托给 orchestrator |
| `routing/commands/` | `!command` 处理器：`cancel`、`channel`、`compact`、`cost`、`device`、`lang`、`login`、`mode`、`nvtop`、`orient`、`restart`、`schedule`、`sendfile`、`session`、`status`、`tail`、`usage` |
| `routing/hook-bridge.ts` | PreToolUse 钩子 → EventBus 桥接。发布 `plan.submitted` 和 `ask-user.requested` |
| `routing/hook-bridge-subscribers.ts` | 创建 Slack 模态框用于问题、将计划发送到 Slack 的订阅者 |
| `interactions/` | AskUserQuestion 模态流程、计划审批状态机、按钮/模态动作路由 |

### 第 5 层：`entry/` — 组合根 {#layer-5-entry-composition-root}

| 文件 | 用途 |
|------|---------|
| `app.ts` | **组合根**。连接 EventBus → logger → hook-bridge → RunRegistry → adapters → commands → interactions → scheduler → remote clients → webhook → memory watcher。处理 SIGTERM 优雅关闭 |
| `daemon.ts` | 进程监督器。Fork `app.js`，监视 `src/*.ts` 以自动重建（当 `CORTEX_REPO` 设置时），监视 `.restart` 触发文件，带指数退避的崩溃恢复（1s→30s 最大）。发布逐步骤的重建进度，在 install/restart 之前等 app 空闲，并在这个窗口内拒绝新 turn（见下文） |
| `daemon-notice.ts` | 下行 IPC 的 app 侧：把 `rebuild-aborted` 变成系统通知、把 `rebuild-hold` 变成准入侧的 hold，并在监督器断开连接时解除 hold |
| `cli.ts` | `cortex` CLI 入口点。调度到：`init`、`start`、`daemon`、`restart`、`tui`、`config`、`setup-gateway` |
| `init.ts` | 交互式首次初始化 |
| `startup-helpers.ts` | 清理日志、确保 MCP 配置 |
| `startup-notify.ts` | 向管理频道发送启动私信 |
| `platform-connect.ts` | 启动各平台适配器。TUI 网关绑定完成后启动流程才继续；Slack 和飞书在后台连接，启动不等待网络握手（发出的消息走它们的 HTTP API，不依赖长连接）。连接失败会在 5 秒、30 秒、2 分钟后重试，仍失败则发出错误级系统通知；60 秒后仍在连接则发出警告通知 |

### 热重建：发布进度与 turn hold {#hot-rebuild-published-progress-and-the-turn-hold}

设置了 `CORTEX_REPO` 之后，一次源码改动会让监督器重新构建各软件包、重新安装自身，并替换掉 app
进程。构建分三条并发的 lane 进行。其中一条是有序的链 —— 先 `server`，再 `ui-contract`，最后
`web-typecheck` —— 因为 ui-contract 重新导出 server 构建出的类型，而 web 的类型检查依赖 ui-contract
的构建产物。另外两条 `web-bundle` 和 `web-depcruise` 只读 web 源码，一开始就与它并行。每条 lane 都会
跑完，任何一步失败都会在安装之前终止这次重建，并发出一条点名所有失败步骤的通知。有两个机制让重建
既可见又安全。

**进度写在文件里，不在内存里。** 流水线在第一步之前就把完整计划写入
`$STORE_DIR/daemon-rebuild.json` —— 这个 checkout 实际会跑的步骤（上述构建步骤，随后是 `install`
和 `restart`）、当前正在跑哪些步骤、每一步如何结束（`done`、`failed`、`skipped`），
其中 `install` 步骤还记录它走的是快速 staged-rename 路径还是 `npm pack` + `npm install -g`。只能用
文件：流水线的最后一个动作就是替换掉那个本该保存这份状态的进程，所以内存里的任何东西都无法告诉新的
`app.js`，把它带到世上的那次重建做了什么。`system.daemonStatus` 读取这条记录、daemon 页面渲染它，
重建进行中时每秒轮询一次。`daemonPid` 不属于当前存活监督器的 `running` 记录会被丢弃，而不是永远
显示下去；终态记录则会保留，这样"上次重建在 `web-typecheck` 失败"在重启之后依然读得到。终态有三种：
`succeeded`、`aborted`、`deferred`。

**流水线里危险的那一半会等 app 空闲。** 构建步骤只读仓库、写 `dist/`；而 `install` 会覆盖运行中
`app.js` 加载的那些文件，`restart` 直接杀掉它。所以 busy/idle 会检查两次：构建之前一次，构建之后
再一次 —— 构建长达数分钟，这期间完全可能有 turn 正当地开始了。第二道门发现子进程 busy 时，会把触发
原因存进 `pendingRebuild`、把记录发布为 `deferred`，等下一次 idle 转换再从头跑一遍整条流水线 ——
等真实工作做完，而不是拒绝它，因为被拒绝的 turn 并不等于被延迟的 turn（waitpoint 唤醒或后台 agent
的结果会直接丢失）。

**只在进程被替换的那几秒里不开新 turn。** 进入 `install` 或 `restart`（以及有排队中的重启）时，
监督器会通过 fork IPC 下发 `rebuild-hold`，准入侧（`agent-runner.ts`）会在
tracking、入队、turn 中注入之前就拒绝：此刻启动的 turn 会被片刻之后的 SIGTERM 变成孤儿，它拉起的
后端 CLI 还在往没人读的管道里写。覆盖范围是刻意收窄的 —— 绝不包含构建阶段 —— 所以它能拦到的只有
落在"idle 检查与 SIGTERM 之间那一个 tick"里的消息。人如果正在打字，会在原频道收到一条说明当前阶段的
回复；而没人在等的 callback 或系统消息，则会变成一条 warning 级系统通知，点明被丢掉的是什么。hold
带一个五分钟租约，由每条阶段消息续期，因此中途死掉的监督器不会把 app 永久静音；IPC `disconnect`
则会立即解除它。

## LLM 后端适配器 {#llm-backend-adapter}

`agent-adapter/` 目录在统一接口后抽象两个 LLM 后端：

| 后端 | 适配器 | 备注 |
|---------|---------|-------|
| Claude Code | `claude/adapter.ts` | 无状态引擎适配器：打开一个 Claude 进程会话（print 模式）、spawn-args 构建器、事件解析器。TUI 模式（tmux + JSONL tail）已废弃（D9） |
| PI | `pi/adapter.ts` | 无状态引擎适配器：打开一个进程内 PI 会话、MCP 桥接、钩子桥接、工具填充 |

会话池位于 `domain/runs/engines.ts`（`SessionEngines`），不在任何一个适配器里。

标准化层（`normalize/`）将后端特定事件转换为统一的 `NormalizedEvent` 流。`capabilities.ts` 文件声明 Claude 和 PI 的 `Capability` 能力集。

## 平台适配器 {#platform-adapter}

`platform/` 目录在 `PlatformAdapter` 接口后抽象 Slack：

| 方法 | 用途 |
|--------|---------|
| `start` / `stop` | 生命周期 |
| `onMessage` / `onMessageEdit` / `onAction` / `onModalSubmit` | 事件注册 |
| `postMessage` / `updateMessage` / `deleteMessage` | 出站消息 |
| `postInteractive` | 带按钮的交互式消息 |
| `openModal` | 模态框 |
| `uploadFile` / `downloadFile` | 文件操作 |
| `addReaction` | 表情反应 |
| `getPermalink` / `getAdminChannel` | 工具 |

`VirtualMessage` 处理消息聚合——将多次追加合并为更少的消息，并带有重试延迟以避免速率限制。

## WebSocket 协议（服务器 ↔ 客户端） {#websocket-protocol-server-client}

WebSocket 协议用于**远程设备命令执行**，不用于 Slack/智能体通信。服务器通过 `startClientManager()` 运行 WebSocket 服务器（默认端口 3002）。完整的跨机器方案——部署、网络拓扑和安全——参见 [cross-machine.md](./cross-machine.md)。

### 消息流 {#message-flow}

1. **客户端连接** → 发送 `{ type: 'hello', device, platform, capabilities }`
2. **服务器验证** → 检查重复设备名称（如果重复，错误代码 `4002`）
3. **心跳** → 客户端每 5 秒发送 `{ type: 'heartbeat', device, timestamp }`。服务器在 15 秒静默后标记设备离线（代码 `4003`）
4. **命令分发** → 服务器发送 `{ type: 'command', commandId, action, params }`。客户端执行并以 `{ type: 'result', commandId, success, data, error }` 回复

### 命令动作 {#command-actions}

客户端支持这些远程动作：`bash`（带超时/后台的 shell 执行）、`read`（支持文本/图像/PDF 的文件读取）、`write`（带 CRLF 检测的文件写入）、`edit`（带 replace_all 的文本替换）、`glob`（带 VCS 排除的文件 glob）、`grep`（带分页的 ripgrep）、`file.stat`（传输前的元数据探测）。

### 客户端架构 {#client-architecture}

客户端（`client/src/client.ts`）是一个轻量级的 WebSocket 守护进程，维护持久连接。它支持带指数退避的自动重连（1s→30s 最大）。它不启动也不托管长任务：那类工作独立运行，并通过 [waitpoint](./waitpoints.md) 回报。

## 事件总线拓扑 {#event-bus-topology}

EventBus 通过单例-注入模式在 `app.ts` 中连接。组件在构造时没有依赖，然后通过 `setBus(bus)` 连接：

| 组件 | 发布 | 订阅 |
|-----------|-----------|------------|
| `runRegistry` | `agent.started/completed/failed/superseded` | — |
| `eventLogger` | `event-logger.dropped` | `'*'`（所有事件 → JSONL） |
| `planApprovals` | `plan.approved` | `plan.submitted` |
| `busyTracker` | — | `llm.active-count-delta` |
| `interactionHandlers` | `ask-user.answered` | `ask-user.requested` |
| `hookBridge` | `plan.submitted`、`ask-user.requested` | — |

## 状态存储 {#state-storage}

Cortex 将所有状态存储在 `~/.cortex/` 下的文件系统中。没有数据库——所有内容都落在磁盘上的 JSON 或 JSONL 文件里，其中 session registry 和 history 路径明确采用 append-oriented 设计。

| 路径 | 用途 |
|------|---------|
| `agent-state.json` | 选定的 profile、默认智能体与频道级 override（由 `mode.json` 一次性迁移而来） |
| `profiles.json` | 命名智能体配置列表 |
| `schedules.json` | 持久化定时任务列表 |
| `session-registry.jsonl` | 仅追加的 JSONL 日志，也是会话记录、频道→会话绑定以及每频道对话头与轮次的唯一所有者。事件：`put`/`patch`/`delete-intent`/`delete-commit`/`bind`/`unbind`/`turn`/`conversation`；启动时通过流式回放重建 live/pending 状态。压缩保留 live 记录 + 绑定 + live 轮次；当日志事件数超过 `max(512, live×4, 2×compacted)`（`compacted` 为一次压缩会写出的事件数），或文件同时超过 16 MB 与上次压缩后大小的两倍时触发。替代已退役的 `sessions.json` 与 `conversation-ledger.json`——一次性升级迁移会把它们重命名为 `*.pre-2026.9.14.bak` |
| `retention-candidates.json` | history 与 PI 清理用的两轮确认孤儿候选表 |
| `conversation-history/` | 以稳定 Cortex session id 为键的分会话 transcript/history JSONL |
| `executions.json` | 统一执行注册表 |
| `daemon-rebuild.json` | 监督器发布的热重建记录：计划、逐步骤状态与耗时，以及上次重建的终态结果 |
| `config/environments/` | 执行环境——每个环境一个 JSON 文件 |
| `costs.jsonl` | 每次调用的费用记录（90 天滚动） |
| `logs/sessions/` | 保留保护/清理使用的 Claude capture 日志 |
| `logs/sessions-pi/` | 以 backend session id 归组的 PI transcript bundle |
| `logs/` | 守护进程和后端日志 |

session registry 不再是一个可变的单 JSON blob。`session-registry-journal.ts` 维护一个仅追加 JSONL 文件：`put` 和 `delete-intent` 事件都携带完整 session record，最后再以 `delete-commit` 完成删除。delete intent 还会固化通过校验的 Claude turn-backup 清理 manifest，因此部分清理已经删除 ledger 后，下一轮重试仍然保有完整清理信息。启动时会先把遗留的 `session-registry.json` 迁移成 journal、为旧文件写备份、截断任何未结束的尾行，然后按行流式回放 journal，恢复内存中的 `live` 和 `pending` map。日志过大时，compaction 会重写最小快照：每个 live session 一条完整记录事件，每个 pending deletion 一条 `delete-intent` 事件。

session retention 与 registry mutation 分开协调。`session-retention-controller.ts` 在 app 启动时于后台启动一轮 `session-retention.ts` 清理——启动流程不等待它，session registry 自身的锁把它与其他 session 变更串行化——之后每 6 小时运行一次；`sessionRetentionDays` 热重载后还会经去抖立即再跑一轮。启动时的这一轮在已经 ready 的 provider resume dispatch 之后开始，排队中的 direct resume 也会保留 stable tracking id 作为 liveness guard。这个协调器会重试 pending delete commit，用一次追加为所有过期空闲 session 写入 registry delete intent，再按每批 100 个处理：各用一次追加释放它们的频道 binding 与 conversation，删除它们的文件，再用一次追加提交清理成功的 session。停止协调器会在批次之间中止清理，未提交的删除保持 pending，留给下一轮。它还会清理孤儿 `conversation-history`、清理孤儿 PI transcript bundle、清理非活跃 Claude capture 日志、清理 `tmp/tool-images/` 下的孤儿会话目录，并同步 Claude 用户 `cleanupPeriodDays`。

## 命名约定 {#naming-conventions}

- **执行 ID**：`exec_<kind>_<base36-timestamp>_<4 位随机字符>`（如 `exec_local_1a2b3c_xyzw`）
- **定时任务 ID**：8 位十六进制字符（来自 `randomBytes(4)`）
- **会话名称**：`cortex-<6 位十六进制字符>`（如 `cortex-a1b2c3`）
- **文件格式**：所有 TypeScript 使用 `.ts` 扩展名和 ESM 导入风格（`import { X } from './foo.js'`）
