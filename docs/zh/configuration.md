# 配置


Cortex 在启动时从 `$CORTEX_HOME/config/` 加载所有配置。唯一必需的变量是 `CORTEX_PLATFORM` 和平台凭据（Slack）。其他所有内容都有合理的默认值，大多数用户无需修改。

## 文件层次结构

以下所有路径均相对于 `$CORTEX_HOME`（默认：`~/.cortex/`）。

```
$CORTEX_HOME/
├── .env                          # 平台令牌、功能标志
├── config/
│   ├── .env                      # 同一个文件（符号链接/规范位置）
│   ├── profiles.json             # 命名的智能体配置
│   ├── thread-templates.json     # 智能体定义和编排模板
│   ├── machines.json             # 远程客户端机器注册表
│   ├── budget.json               # 每日/每月预算限制
│   ├── mcp-config.json           # 完整 MCP 服务器配置
│   ├── mcp-config-core.json      # 仅核心 MCP（remote_* 工具）
│   ├── mcp-config-tui.json       # TUI 模式 MCP 配置
│   └── session-hooks.json        # 会话级钩子配置
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
3. **`$CORTEX_HOME/config/profiles.json`** 在每次生成智能体时读取，用于解析模型、后端和额外环境变量。
4. **`$CORTEX_HOME/.claude/settings.json`** 由 Claude Code 读取（不是由 Cortex 直接读取），用于配置编程智能体后端的钩子和权限。

`.env` 文件支持标准的 `KEY=VALUE` 语法和 `#` 注释。已在 shell 中设置的环境变量优先于 `.env` 文件（dotenv 默认行为）。

## 环境变量

所有值从 `$CORTEX_HOME/config/.env` 文件加载。只有 `CORTEX_PLATFORM` 和平台凭据是必需的。

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
| `CORTEX_ADMIN_CHANNEL` | 否 | 系统通知的默认 admin channel（Slack 私信运行时自动检测） |
| `SLACK_ADMIN_CHANNEL` | 否 | Slack 平台 admin channel 覆盖（回退到 `CORTEX_ADMIN_CHANNEL`） |
| `FEISHU_ADMIN_CHANNEL` | 否 | 飞书 admin chat_id（`oc_...`），回退到 `CORTEX_ADMIN_CHANNEL` |

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
| `CORTEX_EVENT_LOG` | `on` | 设置为 `off` 以禁用事件总线日志 |
| `CORTEX_SHOW_TOOL_CALLS` | — | 在 VirtualMessage 尾部内联渲染工具调用 |
| `CORTEX_DISABLE_USER_CONTEXT` | — | 设置为 `1` 以禁用将 `USER.md` 上下文注入普通直接对话轮次（默认注入；多 agent thread 步骤不会收到） |
| `CORTEX_GPU_MONITOR_MOCK` | — | 用于测试的模拟 GPU 数据 JSON（覆盖真实的 nvidia-smi 查询） |
| `CORTEX_SERVER_UPDATE_DISABLE` | — | 设置为 `1` 以禁用服务器自动更新检查（默认开启） |
| `CORTEX_NOTIFY_COMPACTION` | — | 设置为 `1`，在 agent 的上下文被压缩（compaction）时向会话发送一条提示。覆盖 Claude Code（print 模式）与 pi 两个后端；提示会注明触发原因，Claude Code 还会附上压缩前的 token 数 |
| `CORTEX_TURN_NOTIFY` | `on` | 当一个耗时较长的回合结束时，Cortex 向会话发送一条新消息，让你收到推送通知（内联状态是以编辑方式封口为「✓ 完成」，而 Slack 与飞书都不会对消息编辑推送）。成功和失败都会提醒。设置为 `0`/`false`/`off`/`no` 以关闭 |
| `CORTEX_TURN_NOTIFY_THRESHOLD_S` | `60` | 触发完成提醒所需的最短回合时长（秒）。更短的回合保持静默 |
| `CORTEX_AUTO_RESUME` | `on` | 当用量限制窗口重置后，Cortex 自动继续被该限制中断的对话与线程，并注入一条提示让其从中断处接着做。设置为 `0`/`false` 可让被中断的工作保持暂停、由人工继续 |

`DEBUG` 会把未截断的 prompt、工具参数和工具结果持久化到各 session 的 conversation-history 文件中。这些内容可能包含密钥、私有文件内容或体积很大的输出，存储占用也会按完整内容持续增长。仅应在可信的开发服务器上临时启用，检查完成后及时关闭。关闭后 transcript 响应会立即停止返回调试字段，相关按钮也会消失，但此前已写入的记录不会被自动删除。

### 任务派发

| 变量 | 默认值 | 用途 |
|---|---|---|
| `TASK_DISPATCH_MAX_CONCURRENT` | `max(4, cpus - 2)` | 允许并发运行的任务派发线程数上限。设置为正整数时直接使用该值（显式覆盖）。未设置（或值非法）时自动解析为 `max(4, os.cpus().length - 2)`——按「核数减 2」伸缩，并以 4 为下限保底。该值在守护进程启动时解析一次，更改需重启生效。 |

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
| `profiles.<name>.backend` | string | 否 | 后端：`claude`、`pi` 或 `codex`（默认：`claude`） |
| `profiles.<name>.mode` | string | 否 | 运行模式标识符（自由格式，如 `plan`、`execute`） |
| `profiles.<name>.extraEnv` | object | 否 | 传递给后端进程的额外环境变量。键必须匹配 `^[A-Z_][A-Z0-9_]*$`。 |
| `profiles.<name>.extraOption` | object | 否 | 传递给后端的额外 CLI 标志。键必须以 `--` 开头。 |
| `profiles.<name>.claudeBackend` | string | 否 | Claude 适配器模式：`print`（默认，使用 `-p` + stream-json）或 `tui`（在 tmux 下交互式 Claude + jsonl tail）。非 claude 后端忽略。 |
| `profiles.<name>.thinking` | string | 否 | 思考档位，取后端原生值域：`claude` 为 `low`/`medium`/`high`/`xhigh`/`max` 之一（以 `--effort` 传递），`pi` 为 `off`/`minimal`/`low`/`medium`/`high`/`xhigh` 之一（以 `--thinking` 传递）。`codex` 不支持。不写则不传任何标志。fallback 条目不继承——每条自行声明。 |
| `profiles.<name>.fallback` | array | 否 | 有序的回退配置项列表。如果主后端失败，Cortex 按顺序尝试每个回退项。每个回退项继承主配置中未指定的字段。 |

