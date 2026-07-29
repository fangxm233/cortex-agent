# Cortex 架构


Cortex 是一个用于机器人学和 AI/ML 的自主研究智能体系统。它采用服务器-客户端架构运行：**agent-server** 编排工作——任务调度、线程执行、定时任务、Slack 集成和 MCP 工具——而远程 **agent clients** 通过 WebSocket 连接在远程机器上执行命令。关于这些子系统的深入探讨，参见 [threads.md](./threads.md)、[tasks.md](./tasks.md) 和 [memory.md](./memory.md)。

## 两个软件包

Cortex 由两个 npm 包和一组插件组成：

| 包 | 路径 | 用途 |
|---------|------|---------|
| `@cortex-agent/server` | `agent-server/` | 主服务器：Slack 机器人、LLM 编排、定时任务、任务系统、MCP 工具。提供三个 CLI 可执行文件：`cortex`、`cortex-task`、`cortex-run`。 |
| `@cortex-agent/client` | `client/` | 轻量级远程智能体守护进程。通过 WebSocket 连接，在本地执行 shell/文件命令，支持用于长时间运行任务执行的 `cortex-run`。 |
| 插件 | `plugins/cortex-*` | 8 个角色限定的插件包，包含技能。不是 npm 包——在运行时作为目录加载。 |

## Agent-Server 架构：六层结构

`agent-server/src/` 中的 agent-server 代码组织为六个严格层次（L0 到 L5）。每层只能从更低编号的层导入。此约束由 `agent-server/.dependency-cruiser.cjs` **在测试时强制执行**——`depcruise` 规则作为 `npm test` 的一部分运行，任何违规都会导致构建失败。

```
L0  core/          → （无依赖）
L1  store/         → core
L2  events/        → core
L3  domain/        → core、store、events
L4  orchestration/ → core、store、events、domain
L5  entry/         → 所有层（组合根）
```

另外两个目录位于层次结构之外，因为它们被多个层导入：

- **`agent-adapter/`** — 两个 LLM 后端的抽象（Claude Code 和 PI）
- **`platform/`** — 消息平台抽象（Slack）

### 第 0 层：`core/` — 零依赖基础

基础层。仅包含纯 TypeScript，不依赖其他层的运行时。

| 文件 | 用途 |
|------|---------|
| `paths.ts` | 规范路径常量：`INSTALL_ROOT`、`DATA_DIR`（`~/.cortex/`）、`CONFIG_DIR`、`STORE_DIR`、`CONTEXT_DIR`、`PROJECTS_DIR`、`WORKSPACE_DIR`、`PLUGINS_DIR`、`PROMPTS_DIR`、`HOOKS_DIR`、`LOGS_DIR` |
| `utils.ts` | 重新导出路径常量及工具函数：`chunkText`、`formatDurationCompact`、`todayISO`、`listProjectDirs`、`readableTimestamp` |
| `async-mutex.ts` | `AsyncMutex` 类——基于 Promise 的互斥锁，用于序列化异步磁盘写入。在整个存储层中使用，防止并发文件损坏 |
| `log.ts` | `createLogger(tag)` — 控制台 + 按日滚动文件输出，保留 14 天 |
| `cli-utils.ts` | `formatHelp`、`formatError`、`readStdinSync`、`cliError` — 共享 CLI 格式化 |
| `status-format.ts` | 纯格式化：`computeElapsed`、`formatMetricsSuffix`、`buildSessionTag`、`buildUserProcessingMessage` |
| `task-parser.ts` | 任务接口定义，带 kebab↔snake_case 键映射的 YAML 解析/序列化，`scanAllTasks`、`scanAvailableTasks`、`filterTasks`、`getTaskStats` |
| `running-executions.ts` | `RunningExecutions` 单例，带三索引注册表（byKey、byThreadId、byExecutionId）。向 EventBus 发布 `agent.*` 生命周期事件 |
| `types/agent-types.ts` | `AgentResult`、`AgentHandle`、`AgentProgress`、`AskUserQuestionInfo` |
| `types/thread-types.ts` | 完整线程类型系列：`ThreadRecord`、`AgentDefinition`、`ThreadTemplate`、`TransitionRule`、`HookConfig`、`RunThreadOptions`、`AgentStep` 等 |
| `config-generator.ts` | 新安装的配置文件初始化 |
| `gateway-generator.ts` | API 网关 YAML 生成 |
| `profile-generator.ts` | 配置 JSON 生成 |

### 第 1 层：`store/` — 持久化

所有写操作通过 `AsyncMutex` 序列化以防止并发写入损坏。该层使用两种仓库模式：

