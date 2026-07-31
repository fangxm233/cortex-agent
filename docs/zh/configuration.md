# 配置


Cortex 在启动时从 `$CORTEX_HOME/config/` 加载所有配置。唯一必需的变量是 `CORTEX_PLATFORM` 和平台凭据（Slack）。其他所有内容都有合理的默认值，大多数用户无需修改。

## 文件层次结构

以下所有路径均相对于 `$CORTEX_HOME`（默认：`~/.cortex/`）。

```
$CORTEX_HOME/
├── .env                          # 平台令牌、功能标志
├── config/
│   ├── .env                      # 同一个文件（符号链接/规范位置）
│   ├── settings.json             # 运行时行为设置（热更新）
│   ├── profiles.json             # 命名的智能体配置
│   ├── thread-templates/         # 线程配置——每个 agent/template/shell 一个 JSON
│   ├── machines.json             # 远程客户端机器注册表
│   ├── budget.json               # 每日/每月预算限制
│   ├── mcp-config.json           # 直接会话 MCP 配置
│   ├── mcp-config-core.json      # 远程执行/时间分层
│   ├── mcp-config-tasks.json     # 只读任务监控分层
│   ├── mcp-config-manager-qa.json # 共享 manager 回答分层
│   ├── mcp-config-thread.json    # 线程控制分层
│   ├── mcp-config-tui.json       # TUI 交互分层
│   └── hooks/                    # 钩子注册表——每个钩子一个 JSON 声明
├── data/
│   ├── mode.json                 # 当前运行时模式和配置
│   ├── schedules.json            # 持久化的调度任务列表
│   ├── executions.json           # 统一执行注册表
│   ├── costs.jsonl               # 90 天滚动费用记录
│   └── sessions.json             # 频道到智能体会话的映射
├── .claude/
│   └── settings.json             # Claude Code 钩子和权限
├── hooks/                        # 钩子脚本（.mjs）
├── plugins/                      # 角色限定技能插件
├── prompts/                      # 系统提示、指令、模板
├── rules/                        # 智能体会话的上下文规则
├── context/                      # Dense Context 知识库
│   └── projects/                 # 研究项目文件
├── logs/                         # 守护进程和 LLM 会话日志
└── tmp/                          # 临时工作区（线程等）
```

## 加载顺序和优先级

1. **内置默认值**（`agent-server/defaults/`）随 npm 包一起发布，为每个配置文件提供回退值。
2. **`$CORTEX_HOME/config/.env`** 在守护进程启动时通过 `dotenv` 加载。这些会覆盖守护进程和所有 fork 子进程的进程环境变量。
3. **`$CORTEX_HOME/config/settings.json`** 保存运行时行为设置。它在使用点按需读取，改动热更新生效；对它显式声明的每个键，它的优先级高于同一设置的旧环境变量。
4. **`$CORTEX_HOME/config/profiles.json`** 在每次生成智能体时读取，用于解析模型、后端和额外环境变量。
5. **`$CORTEX_HOME/.claude/settings.json`** 由 Claude Code 读取（不是由 Cortex 直接读取），用于配置编程智能体后端的钩子和权限。

`.env` 文件支持标准的 `KEY=VALUE` 语法和 `#` 注释。已在 shell 中设置的环境变量优先于 `.env` 文件（dotenv 默认行为）。

## 环境变量

所有值从 `$CORTEX_HOME/config/.env` 文件加载。只有 `CORTEX_PLATFORM` 和平台凭据是必需的。