### 配置解析

在智能体生成时，Cortex 通过以下链解析配置：

1. 如果显式提供了配置名称（通过 `--profile` 或线程模板），使用它。
2. 否则，使用 `profiles.json` 中的 `defaultProfile`。
3. 解析后的配置提供 `model`、`backend`、`mode`、`extraEnv`、`extraOption`、`claudeBackend` 和 `thinking`。
4. 如果后端调用因瞬态错误失败，Cortex 遍历 `fallback` 数组（如果有），按顺序尝试每个条目。

### 验证规则

配置名称必须匹配 `^[a-zA-Z0-9_-]+$`。后端必须是 `claude`、`codex` 或 `pi` 之一。如果指定，`claudeBackend` 必须是 `print` 或 `tui`。如果指定 `thinking`，其值必须属于该条目后端的值域（见字段表）；在 `codex` 配置上声明会报错。未知字段会被静默忽略。

## settings.json

位于 `$CORTEX_HOME/.claude/settings.json`。此文件配置 Claude Code 的钩子和权限系统。Cortex 在 `cortex init` 期间从 `defaults/.claude/settings.json` 初始化它，并且在后续运行中从不覆盖它。

文件遵循 Claude Code 的设置格式，包含 `hooks` 和 `permissions` 部分。钩子系统文档参见 [hooks.md](./hooks.md)。

## defaults/config/ 布局

npm 包中的 `agent-server/defaults/` 目录包含在 init 期间复制到 `$CORTEX_HOME/` 的发布默认值：

| 源 | 目标 | 覆盖行为 |
|---|---|---|
| `defaults/CORTEX.md` | `$CORTEX_HOME/CORTEX.md` | 从不 |
| `defaults/gitignore` | `$CORTEX_HOME/.gitignore` | 从不 |
| `defaults/.claude/settings.json` | `$CORTEX_HOME/.claude/settings.json` | 从不 |
| `defaults/config/budget.json` | `$CORTEX_HOME/config/budget.json` | 仅 `--force` |
| `defaults/config/thread-templates.json` | `$CORTEX_HOME/config/thread-templates.json` | 仅 `--force` |
| `defaults/config/session-hooks.json` | `$CORTEX_HOME/config/session-hooks.json` | 仅 `--force` |
| `defaults/prompts/` | `$CORTEX_HOME/prompts/` | 逐文件：新文件总是添加，已有文件保留除非 `--force` |
| `defaults/plugins/` | `$CORTEX_HOME/plugins/` | 逐文件：新文件总是添加，已有文件保留除非 `--force` |
| `defaults/rules/` | `$CORTEX_HOME/rules/` | 逐文件：新文件总是添加，已有文件保留除非 `--force` |
| `defaults/hooks/` | `$CORTEX_HOME/hooks/` | 逐文件：从不覆盖除非 `--force` |
| `defaults/data/schedules.json` | `$CORTEX_HOME/data/schedules.json` | 从不（除非 `--force`） |
| `defaults/context/` | `$CORTEX_HOME/context/` | 脚手架文件：从不覆盖 |

这种设计意味着 npm 包升级会自动提供新的提示、插件、规则和钩子，而不会覆盖用户的自定义内容。配置文件（`thread-templates.json`、`budget.json` 等）需要 `--force` 才能替换。

## 热重载行为

- **`schedules.json`** — 通过文件监视器监视。更改在几秒钟内生效，无需重启。完整调度系统参见 [scheduling.md](./scheduling.md)。
- **`profiles.json`** — 每次生成智能体时重新读取。更改配置无需重启。
- **`thread-templates.json`** — 每次启动线程时重新读取。
- **`.env`** — 需要守护进程重启才能生效（启动时通过 dotenv 加载一次）。
- **钩子脚本（`hooks/*.mjs`）** — 每次钩子调用时重新读取。
- **插件、提示、规则** — 每次智能体会话生成时重新读取。

## 各文件位置

| 文件 | 用途 | 路径 |
|---|---|---|
| `.env` | 环境变量 | `$CORTEX_HOME/config/.env` |
| `profiles.json` | 智能体配置 | `$CORTEX_HOME/config/profiles.json` |
| `thread-templates.json` | 线程定义 | `$CORTEX_HOME/config/thread-templates.json` |
| `machines.json` | 机器注册表 | `$CORTEX_HOME/config/machines.json` |
| `budget.json` | 预算限制 | `$CORTEX_HOME/config/budget.json` |
| `mcp-config.json` | MCP 服务器配置 | `$CORTEX_HOME/config/mcp-config.json` |
| `settings.json` | Claude 钩子/权限 | `$CORTEX_HOME/.claude/settings.json` |
| `mode.json` | 运行时模式 | `$CORTEX_HOME/data/mode.json` |
| `schedules.json` | 调度任务 | `$CORTEX_HOME/data/schedules.json` |
| `session-hooks.json` | 会话钩子 | `$CORTEX_HOME/config/session-hooks.json` |