- **模式 A（JsonRepository 委托）**：`JsonRepository<T>` 的简单 CRUD 包装器。用于 schedule-repo、session-repo、channel-repo、session-registry-repo、cost-repo。所有写入通过 `atomicWrite()`（写入 `.tmp.<pid>.<ts>` 然后 `fs.rename`）。
- **模式 B（内存 Map + 即发即忘持久化）**：同步内存 `Map` 用于读，异步持久化链用于写。用于 execution-repo 和 thread-repo，其中读延迟很重要，崩溃时数据陈旧是可接受的。

| 文件 | 用途 |
|------|---------|
| `json-repository.ts` | 通用 `JsonRepository<T>` 基类：`read()`、`write()`、`mutate(fn)`、`flush()`。首次 I/O 时惰性清理孤立的 `.tmp.*` 文件。损坏 JSON 备份机制 |
| `in-memory-repository.ts` | `InMemoryRepository<T>` — 测试替身，接口相同，无磁盘 I/O |
| `atomic-write.ts` | `atomicWrite(filePath, data)` — 写入 `.tmp.<pid>.<ts>` 然后 `fs.rename` |
| `outbound-queue.ts` | 基于 WAL 的持久化出站消息队列。30 分钟 TTL，200 条目压缩，5 秒排放循环。合并对同一消息的连续更新 |
| `thread-repo.ts` | `ThreadRepo` — 内存 `Map<string, ThreadRecord>` + 异步持久化。查询：`findByChannel`、`findActive`、`findByPlatformThread`。启动恢复：`markRunningAsFailedOnStartup`。清理：7 天前的线程（auto-records 为 24 小时） |
| `session-repo.ts` | `SessionRepo` — `Record<string, string>` 映射 `backend:channel → sessionId` |
| `conversation-ledger-repo.ts` | 每频道轮次追踪：`initConversation`、`beginTurn`、`addResponseTs`、`completeTurn`、`rollbackTo` |
| `session-registry-repo.ts` | `cortex-XXXX` 短名称注册表。`generateSessionName`、`registerSession`、`lookupSession` |
| `execution-repo.ts` | 模式 B 仓库。完整 CRUD：`startLocalExecution`、`registerDispatchExecution`、`completeExecution`、`failExecution`。通过 `reconcileStaleDispatches` 进行异步陈旧检测 |
| `channel-repo.ts` | `projectName → channelId` 映射 |
| `project-dir-repo.ts` | `projectName → machineName → dirPath` 带反向频道查找 |
| `schedule-repo.ts` | 调度持久化。`ScheduleTask` 接口，`ScheduleTarget` 联合类型 |
| `cost-repo.ts` | JSONL 格式费用（仅追加），JSON 格式预算。启动时 90 天修剪 |
| `profile-repo.ts` | 混合同步/异步读取器。`startProfileWatcher()` 用于热重载 |
| `task-repo.ts` | 读取 TASKS.yaml 文件。纯 I/O + 互斥锁 + git 同步（`commitAndPush`）。修改操作在 `domain/tasks/mutator.ts` 中 |

### 第 2 层：`events/` — 事件总线

同步、类型安全的事件总线，带 JSONL 日志。

| 文件 | 用途 |
|------|---------|
| `event-types.ts` | 22 个用户事件类型 + 2 个元事件，在 `CortexEvent` 可区分联合中。类别：message/interaction、agent lifecycle、thread lifecycle、task、system |
| `event-bus.ts` | `EventBus` 类 — `subscribe(type, handler)` / `publish(event)`。同步扇出。异步处理器即发即忘。`event-bus.handler-failed` 的重入保护。SIGTERM 排放的关闭钩子 |
| `event-logger.ts` | 订阅 `'*'`，1024 条环形缓冲区，100ms 刷新间隔，按日滚动 JSONL，14 天保留。由 `CORTEX_EVENT_LOG=off` 控制 |
| `event-replay.ts` | 调试 CLI：`node events/event-replay.ts --date YYYY-MM-DD [--type xxx]` |

**事件类别：**

- **Message/interaction**：`message.received`、`message.edited`、`plan.submitted`、`plan.approved`、`ask-user.requested`、`ask-user.answered`
- **Agent lifecycle**：`agent.started`、`agent.completed`、`agent.failed`、`agent.superseded`
- **Thread lifecycle**：`thread.created`、`thread.step.started`、`thread.step.finished`、`thread.transitioned`、`thread.completed`、`thread.failed`
- **Task**：`task.claimed`、`task.completed`、`task.dispatched`
- **System**：`llm.active-count-delta`、`scheduler.tick`、`rate-limit.breach`

### 第 3 层：`domain/` — 业务逻辑

最厚的层。包含 14 个子目录，每个封装一个领域关注点。

