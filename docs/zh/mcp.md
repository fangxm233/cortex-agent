# MCP — Model Context Protocol


Cortex 内置按权限面和平台面拆分的 MCP（Model Context Protocol）服务器，赋予智能体访问远程机器、任务监控、线程控制、调度、费用和平台集成的能力。本文档解释每个服务器提供什么、如何组合以及如何添加第三方 MCP 服务器。

## 什么是 MCP {#what-mcp-is}

MCP 是一个开放协议，允许 LLM 应用通过标准化的 JSON-RPC 接口（基于 stdio 或 HTTP）向智能体暴露工具。Cortex 使用 MCP 在智能体进程（无法直接访问 agent-server 内部）和服务器能力之间架起桥梁。MCP 支持因后端而异——功能矩阵参见 [backends.md](./backends.md)。

Claude Code 从 JSON 文件读取 MCP 服务器配置，并将每个服务器作为子进程生成。智能体可以像内置工具（Bash、Read、Edit 等）一样调用 MCP 工具，工具名称以 `mcp__<server-name>__` 为前缀。

## 为什么 Cortex 内置自己的 MCP 服务器 {#why-cortex-ships-its-own-mcp-servers}

Cortex 的 agent-server 维护智能体进程无法直接访问的状态：到远程机器的 WebSocket 连接、调度数据库、费用记录、Slack API 客户端和执行注册表。MCP 服务器充当受控桥梁——智能体调用 MCP 工具，MCP 服务器与 agent-server 内部通信（通过 HTTP 到本地 webhook 服务器端口 3001，或通过读取共享文件），结果流回智能体。

## 内置 MCP 服务器 {#the-bundled-mcp-servers}

### cortex-core

暴露远程机器操作和只读时钟，并在所有会话中加载。保留 `cortex-core` 服务器名，因此现有客户端和 skill 使用的 `mcp__cortex-core__remote_*` 名称不变。

| 工具 | 参数 | 描述 |
|---|---|---|
| `remote_bash` | `device`、`command`、`timeout?`、`description?`、`run_in_background?` | 通过 cortex-client 在远程设备上执行 shell 命令 |
| `remote_read` | `device`、`file_path`、`offset?`、`limit?` | 从远程设备读取文件（支持图像和 PDF） |
| `remote_write` | `device`、`file_path`、`content` | 向远程设备写入文件内容 |
| `remote_edit` | `device`、`file_path`、`old_string`、`new_string`、`replace_all?` | 通过字符串替换编辑远程设备上的文件 |
| `remote_glob` | `device`、`pattern`、`path?` | 在远程设备上查找匹配 glob 模式的文件 |
| `remote_grep` | `device`、`pattern`、`path?`、`glob?`、`type?`、`output_mode?`、`-A?`、`-B?`、`-C?`、`-i?`、`-n?`、`head_limit?`、`offset?`、`multiline?` | 使用 ripgrep 在远程设备上搜索文件内容 |
| `current_time` | `timezone?` | 获取当前日期时间；可选 IANA 时区（默认服务器本地）。返回 Unix 时间戳、UTC ISO 字符串及带偏移的本地时间 |

服务器实现在 `agent-server/src/domain/mcp/core-server.ts`。

### cortex-tasks

暴露只读任务监控工具，并在仍维护的 Claude 和 PI 顶层直接会话与线程会话中加载。PI `Agent` 子代理只获得 cortex-core。

| 工具 | 参数 | 描述 |
|---|---|---|
| `task_status` | `task_id`、`project?` | 读取任务的生命周期状态（status、是否可执行、claimed_by、blocked_by、依赖、parent） |
| `task_result` | `task_id`、`project?` | 读取任务的结果（done/blocked、done_when、完成备注、阻塞原因） |
| `task_list` | `project?`、`status?`、`parent?`、`limit?` | 列出任务（可按 status 或 parent 过滤） |

服务器实现在 `agent-server/src/domain/mcp/tasks-server.ts`。

### cortex-manager-qa

向顶层直接会话和线程会话暴露 manager 到子任务的回答通道。Claude 中的规范工具名是 `mcp__cortex-manager-qa__answer_subtask`。PI `Agent` 子代理不加载此服务器，因为它们不持有任务树问题。

| 工具 | 参数 | 描述 |
|---|---|---|
| `answer_subtask` | `question_id`、`answer` | 回答子任务提出的澄清问题 |

服务器实现在 `agent-server/src/domain/mcp/manager-qa-server.ts`。

### cortex-thread

暴露线程生命周期控制面和向上澄清通道。对于 Claude 和 PI，仅当 `CORTEX_THREAD_ID` 标识活动线程时加载；直接会话永远不会获得这些工具。