服务器的行为设置已不在这里：它们迁到了 [`config/settings.json`](#configsettingsjson)，改了即刻生效，不再需要重启。旧的环境变量仍作为已弃用的回退继续可用，并会在下一次守护进程启动时自动从 `.env` 迁出。

### 路径

| 变量 | 默认值 | 用途 |
|---|---|---|
| `CORTEX_HOME` | `~/.cortex/` | 用户数据根目录（配置、上下文、日志、存储） |
| `CORTEX_PROJECTS_DIR` | `<CORTEX_HOME>/context/projects/` | 覆盖项目目录 |
| `CORTEX_REPO` | — | 用于守护进程自动重建/热重载的仓库路径 |

### 启动

| 变量 | 默认值 | 用途 |
|---|---|---|
| `CORTEX_MACHINE` | `os.hostname()` | 启动私信的机器标签 |
| `CORTEX_RESTART_REASON` | — | 重启通知的原因字符串 |
| `CORTEX_CLIENT_PORT` | `3002` | cortex-client 管理器的 WebSocket 端口 |

### 平台

`CORTEX_PLATFORM` 选择消息平台，可填单个值（`slack`、`feishu`），也可填**逗号列表**让多个平台同时在线（`slack,feishu`）。每个凭据齐全的平台都会启动，可选的 TUI 网关（`CORTEX_TUI`）叠加其上。多平台时消息按平台路由，系统通知扇出到各平台各自的 admin channel。

| 变量 | 必需 | 用途 |
|---|---|---|
| `CORTEX_PLATFORM` | 是 | `slack`（默认）。多平台填逗号列表，如 `slack,feishu` |
| `SLACK_BOT_TOKEN` | slack 需要 | Slack Bot OAuth 令牌（`xoxb-...`） |
| `SLACK_SIGNING_SECRET` | slack 需要 | Slack 应用签名密钥 |
| `SLACK_APP_TOKEN` | slack 需要 | Socket Mode 的 Slack 应用级令牌（`xapp-...`） |
| `FEISHU_APP_ID` | feishu 需要 | 飞书应用 ID（`cli_...`） |
| `FEISHU_APP_SECRET` | feishu 需要 | 飞书应用密钥 |
| `FEISHU_ENCRYPT_KEY` | 否 | 飞书事件加密密钥（长连接模式下可选） |
| `FEISHU_VERIFICATION_TOKEN` | 否 | 飞书事件验证令牌（可选） |
| `FEISHU_DOMAIN` | 否 | `feishu`（默认）或国际版 `lark` |
| `FEISHU_CHANNEL` | 否 | 飞书频道 ID（会话自动设置）— 用于标识当前飞书 conduit，供 MCP 工具使用 |

发送系统通知的 admin channel 现在是设置项而非环境变量：见 [`config/settings.json`](#configsettingsjson) 中的 `adminChannel` 与 `feishuAdminChannel`。旧变量 `SLACK_ADMIN_CHANNEL`、`CORTEX_ADMIN_CHANNEL`、`FEISHU_ADMIN_CHANNEL` 仍作为已弃用的回退被读取。

### API

| 变量 | 用途 |
|---|---|
| `ANTHROPIC_API_KEY` | 直接 API 模式的 Anthropic API 密钥 |
| `ANTHROPIC_BASE_URL` | 覆盖 API 基础 URL（由网关代理自动设置） |

### 速率限制（Slack）

| 变量 | 默认值 | 用途 |
|---|---|---|
| `CORTEX_SLACK_RL_GLOBAL_CAPACITY` | `20` | 全局 API 调用令牌桶容量 |
| `CORTEX_SLACK_RL_GLOBAL_REFILL_PER_SEC` | `1` | 全局每秒补充速率 |
| `CORTEX_SLACK_RL_CHANNEL_CAPACITY` | `1` | 每频道令牌桶容量 |
| `CORTEX_SLACK_RL_CHANNEL_REFILL_PER_SEC` | `1` | 每频道每秒补充速率 |

### Webhook

| 变量 | 默认值 | 用途 |
|---|---|---|
| `WEBHOOK_PORT` | `3001` | Webhook HTTP 服务器端口 |
| `WEBHOOK_HOST` | `127.0.0.1` | 远程客户端的回退主机（当 Tailscale/LAN IP 未检测到时） |
| `GITHUB_WEBHOOK_SECRET` | — | GitHub webhook HMAC-SHA256 签名密钥 |

### 数据文件覆盖

| 变量 | 默认值 | 用途 |
|---|---|---|
| `CORTEX_EXECUTIONS_FILE` | `<STORE_DIR>/executions.json` | 执行记录 |
| `CORTEX_COSTS_FILE` | `<STORE_DIR>/costs.jsonl` | 费用追踪 |
| `CORTEX_BUDGET_FILE` | `<CONFIG_DIR>/budget.json` | 预算配置 |

### 功能标志

| 变量 | 默认值 | 用途 |
|---|---|---|
| `DEBUG` | — | 启用 agent-server 全局调试模式。除调试级日志外，desktop 会在 transcript 中提供 hover 检查按钮，用于查看实际发送给 agent 的完整消息，以及每次工具调用的完整参数和结果。任意非空值都会启用；修改后需重启 agent-server |
| `CORTEX_DEBUG_TOOL_WARNING_CHARS` | `10000` | DEBUG transcript 中，若格式化后的完整参数与完整结果之和严格超过该 Unicode 字符数，则将工具名称 badge 标黄。仅接受正整数，非法值回退默认值；修改后需重启 agent-server |
| `CORTEX_GPU_MONITOR_MOCK` | — | 用于测试的模拟 GPU 数据 JSON（覆盖真实的 nvidia-smi 查询） |

事件日志、工具调用渲染、用户上下文注入、更新检查、压缩提示、回合完成提醒与自动恢复这些开关现在是设置项——见 [`config/settings.json`](#configsettingsjson)。

`DEBUG` 会把未截断的 prompt、工具参数和工具结果持久化到各 session 的 conversation-history 文件中。这些内容可能包含密钥、私有文件内容或体积很大的输出，存储占用也会按完整内容持续增长。仅应在可信的开发服务器上临时启用，检查完成后及时关闭。关闭后 transcript 响应会立即停止返回调试字段，相关按钮也会消失，但此前已写入的记录不会被自动删除。

## profiles.json

位于 `$CORTEX_HOME/config/profiles.json`。定义命名智能体配置，控制每个智能体会话使用的后端、模型和额外配置。可用后端对比参见 [backends.md](./backends.md)。

### 模式

```json
{
  "defaultProfile": "plan",
  "profiles": {
    "plan": {
      "model": "claude-sonnet-4-20250514",
      "backend": "claude",
      "mode": "plan",
      "claudeBackend": "print",
      "extraEnv": {},
      "extraOption": {},
      "fallback": []
    },
    "execute": {
      "model": "claude-sonnet-4-20250514",
      "backend": "claude",
      "mode": "execute",
      "claudeBackend": "print",
      "extraEnv": {},
      "extraOption": {}
    }
  }
}
```

### 字段

| 字段 | 类型 | 必需 | 描述 |
|---|---|---|---|
| `defaultProfile` | string | 是 | 未指定配置时使用的默认配置名称 |
| `profiles` | object | 是 | 配置名称到配置项的映射 |
| `profiles.<name>.model` | string | 是 | 模型标识符（如 `claude-sonnet-4-20250514`） |
| `profiles.<name>.backend` | string | 否 | 后端：`claude` 或 `pi`（默认：`claude`） |
| `profiles.<name>.mode` | string | 否 | 运行模式标识符（自由格式，如 `plan`、`execute`） |
| `profiles.<name>.extraEnv` | object | 否 | 传递给后端进程的额外环境变量。键必须匹配 `^[A-Z_][A-Z0-9_]*$`。 |
| `profiles.<name>.extraOption` | object | 否 | 传递给后端的额外 CLI 标志。键必须以 `--` 开头。 |
| `profiles.<name>.claudeBackend` | string | 否 | Claude 适配器模式：`print`（默认，使用 `-p` + stream-json）或 `tui`（在 tmux 下交互式 Claude + jsonl tail）。非 claude 后端忽略。 |
| `profiles.<name>.thinking` | string | 否 | 思考档位，取后端原生值域：`claude` 为 `low`/`medium`/`high`/`xhigh`/`max` 之一（以 `--effort` 传递），`pi` 为 `off`/`minimal`/`low`/`medium`/`high`/`xhigh` 之一（以 `--thinking` 传递）。不写则不传任何标志。fallback 条目不继承——每条自行声明。 |
| `profiles.<name>.fallback` | array | 否 | 有序的回退配置项列表。如果主后端失败，Cortex 按顺序尝试每个回退项。每个回退项继承主配置中未指定的字段。 |

### 配置解析

在智能体生成时，Cortex 通过以下链解析配置：

1. 如果显式提供了配置名称（通过 `--profile` 或线程模板），使用它。
2. 否则，使用 `profiles.json` 中的 `defaultProfile`。
3. 解析后的配置提供 `model`、`backend`、`mode`、`extraEnv`、`extraOption`、`claudeBackend` 和 `thinking`。
4. 如果后端调用因瞬态错误失败，Cortex 遍历 `fallback` 数组（如果有），按顺序尝试每个条目。

### 验证规则

配置名称必须匹配 `^[a-zA-Z0-9_-]+$`。后端必须是 `claude` 或 `pi`。如果指定，`claudeBackend` 必须是 `print` 或 `tui`。如果指定 `thinking`，其值必须属于该条目后端的值域（见字段表）。未知字段会被静默忽略。

## config/settings.json

位于 `$CORTEX_HOME/config/settings.json`。该文件保存服务器的**运行时行为设置**：这些开关与上限过去是环境变量，改动必须重启守护进程才生效。现在改这个文件无需重启。

它是一个扁平 JSON 对象，**只存放你显式覆盖的键**。没写的键回退到该设置的旧环境变量，再回退到内置默认值。文件本身是可选的——全新安装没有这个文件，完全按默认值运行；它会在第一次被写入时创建：下文的启动迁移、admin channel 自动探测，或 Web 工作台的设置面板。

```json
{
  "turnNotify": false,
  "waitingSweepMs": 30000,
  "uiCorsOrigins": ["cortexui://localhost"]
}
```

读取文件时会按下表的类型逐键校验。类型不符的键会让整个文件被判为无效：启动时回退到环境变量与默认值，热重载时则保留上一份有效设置。两种情况都会记录原因日志。未知键被忽略。

### 键

| 键 | 类型 | 默认值 | 作用 | 旧环境变量 |
|---|---|---|---|---|
| `turnNotify` | boolean | `true` | 当一个耗时较长的回合结束时，向会话发送一条新消息，让你收到推送通知（内联状态是以编辑方式封口为「✓ 完成」，而 Slack 与飞书都不会对消息编辑推送）。成功和失败都会提醒 | `CORTEX_TURN_NOTIFY` |
| `turnNotifyThresholdS` | number | `60` | 触发上述完成提醒所需的最短回合时长（秒）。更短的回合保持静默 | `CORTEX_TURN_NOTIFY_THRESHOLD_S` |
| `notifyCompaction` | boolean | `false` | 在 agent 的上下文被压缩（compaction）时向会话发送一条提示。覆盖 Claude Code（print 模式）与 pi 两个后端；提示会注明触发原因，Claude Code 还会附上压缩前的 token 数 | `CORTEX_NOTIFY_COMPACTION` |
| `showToolCalls` | boolean | `false` | 在 VirtualMessage 尾部内联渲染工具调用 | `CORTEX_SHOW_TOOL_CALLS` |
| `statusNewqButton` | boolean | `false` | 在状态消息上显示「New (quiet)」按钮（`=!newq`，跳过 pre-close 钩子） | `CORTEX_STATUS_NEWQ_BUTTON` |
| `autoResume` | boolean | `true` | 当用量限制窗口重置后，自动继续被该限制中断的对话与线程，并注入一条提示让其从中断处接着做。设为 `false` 可让被中断的工作保持暂停、由人工继续 | `CORTEX_AUTO_RESUME` |
| `streamDeltas` | boolean | `true` | 按 token 流式输出助手文本。关闭后每条助手消息整条投递 | `CORTEX_STREAM_DELTAS` |
| `bgContinuation` | boolean | `true` | 后台任务结束时，把其输出续投回会话 | `CORTEX_BG_CONTINUATION` |
| `eventLog` | boolean | `true` | 把事件总线写入按日滚动的 JSONL 事件日志 | `CORTEX_EVENT_LOG` |
| `disableUserContext` | boolean | `false` | 设为 `true` 可停止把 `USER.md` 上下文注入普通直接对话轮次（默认注入；多 agent thread 步骤不会收到） | `CORTEX_DISABLE_USER_CONTEXT` |
| `serverUpdateDisable` | boolean | `false` | 设为 `true` 可禁用服务器自动更新检查（默认开启） | `CORTEX_SERVER_UPDATE_DISABLE` |
| `hooksLegacy` | boolean | `false` | 绕过钩子注册表，改用固定的内置表构建 Claude 的 hook 设置。参见 [hooks.md](./hooks.md) | `CORTEX_HOOKS_LEGACY` |
| `managerRotateSteps` | number | `10` | 一个 manager 会话在被轮换成新 incarnation 之前运行的步数。参见 [threads.md](./threads.md) | `CORTEX_MANAGER_ROTATE_STEPS` |
| `waitingSweepMs` | number | `60000` | 磁盘对账扫描的间隔（毫秒），逐个核对等待中的 manager 线程与磁盘上的任务状态。`0` 表示禁用扫描（见下文的热更新例外） | `CORTEX_WAITING_SWEEP_MS` |
| `injectWaitMaxS` | number | `600` | 一条中途注入的消息等待回复的时长上限（秒），超过即释放 busy 闸门。防止卡死的进程永久占住守护进程的重启闸门 | `CORTEX_INJECT_WAIT_MAX_S` |
| `threadMaxDepth` | number | `5` | 嵌套线程生成的最大深度；达到或超过该深度的 spawn 会被拒绝 | `CORTEX_THREAD_MAX_DEPTH` |
| `taskArtifactTemplates` | string[] | `["manager"]` | 哪些模板的派发线程把 artifact 挂在任务节点上，而不是临时工作区 | `CORTEX_TASK_ARTIFACT_TEMPLATES`（逗号分隔） |
| `taskDispatchMaxConcurrent` | number \| null | `null` | 允许并发运行的任务派发线程数上限。这里写的数值直接使用（请填正数）；`null` 保持自动策略 `max(4, os.cpus().length - 2)`——按「核数减 2」伸缩，并以 4 为下限保底 | `TASK_DISPATCH_MAX_CONCURRENT` |
| `uiCorsOrigins` | string[] | `[]` | Web UI HTTP 宿主为哪些 origin 返回 CORS header。参见 [desktop-app.md](./desktop-app.md) | `CORTEX_UI_CORS_ORIGINS`（逗号分隔） |
| `adminChannel` | string \| null | `null` | 发送系统通知（启动、限流、磁盘告警）的 Slack 频道。第一次给机器人发私信时会被自动探测并持久化到这里 | `SLACK_ADMIN_CHANNEL`，然后 `CORTEX_ADMIN_CHANNEL` |
| `feishuAdminChannel` | string \| null | `null` | 同类通知的飞书 admin `chat_id`（`oc_...`）。与 `adminChannel` 相互独立——Slack 的频道 id 在飞书上不可用 | `FEISHU_ADMIN_CHANNEL` |

Web 工作台可写其中一部分：**设置 → 通知**（`turnNotify`、`autoResume`、`notifyCompaction`）与**设置 → 高级**（`eventLog`、`showToolCalls`、`disableUserContext`、`serverUpdateDisable`）。其余键都靠手工编辑该文件。

### 热更新

config 目录被监视。`settings.json` 的变更去抖 300 毫秒后重新读取文件，之后一律使用新值——**无需重启守护进程**。有两点值得注意：

- 每个设置在各自的使用点生效：下一个回合、下一次 agent 生成、下一轮派发，或下一个 HTTP 请求。`uiCorsOrigins` 在每个请求时解析；`adminChannel` 与 `feishuAdminChannel` 一变更就推送给正在运行的平台适配器。
- 坏文件不会打挂服务器。JSON 非法或类型不符时保留上一份设置并记录错误日志；修好文件后，下一次写入即被重新加载。

**例外——`waitingSweepMs`。** 等待中 manager 的扫描循环在每轮结束后按当前值自我重排，因此调大或调小间隔会从下一轮开始生效。但在运行中把它改成 `0` 会让循环彻底停下：没有任何东西会重排它，之后再改回正数也**不会**把它重新拉起，只有重启守护进程才行。（启动时值为 `0` 则该循环从不启动。）

### 旧环境变量与弃用提示

每个键都保留其旧环境变量作为回退，且解析语义与迁移前完全一致——`CORTEX_EVENT_LOG=off`、`CORTEX_TURN_NOTIFY=0`/`false`/`off`/`no`、`CORTEX_NOTIFY_COMPACTION=1`，两个 `string[]` 键用逗号分隔的列表，等等。优先级始终是：`settings.json` 中的键 → 旧环境变量 → 内置默认值。`adminChannel` 保留原有的优先级链：先看 `SLACK_ADMIN_CHANNEL`，再看 `CORTEX_ADMIN_CHANNEL`。

当某个旧环境变量第一次实际供值时，守护进程会记录一条弃用警告，指明该变量和它喂给的设置项（`Deprecated env <VAR> supplies settings.<key>; move it to settings.json`）。这层回退只为迁移期的兼容而存在——新的配置应写进 `settings.json`。

### 从 .env 自动迁移

每次守护进程启动、`.env` 加载之后，Cortex 会扫描 `$CORTEX_HOME/config/.env` 中是否存在上表中的旧变量。只要发现至少一个：

1. `.env` 被复制为同目录下的 `.env.bak-<时间戳>`，其中 `<时间戳>` 是把 `:` 和 `.` 替换为 `-` 的 ISO 8601 时刻（例如 `.env.bak-2026-07-30T09-12-33-482Z`）。
2. 每个旧值按其原语义解析后写入 `settings.json`。`settings.json` 中已存在的键绝不被覆盖——文件优先于 `.env`。
3. 被迁移的赋值行从 `.env` 中删除；`.env` 保持原有文件权限，并在头部加上一行注释 `# Legacy server settings migrated to settings.json; secrets remain in .env.`。
4. 同一趟顺带删除死变量 `CORTEX_SERVER_UPDATE_ENABLE`——已经没有任何代码读它。

迁移是幂等的：`.env` 中没有旧变量时原样不动，之后的启动也什么都不做。若任一步失败，错误会被记录，`.env` 保持完整，服务器继续按环境变量回退运行——迁移失败的代价仅仅是那些弃用警告。

### 仍然留在 .env 的内容

有三类变量刻意留在 `.env`：

- **密钥与凭据**——`SLACK_BOT_TOKEN`、`SLACK_SIGNING_SECRET`、`SLACK_APP_TOKEN`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`ANTHROPIC_API_KEY`、`GITHUB_WEBHOOK_SECRET`、`CORTEX_CLIENT_TOKEN`。它们广义上也是设置，但把它们挡在一个 Web UI 可读可写的文件之外，能把影响面压到最小。
- **由子进程消费的变量**——`CORTEX_HOME`、`CORTEX_PROJECTS_DIR`、`WEBHOOK_PORT`、`DEBUG`、`CORTEX_LANG` 以及数据文件覆盖项。钩子、MCP server、CLI 和 `cortex-client` 都继承守护进程的环境；服务器侧的 JSON 文件根本传不到它们那里。
- **启动拓扑**——`CORTEX_PLATFORM`、`CORTEX_MACHINE`、`CORTEX_UI_HTTP`、`CORTEX_UI_PORT`、`CORTEX_UI_SPA_DIR`。它们决定启动时存在哪些适配器与监听器，热更新对它们没有意义，结构上就必须重启。

### 与 .claude/settings.json 同名不同物

`$CORTEX_HOME/config/settings.json`（本文件）配置的是 **Cortex 服务器**。`$CORTEX_HOME/.claude/settings.json` 配置的是 **Claude Code** 的钩子与权限，由 Claude CLI 读取，Cortex 不读它。文件名相同，但目录不同、归属不同、schema 不同——见下一节。

## .claude/settings.json（Claude Code）

位于 `$CORTEX_HOME/.claude/settings.json`。此文件配置 Claude Code 的钩子和权限系统。Cortex 在 `cortex init` 期间从 `defaults/.claude/settings.json` 初始化它，并且在后续运行中从不覆盖它。

文件遵循 Claude Code 的设置格式，包含 `hooks` 和 `permissions` 部分。钩子系统文档参见 [hooks.md](./hooks.md)。它与 [`config/settings.json`](#configsettingsjson) 中的 Cortex 运行时设置毫无关系。

## defaults/config/ 布局

npm 包中的 `agent-server/defaults/` 目录包含随包发布的默认值。多数在 init 期间复制到 `$CORTEX_HOME/`；钩子资产与线程模板实体还会在服务器每次启动时重新同步：

| 源 | 目标 | 覆盖行为 |
|---|---|---|
| `defaults/CORTEX.md` | `$CORTEX_HOME/CORTEX.md` | 从不 |
| `defaults/gitignore` | `$CORTEX_HOME/.gitignore` | 从不 |
| `defaults/.claude/settings.json` | `$CORTEX_HOME/.claude/settings.json` | 从不 |
| `defaults/config/budget.json` | `$CORTEX_HOME/config/budget.json` | 仅 `--force` |
| `defaults/config/thread-templates/` | `$CORTEX_HOME/config/thread-templates/` | 逐文件 copy-if-missing，init 时与之后每次服务器启动时各执行一次：你尚未拥有的 agent/template/shell 文件会被拷入；你已有的文件绝不被覆盖——`--force` 对这棵树不生效 |
| `defaults/config/hooks/` | `$CORTEX_HOME/config/hooks/` | 每次服务器启动时逐文件按 CalVer 同步：缺失则添加，发布的 `version` 更新则刷新。没有 `version` 的声明（你自己的）永不被覆盖 |
| `defaults/prompts/` | `$CORTEX_HOME/prompts/` | 逐文件：新文件总是添加，已有文件保留除非 `--force` |
| `defaults/plugins/` | `$CORTEX_HOME/plugins/` | 逐文件：新文件总是添加，已有文件保留除非 `--force` |
| `defaults/rules/` | `$CORTEX_HOME/rules/` | 逐文件：新文件总是添加，已有文件保留除非 `--force` |
| `defaults/hooks/` | `$CORTEX_HOME/hooks/` | init 时逐文件：从不覆盖除非 `--force`。每次服务器启动时，除非已部署文件带有相等或更新的 `@cortex-hook-version`，否则重新复制发布的脚本 |
| `defaults/data/schedules.json` | `$CORTEX_HOME/data/schedules.json` | 从不（除非 `--force`） |
| `defaults/context/` | `$CORTEX_HOME/context/` | 脚手架文件：从不覆盖 |

这种设计意味着 npm 包升级会自动提供新的提示、插件、规则、钩子和线程模板实体，而不会覆盖用户的自定义内容。整文件型配置（如 `budget.json`）仍需 `--force` 才能替换；`config/thread-templates/` 则改为逐文件合并，新发货的实体能到达已有安装，同时不动你的改动。

## 热重载行为

- **`config/settings.json`** — 通过文件监视器监视，去抖 300 毫秒。新值在下一个使用点生效，无需重启；文件损坏时保留上一份设置。唯一的例外是运行中把 `waitingSweepMs` 改成 `0`，需重启才能恢复。参见 [config/settings.json](#configsettingsjson)。
- **`schedules.json`** — 通过文件监视器监视。更改在几秒钟内生效，无需重启。完整调度系统参见 [scheduling.md](./scheduling.md)。
- **`profiles.json`** — 每次生成智能体时重新读取。更改配置无需重启。
- **`thread-templates/`** — 每个实体子目录（`agents/`、`templates/`、`shells/`）都被监视。变更去抖（300ms）后整体重载配置，无需重启；旧的单文件 `thread-templates.json` 在迁移前以同样方式被监视。参见 [threads.md](./threads.md)。
- **`.env`** — 需要守护进程重启才能生效（启动时通过 dotenv 加载一次）。过去放在这里的行为设置已迁到 `config/settings.json`，后者不需要重启。
- **钩子声明（`config/hooks/*.json`）** — 注册表在每次智能体生成时重新读取，因此新增的 `agent:*` / `cc:*` / `pi:*` 条目对下一个启动的智能体生效。`cortex:*` 条目在服务器启动时被快照，需重启才生效。参见 [hooks.md](./hooks.md)。
- **钩子脚本（`hooks/*.mjs`）** — 每次钩子调用时重新读取。
- **插件、提示、规则** — 每次智能体会话生成时重新读取。

## 各文件位置

| 文件 | 用途 | 路径 |
|---|---|---|
| `.env` | 环境变量 | `$CORTEX_HOME/config/.env` |
| `settings.json` | 运行时行为设置（热更新） | `$CORTEX_HOME/config/settings.json` |
| `profiles.json` | 智能体配置 | `$CORTEX_HOME/config/profiles.json` |
| `thread-templates/` | 线程定义——每个 agent/template/shell 一个 JSON。目录存在时使用它；否则加载器回落读取旧的单文件 `thread-templates.json`，该文件会被一次性启动迁移拆分进本目录 | `$CORTEX_HOME/config/thread-templates/` |
| `machines.json` | 机器注册表 | `$CORTEX_HOME/config/machines.json` |
| `budget.json` | 预算限制 | `$CORTEX_HOME/config/budget.json` |
| `mcp-config.json` | MCP 服务器配置 | `$CORTEX_HOME/config/mcp-config.json` |
| `.claude/settings.json` | Claude Code 钩子/权限（不是 Cortex 的设置文件） | `$CORTEX_HOME/.claude/settings.json` |
| `mode.json` | 运行时模式 | `$CORTEX_HOME/data/mode.json` |
| `schedules.json` | 调度任务 | `$CORTEX_HOME/data/schedules.json` |
| `hooks/*.json` | 钩子声明 | `$CORTEX_HOME/config/hooks/` |