| 子目录 | 用途 |
|-------------|---------|
| `agents/` | 智能体执行门面。`runAgent()` 委托给后端适配器。配置解析、后端检测 |
| `sessions/` | 会话生命周期。钩子管道（onNew、onMessageEnd），带 VirtualMessage 显示和可选的智能体注入 |
| `tasks/` | 完整任务系统：YAML 解析、调度、归档、等待追踪、锁管理、CLI（`cortex-task`）、验证 |
| `executions/` | `store/execution-repo.ts` 的薄重导出，带锁释放副作用：每个终止转换自动释放任务锁 |
| `costs/` | 费用追踪、网关管理、按提供商感知的速率限制 |
| `scheduling/` | 调度任务引擎。`Scheduler` 类，带通过 `fs.watch` 的热重载、pre-check 门控、运行前守卫。4 个作业运行器：`scheduled-task`、`task-dispatch`、`memory-index-regen`、`task-archive` |
| `memory/` | 内存/索引管理。`memory-index-regen.ts` 从 YAML frontmatter 重建 index.md。上下文更改的文件监视器。CORTEX.md 扫描和注入 |
| `monitor/` | GPU 和磁盘资源监控 |
| `remote/` | 通过 WebSocket 的远程设备管理。基于 SSH 的客户端部署，通过 npm update 的热重载 |
| `threads/` | 完整线程系统：状态机、运行器、模板加载、提示构建、钩子执行、产物 I/O、auto-thread 逻辑 |
| `mcp/` | MCP 服务器实现。16 个 Cortex MCP 工具，分布在 8 个工具模块中（参见 [mcp.md](./mcp.md)） |

### 第 4 层：`orchestration/` — 消息路由和执行

将平台消息连接到领域逻辑。hook-bridge（本层的一部分）详见 [hooks.md](./hooks.md)。

| 文件 | 用途 |
|------|---------|
| `channel-queue.ts` | 每频道串行 Promise 队列。确保每个频道一次只能运行一个智能体 |
| `orchestrator.ts` | 两分支决策树：如果是 `!thread` 命令 → `ThreadExecutor`，否则 → `AgentRunner`（默认单智能体路径） |
| `agent-runner.ts` | 默认智能体执行路径。在执行前创建 `default` 线程，运行它，管理流式和交互式回调 |
| `thread-executor.ts` | 线程路由：处理 `!thread start`、`!thread add`、线程继续、运行步骤期间的用户消息缓冲 |
| `busy-tracker.ts` | 追踪活跃 LLM 数量，向父守护进程发送 IPC `busy`/`idle` |
| `lifecycle.ts` | 智能体成功/错误处理、编辑重试、AskUserQuestion 恢复、轮次追踪 |
| `superseded-edits.ts` | 消息编辑废弃标记 |
| `dispatch-reconciler.ts` | 陈旧调度清理的后台定时器 |
| `routing/message-router.ts` | Slack 消息入口点。解析 `!thread` 命令，标准化技能命令，委托给 orchestrator |
| `routing/commands/` | 14 个 `!command` 处理器：`cancel`、`channel`、`cost`、`device`、`dispatch`、`mode`、`nvtop`、`orient`、`schedule`、`sendfile`、`session`、`status`、`tail`、`task`、`thread` |
| `routing/hook-bridge.ts` | PreToolUse 钩子 → EventBus 桥接。发布 `plan.submitted` 和 `ask-user.requested` |
| `routing/hook-bridge-subscribers.ts` | 创建 Slack 模态框用于问题、将计划发送到 Slack 的订阅者 |
| `interactions/` | AskUserQuestion 模态流程、计划审批状态机、按钮/模态动作路由 |

### 第 5 层：`entry/` — 组合根

| 文件 | 用途 |
|------|---------|
| `app.ts` | **组合根**。连接 EventBus → logger → hook-bridge → runningExecutions → adapters → commands → interactions → scheduler → remote clients → webhook → memory watcher。处理 SIGTERM 优雅关闭 |
| `daemon.ts` | 进程监督器。Fork `app.js`，监视 `src/*.ts` 以自动重建（当 `CORTEX_REPO` 设置时），监视 `.restart` 触发文件，带指数退避的崩溃恢复（1s→30s 最大） |
| `cli.ts` | `cortex` CLI 入口点。调度到：`init`、`start`、`daemon`、`restart`、`task`、`config`、`setup-gateway` |
| `init.ts` | 交互式首次初始化 |
| `startup-helpers.ts` | 清理日志、确保 MCP 配置 |
| `startup-notify.ts` | 向管理频道发送启动私信 |

## LLM 后端适配器