| 工具 | 参数 | 描述 |
|---|---|---|
| `thread_abort` | `kind`、`diagnosis` | 升级你自己的线程（too-big / mis-scoped / blocked-external，终态 `aborted`） |
| `thread_split` | `subtasks` | 把你自己的任务分解为子任务（keep-parent 汇合），子任务走正常派发队列 |
| `thread_wait` | `on_tasks?`、`on_threads?` | 挂起你自己的线程直到被等待的子项完成；与 `cortex-task spawn` 配合使用 |
| `ask_manager` | `question` | 向规划本任务的 manager 提出阻塞式澄清问题 |

服务器实现在 `agent-server/src/domain/mcp/thread-server.ts`。工具注册器仍在 `agent-server/src/domain/mcp/tools/`。

### cortex-ext

暴露 Cortex 管理工具：调度、费用查询和上下文解析。Claude 仅在直接/用户会话中加载它；PI bridge 在所有顶层会话中加载 cortex-ext。

| 工具 | 参数 | 描述 |
|---|---|---|
| `cortex_schedule_add` | `type`、`message`、`interval?`、`time?`、`dayOfWeek?`、`delay?`、`target?`、`fallback?`、`profile?`、`preCheck?`、`channel?` | 创建调度任务（interval、daily、weekly 或 once） |
| `cortex_schedule_list` | `limit?` | 列出所有调度任务及其状态 |
| `cortex_schedule_get` | `id` | 通过 8 字符十六进制 ID 查找调度任务 |
| `cortex_schedule_remove` | `id` | 删除调度任务（幂等） |
| `cortex_schedule_pause` | `id` | 暂停周期性调度任务 |
| `cortex_schedule_resume` | `id` | 恢复暂停的调度任务 |
| `cost_query` | _(无)_ | 查询当前费用：今天/月支出、预算限制、剩余预算、API/plan 分摊、来源细分、令牌使用量 |
| `query_executions` | `execution_id?`、`task_id?`、`status?`、`project?`、`limit?` | 查询执行记录——按状态、项目过滤，或按 ID 查找 |
| `cortex_context` | _(无)_ | 返回当前执行上下文：channel、sessionId、sessionName、threadId、profile、project、backend |

服务器实现在 `agent-server/src/domain/mcp/server.ts`。各个工具在 `agent-server/src/domain/mcp/tools/`。

### cortex-slack

Slack 平台特定的 MCP 服务器。仅当会话源自 Slack 时加载，提供平台特定的文件上传和消息功能。

| 工具 | 参数 | 描述 |
|---|---|---|
| `slack_send_file` | `file_path`、`file_name?`、`title?`、`comment?` | 上传本地文件到 Slack |

服务器实现在 `agent-server/src/domain/mcp/slack-server.ts`。

### cortex-feishu

飞书/Lark 平台特定的 MCP 服务器。仅当会话源自飞书时加载，只暴露一个工具——向聊天发送文件。

| 工具 | 参数 | 描述 |
|---|---|---|
| `feishu_send_file` | `file_path`、`file_name?`、`title?`、`channel?` | 上传本地文件到飞书聊天 |

文档、表格、电子表格、知识库等操作**不再是 MCP 工具**。它们改由飞书官方 CLI
（`@larksuite/cli`）完成，通过 `feishu-doc` skill 驱动。该 CLI 能可靠处理原生表格和
block 级精修（此前的 `feishu_docx_*` MCP 工具会把表格降级成纯文本 block，已移除）。
安装/鉴权 preflight 以及如何委托给 CLI 自带的 `lark-doc` / `lark-sheets` / `lark-base`
skill 指南，见 `feishu-doc` skill。

服务器实现在 `agent-server/src/domain/mcp/feishu-server.ts`。工具在 `agent-server/src/domain/mcp/feishu/file.ts`。

### cortex-tui-bridge

在交互式 TUI 会话和用户发起的 Claude print 会话中加载。它用经 Cortex 路由的 MCP 等效工具替换 Claude Code 原生的 `EnterPlanMode`、`ExitPlanMode` 和 `AskUserQuestion`。

| 工具 | 描述 |
|---|---|
| `cortex_plan_enter` | 发出智能体处于计划模式的提醒 |
| `cortex_plan_exit` | 读取计划文件，发送到 Slack 供人类审批，阻塞直到解决 |
| `cortex_ask_user` | 通过 Slack 模态框询问 1-4 个问题，阻塞直到回答 |

服务器实现在 `agent-server/src/domain/mcp/tui-server.ts`。工具在 `agent-server/src/domain/mcp/tools/tui-plan.js` 和 `tui-ask.js`。

## MCP 配置文件 {#mcp-configuration-files}

Cortex 在启动时自动生成 MCP 配置文件（通过 `agent-server/src/core/config-generator.ts` 和 `agent-server/src/entry/startup-helpers.ts` 中的 `ensureMcpConfig()` 调用）。平台特定的服务器（cortex-slack、cortex-feishu）根据会话的源平台动态加载。

| 文件 | 加载者 | 服务器 |
|---|---|---|
| `~/.cortex/config/mcp-config.json` | 直接会话基础层 | core + tasks + manager-Q&A + ext |
| `~/.cortex/config/mcp-config-core.json` | 线程会话分层 | 仅 cortex-core |
| `~/.cortex/config/mcp-config-tasks.json` | 线程会话分层 | 仅 cortex-tasks |
| `~/.cortex/config/mcp-config-manager-qa.json` | 线程会话回答分层 | 仅 cortex-manager-qa |
| `~/.cortex/config/mcp-config-thread.json` | 仅线程会话的分层 | 仅 cortex-thread |
| `~/.cortex/config/mcp-config-tui.json` | 交互工具分层（按需） | 仅 cortex-tui-bridge |
| `~/.cortex/config/mcp-config-slack.json` | Slack 特定分层（按需） | cortex-slack |

每个文件遵循 Claude Code 的标准 MCP 配置格式：

```json
{
  "mcpServers": {
    "cortex-core": {
      "command": "node",
      "args": ["/path/to/core-server.js"],
      "cwd": "/path/to/cwd"
    },
    "cortex-tasks": {
      "command": "node",
      "args": ["/path/to/tasks-server.js"],
      "cwd": "/path/to/cwd"
    },
    "cortex-manager-qa": {
      "command": "node",
      "args": ["/path/to/manager-qa-server.js"],
      "cwd": "/path/to/cwd"
    },
    "cortex-ext": {
      "command": "node",
      "args": ["/path/to/server.js"],
      "cwd": "/path/to/cwd"
    }
  }
}
```

配置文件在每次 agent-server 启动时重新生成。手动编辑它们将被覆盖。要自定义 MCP 配置，修改 `core/config-generator.ts` 中的生成器或工具读取的 profile/budget/schedule 设置。

### 如何选择正确的配置 {#how-the-right-config-gets-selected}

在 `agent-adapter/claude/spawn-args.ts` 中，MCP 配置按会话上下文组合：

- **直接/用户会话**加载 `mcp-config.json`（core + tasks + manager-Q&A + ext），再追加符合条件的平台和交互分层；永不加载 `mcp-config-thread.json`。
- **线程/模板会话**加载 `mcp-config-core.json`、`mcp-config-tasks.json`、`mcp-config-manager-qa.json` 和 `mcp-config-thread.json`；不加载仅直接会话使用的 ext、平台或 TUI bridge 分层。

线程分支由 `session.cortexContext.useCoreMcp` 标记。PI bridge 的顶层会话始终连接 core、tasks、manager-Q&A 和 ext；仅当 `CORTEX_THREAD_ID` 存在时，`shouldLoadThreadControl()` 才追加 cortex-thread。PI `Agent` 子代理只连接 cortex-core。平台服务器继续由来源频道谓词门控。

## MCP 工具如何与 agent-server 通信 {#how-mcp-tools-communicate-with-agent-server}

MCP 服务器作为独立的子进程运行。它们不能直接访问 agent-server 的进程内状态（WebSocket 连接、调度仓库、执行注册表）。相反，它们通过两条路径通信：

1. **HTTP 环回** — 远程机器工具（`remote_bash`、`remote_read` 等）发送 HTTP POST 到 `http://127.0.0.1:3001/webhook/remote-command`。`agent-server/src/orchestration/routing/webhook.ts` 中的 webhook 处理程序将请求转发到 `client-manager.sendCommand()`，后者通过 WebSocket 发送到远程设备。

2. **共享文件访问** — 调度、费用和执行工具直接读取和写入 `~/.cortex/data/` 中的共享数据文件（schedules.json、costs.jsonl、executions.json），使用与主服务器进程相同的仓库层。

## 添加第三方 MCP 服务器 {#adding-a-third-party-mcp-server}

要添加第三方 MCP 服务器（例如数据库连接器、网络搜索工具或自定义研究工具），将其添加到 `~/.cortex/config/mcp-config.json`。如果线程智能体也应拥有它，请把它加入某个线程组合配置 builder，而不是只加入直接会话配置：