`agent-adapter/` 目录在统一接口后抽象两个 LLM 后端：

| 后端 | 适配器 | 备注 |
|---------|---------|-------|
| Claude Code | `claude/adapter.ts` | 会话池、`stream-json` 模式、TUI 模式（tmux + JSONL tail）。spawn-args 构建器、事件解析器 |
| PI | `pi/adapter.ts` | PISession、MCP 桥接、钩子桥接、工具填充 |

标准化层（`normalize/`）将后端特定事件转换为统一的 `NormalizedEvent` 流。`capabilities.ts` 文件声明 Claude 和 PI 的 `Capability` 能力集。

## 平台适配器

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

## WebSocket 协议（服务器 ↔ 客户端）

WebSocket 协议用于**远程设备命令执行**，不用于 Slack/智能体通信。服务器通过 `startClientManager()` 运行 WebSocket 服务器（默认端口 3002）。完整的跨机器方案——部署、网络拓扑和安全——参见 [cross-machine.md](./cross-machine.md)。

### 消息流

1. **客户端连接** → 发送 `{ type: 'hello', device, platform, capabilities }`
2. **服务器验证** → 检查重复设备名称（如果重复，错误代码 `4002`）
3. **心跳** → 客户端每 5 秒发送 `{ type: 'heartbeat', device, timestamp }`。服务器在 15 秒静默后标记设备离线（代码 `4003`）
4. **命令分发** → 服务器发送 `{ type: 'command', commandId, action, params }`。客户端执行并以 `{ type: 'result', commandId, success, data, error }` 回复

### 命令动作

客户端支持这些远程动作：`bash`（带超时/后台的 shell 执行）、`read`（支持文本/图像/PDF 的文件读取）、`write`（带 CRLF 检测的文件写入）、`edit`（带 replace_all 的文本替换）、`glob`（带 VCS 排除的文件 glob）、`grep`（带分页的 ripgrep）、`cortex-run.launch`、`cortex-run.cancel`。

### 客户端架构

客户端（`client/src/client.ts`）是一个轻量级的 WebSocket 守护进程，维护持久连接。它支持带指数退避的自动重连（1s→30s 最大）。`cortex-run-watcher.ts` 实现客户端驻留的长时间运行任务看门狗，具有两层停滞检测（输出停滞和进度停滞）以及通过 `nvidia-smi` 的 GPU 自动检测。

## 事件总线拓扑

EventBus 通过单例-注入模式在 `app.ts` 中连接。组件在构造时没有依赖，然后通过 `setBus(bus)` 连接：

| 组件 | 发布 | 订阅 |
|-----------|-----------|------------|
| `runningExecutions` | `agent.started/completed/failed/superseded` | — |
| `eventLogger` | `event-logger.dropped` | `'*'`（所有事件 → JSONL） |
| `planApprovals` | `plan.approved` | `plan.submitted` |
| `busyTracker` | — | `llm.active-count-delta` |
| `interactionHandlers` | `ask-user.answered` | `ask-user.requested` |
| `hookBridge` | `plan.submitted`、`ask-user.requested` | — |

## 状态存储

Cortex 将所有状态存储在 `~/.cortex/` 下的文件系统中。没有数据库——所有内容都是带原子写入（`tmp + rename`）的 JSON 文件。

| 路径 | 用途 |
|------|---------|
| `mode.json` | 当前运行时模式和配置 |
| `profiles.json` | 命名智能体配置列表 |
| `schedules.json` | 持久化调度任务列表 |
| `sessions.json` | 频道到智能体会话的映射 |
| `executions.json` | 统一执行注册表 |
| `config/thread-templates/` | 智能体定义和编排模板——`agents/`、`templates/`、`shells/` 下每个实体一个 JSON 文件 |
| `threads.json` | 活跃和历史线程状态 |
| `tasks/` | 项目任务队列（每项目 TASKS.yaml） |
| `costs.jsonl` | 每次调用的费用记录（90 天滚动） |
| `logs/` | 守护进程和 LLM 日志 |

## 命名约定

- **线程 ID**：`thr_<8 位十六进制字符>`（如 `thr_a1b2c3d4`）
- **执行 ID**：`exec_<kind>_<base36-timestamp>_<4 位随机字符>`（如 `exec_local_1a2b3c_xyzw`）
- **调度任务 ID**：8 位十六进制字符（来自 `randomBytes(4)`）
- **会话名称**：`cortex-<6 位十六进制字符>`（如 `cortex-a1b2c3`）
- **任务 ID**：4 位十六进制字符（如 `f7cf`）
- **文件格式**：所有 TypeScript 使用 `.ts` 扩展名和 ESM 导入风格（`import { X } from './foo.js'`）