```json
{
  "mcpServers": {
    "cortex-core": { "command": "node", "args": ["..."], "cwd": "..." },
    "cortex-tasks": { "command": "node", "args": ["..."], "cwd": "..." },
    "cortex-ext": { "command": "node", "args": ["..."], "cwd": "..." },
    "my-custom-server": {
      "command": "python",
      "args": ["/home/user/my-mcp-server/server.py"],
      "env": { "API_KEY": "${MY_API_KEY}" }
    }
  }
}
```

**重要**：配置文件在每次服务器重启时重新生成。要持久化自定义 MCP 服务器条目，请修改 `agent-server/src/core/config-generator.ts` 中对应的 builder，而不是直接编辑生成的 JSON。

类型系统已经通过 `AgentSpawnConfig.mcpServers` 字段（每后端 `McpServerConfig` 数组）支持第三方 MCP 服务器，但截至当前代码库，此字段尚未被适配器消费。所有 MCP 配置仍然通过 `--mcp-config` CLI 标志流动。

## 权限模型 {#permission-model}

MCP 工具跨越从智能体进程到 agent-server 内部和远程机器的信任边界。Cortex 应用以下控制：

1. **服务器级可用性** — 后端工具 allowlist 无法逐个过滤 MCP 工具，因此权限按服务器拆分。顶层直接会话和线程会话都获得 cortex-manager-qa；只有线程会话获得 cortex-thread。PI `Agent` 子代理只获得 cortex-core，PI 顶层会话继续保留 cortex-ext。

2. **Claude Code 的第三方 MCP 被禁用** — `~/.cortex/.claude/settings.json` 中的设置 `ENABLE_CLAUDEAI_MCP_SERVERS: "false"` 阻止 Claude 从其自身的目录自动发现 MCP 服务器。Cortex 通过自己的配置文件独占管理 MCP 服务器。

3. **绕过权限** — Claude Code 以 `--dangerously-skip-permissions --permission-mode bypassPermissions` 生成，意味着它不会对每个 MCP 工具调用提示。访问控制在 MCP 工具实现级别和通过 PreToolUse 钩子系统进行。

4. **PreToolUse 守卫** — `tasks-yaml-guard.mjs` 钩子拦截对 `TASKS.yaml` 文件的 Edit/Write 操作（包括远程编辑）并检查项目锁。

5. **网络边界** — 与远程机器通信的 MCP 工具通过 client-manager 的 WebSocket 层。`machines.json` 注册表控制哪些设备是已知的。只有具有活跃 WebSocket 连接的设备才能接收命令。

## 传递给 MCP 服务器的环境变量 {#environment-variables-passed-to-mcp-servers}

MCP 服务器进程接收 agent server 环境变量的一个子集：

| 变量 | 来源 | 使用者 |
|---|---|---|
| `SLACK_CHANNEL` | 生成时的频道参数 | cortex-ext（slack_send_file）、tui-server |
| `SLACK_BOT_TOKEN` | process.env | cortex-ext |
| `CORTEX_SESSION_ID` | 会话上下文 | tui-server、context 工具 |
| `CORTEX_SESSION_NAME` | 会话上下文 | context 工具 |
| `CORTEX_THREAD_ID` | 线程上下文 | cortex-thread 工具、PI 线程控制谓词、context 工具 |
| `CORTEX_PROFILE` | 会话上下文 | context 工具 |
| `CORTEX_PROJECT` | 会话上下文 | context 工具 |
| `CORTEX_EXECUTION_ID` | 执行上下文 | 任务锁钩子 |
| `CORTEX_TUI_MODE` | 在 TUI 模式下设为 `'1'` | tui-server |
| `CORTEX_CALLBACK_SOURCE` | 可选回调元数据 | cortex-ext |
| `CORTEX_SCHEDULE_TASK_ID` | 可选调度任务 ID | cortex-ext |
| `ANTHROPIC_BASE_URL` | 可选 API 基础 URL 覆盖 | 模型路由 |

## 安全考量 {#security-considerations}

MCP 工具赋予智能体在远程机器上执行 shell 命令、读写文件、上传到 Slack 和修改调度的能力。安全假设如下：

- `cortex-client` WebSocket 端口（3002）不暴露到公网。使用 Tailscale、VPN 或 localhost-only 绑定（网络拓扑选项参见 [cross-machine.md](./cross-machine.md)）。
- Webhook HTTP 端口（3001）仅绑定到 `127.0.0.1`——MCP 服务器通过环回而不是网络与之通信。
- 智能体在与 [safety-and-approvals.md](./safety-and-approvals.md) 中记录的相同影响范围安全边界内运行。MCP 工具不能绕过对高权限操作的 need-approval 门控。
