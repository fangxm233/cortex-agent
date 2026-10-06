# 配置 {#configuration}


Cortex 从 `$CORTEX_HOME/config/` 读取配置。消息平台接入是可选的：网页和 App 会话可以在没有 Slack 或飞书机器人的情况下运行；每个启用的消息平台需要自己的凭据。

## 文件层次结构 {#file-hierarchy}

以下所有路径均相对于 `$CORTEX_HOME`（默认：`~/.cortex/`）。

```
$CORTEX_HOME/
├── .env                          # 平台令牌、功能标志
├── config/
│   ├── .env                      # 同一个文件（符号链接/规范位置）
│   ├── settings.json             # 运行时行为设置（热更新）
│   ├── profiles.json             # 命名的智能体配置
│   ├── environments/             # 执行环境——每个环境一个 JSON
│   ├── machines.json             # 远程客户端机器注册表
│   ├── budget.json               # 每日/每月预算限制
│   ├── mcp-config.json           # 直接会话 MCP 配置
│   ├── mcp-config-core.json      # 远程执行/时间分层
│   ├── mcp-config-interaction.json # 共享交互分层
│   └── hooks/                    # 钩子注册表——每个钩子一个 JSON 声明
├── data/
│   ├── mode.json                 # 当前运行时模式和配置
│   ├── schedules.json            # 持久化的定时任务列表
│   ├── executions.json           # 统一执行注册表
│   ├── costs.jsonl               # 90 天滚动费用记录
│   ├── session-registry.jsonl    # 会话记录、频道绑定、对话头与轮次（唯一所有者）
│   ├── *.pre-2026.9.14.bak       # 已退役的 sessions.json / conversation-ledger.json，迁移后保留一个版本
│   ├── retention-candidates.json # 两轮确认的孤儿保留标记
│   └── conversation-history/     # 按会话分文件的 transcript/history JSONL
├── .claude/
│   └── settings.json             # Cortex 脚手架生成的 Claude Code 项目设置
├── hooks/                        # 钩子脚本（.mjs）
├── plugins/                      # 技能插件
├── prompts/                      # 系统提示、指令、模板
├── rules/                        # 智能体会话的上下文规则
├── context/                      # Dense Context 知识库
│   └── projects/                 # 研究项目文件
├── logs/                         # 守护进程和后端会话日志
│   ├── sessions/                 # Claude capture 日志
│   └── sessions-pi/              # PI transcript bundle
└── tmp/                          # 临时工作区
```

## 加载顺序和优先级 {#loading-order-and-precedence}

1. **内置默认值**（`agent-server/defaults/`）随 npm 包一起发布，为每个配置文件提供回退值。
2. **`$CORTEX_HOME/config/.env`** 在守护进程启动时通过 `dotenv` 加载。启动环境中已有的变量优先于文件，worker 继承 daemon 的环境。
3. **`$CORTEX_HOME/config/settings.json`** 保存运行时行为设置。它在使用点按需读取，改动热更新生效；对它显式声明的每个键，它的优先级高于同一设置的旧环境变量。
4. **`$CORTEX_HOME/config/profiles.json`** 在每次生成智能体时读取，用于解析模型、后端和额外环境变量。
5. **`$CORTEX_HOME/.claude/settings.json`** 是 Cortex 脚手架生成的 Claude Code 项目设置文件。Claude Code 还可能读取 `<spawn cwd>/.claude/settings.local.json`、`<spawn cwd>/.claude/settings.json`，以及用户设置文件 `$CLAUDE_CONFIG_DIR/settings.json`（或 `~/.claude/settings.json`）。Cortex 只脚手架 `$CORTEX_HOME` 这一份；保留期助手会单独同步用户文件里的 `cleanupPeriodDays`。

`.env` 文件支持标准的 `KEY=VALUE` 语法和 `#` 注释。已在 shell 中设置的环境变量优先于 `.env` 文件（dotenv 默认行为）。

## 在 UI 中设置消息平台

浏览器、桌面和手机 App 的 **设置 → 平台** 提供飞书/Lark 和 Slack 接入表单。
启用平台、填写必填凭据后保存。密钥只写不回显：留空保留已保存值，输入新值替换，
点击“清除已保存值”并确认后，在下次保存时清除。关闭平台会保留凭据。
接入凭据仅可通过 HTTPS 或本机回环 API 地址提交；App 使用本地网页容器不代表
它连接的远程 HTTP 服务是安全的。

配置检查会列出缺失的必填字段，不代表已连接或已授权。接入配置写入 `config/.env`，
需要重启 **daemon 守护进程**，仅重启 worker 不够。页面比较磁盘配置与在役服务环境，
并标记差异；如果重启后仍有差异，请检查 daemon 启动环境中的同名变量。
保存不会重启任何进程。

各平台卡片可编辑通知目标：Slack 对应 `adminChannel`，飞书对应
`feishuAdminChannel`。它们保存在运行时设置中，用于后续通知。留空保存会清除路由；
飞书目标为空时，首次私聊可能自动注册通知目标。

飞书卡片中的 **在网页 / App 会话加载飞书技能** 控制 `settings.feishuSkillsInWeb`，
默认关闭。开启后，`web:` 会话（包括桌面和手机 App）可以加载已分配的
`cortex-feishu` 技能插件。飞书会话保持原有范围，Slack 和 CLI 会话不会因此加载该插件。
建议新建会话验证；仍需为 agent 分配插件并完成 `lark-cli` 登录与授权。
此设置不改变飞书 MCP 加载，也不授予账号权限。

## 环境变量 {#environment-variables}

所有值从 `$CORTEX_HOME/config/.env` 文件加载。只有 `CORTEX_PLATFORM` 和平台凭据是必需的。

服务器的行为设置已不在这里：它们迁到了 [`config/settings.json`](#configsettingsjson)，改了即刻生效，不再需要重启。旧的环境变量仍作为已弃用的回退继续可用，并会在下一次守护进程启动时自动从 `.env` 迁出。

### 路径 {#paths}

| 变量 | 默认值 | 用途 |
|---|---|---|
| `CORTEX_HOME` | `~/.cortex/` | 用户数据根目录（配置、上下文、日志、存储） |
| `CORTEX_PROJECTS_DIR` | `<CORTEX_HOME>/context/projects/` | 覆盖项目目录 |
| `CORTEX_REPO` | — | 用于守护进程自动重建/热重载的仓库路径 |

### 启动 {#startup}

| 变量 | 默认值 | 用途 |
|---|---|---|
| `CORTEX_MACHINE` | `os.hostname()` | 启动私信的机器标签 |
| `CORTEX_RESTART_REASON` | — | 重启通知的原因字符串 |
| `CORTEX_CLIENT_PORT` | `3002` | cortex-client 管理器的 WebSocket 端口 |

### 平台 {#platform}

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

### 速率限制（Slack） {#rate-limiting-slack}

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

### 数据文件覆盖 {#data-file-overrides}

| 变量 | 默认值 | 用途 |
|---|---|---|
| `CORTEX_EXECUTIONS_FILE` | `<STORE_DIR>/executions.json` | 执行记录 |
| `CORTEX_COSTS_FILE` | `<STORE_DIR>/costs.jsonl` | 费用追踪 |
| `CORTEX_BUDGET_FILE` | `<CONFIG_DIR>/budget.json` | 预算配置 |

### 功能标志 {#feature-flags}

| 变量 | 默认值 | 用途 |
|---|---|---|
| `DEBUG` | — | 启用 agent-server 全局调试模式。除调试级日志外，desktop 会在 transcript 中提供 hover 检查按钮，用于查看实际发送给 agent 的完整消息，以及每次工具调用的完整参数和结果。任意非空值都会启用；修改后需重启 agent-server |
| `CORTEX_DEBUG_TOOL_WARNING_CHARS` | `10000` | DEBUG transcript 中，若格式化后的完整参数与完整结果之和严格超过该 Unicode 字符数，则将工具名称 badge 标黄。仅接受正整数，非法值回退默认值；修改后需重启 agent-server |
| `CORTEX_GPU_MONITOR_MOCK` | — | 用于测试的模拟 GPU 数据 JSON（覆盖真实的 nvidia-smi 查询） |

事件日志、工具调用渲染、用户上下文注入、更新检查、压缩提示、回合完成提醒与自动恢复这些开关现在是设置项——见 [`config/settings.json`](#configsettingsjson)。

`DEBUG` 会把未截断的 prompt、工具参数和工具结果持久化到各 session 的 conversation-history 文件中。这些内容可能包含密钥、私有文件内容或体积很大的输出，存储占用也会按完整内容持续增长。仅应在可信的开发服务器上临时启用，检查完成后及时关闭。关闭后 transcript 响应会立即停止返回调试字段，相关按钮也会消失，但此前已写入的记录不会被自动删除。

## profiles.json

位于 `$CORTEX_HOME/config/profiles.json`。定义命名智能体配置，控制每个智能体会话使用的后端、模型和额外配置。可用后端对比参见 [backends.md](./backends.md)。

**设置 → Profiles** 就是这个文件的编辑器。其中 `provider`、`model`、`mode` 由列表选择而非手填：选定 provider 即选定网关 endpoint，其模型（来自已登录后端）与路由（来自 `gateway.yaml`）随之确定。三者都保留 **自定义…** 一项，服务端枚举不出的 endpoint 则直接退回文本框 —— 列表只做提供，不会收窄这个文件本身允许的取值。

### 模式 {#schema}

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

### 字段 {#fields}

| 字段 | 类型 | 必需 | 描述 |
|---|---|---|---|
| `defaultProfile` | string | 是 | 未指定配置时使用的默认配置名称 |
| `profiles` | object | 是 | 配置名称到配置项的映射 |
| `profiles.<name>.model` | string | 是 | 模型标识符（如 `claude-sonnet-4-20250514`） |
| `profiles.<name>.backend` | string | 否 | 后端：`claude` 或 `pi`（默认：`claude`） |
| `profiles.<name>.mode` | string | 否 | 运行模式标识符（自由格式，如 `plan`、`execute`） |
| `profiles.<name>.extraEnv` | object | 否 | 传递给后端进程的额外环境变量。键必须匹配 `^[A-Z_][A-Z0-9_]*$`。 |
| `profiles.<name>.extraOption` | object | 否 | 传递给 Claude Code 后端的额外 CLI 标志。键必须以 `--` 开头。在 `pi` 上只有 `--thinking` 生效（作为 `thinking` 字段的覆盖值），其余键会被记录日志并忽略——PI 没有可接收它们的命令行。 |
| `profiles.<name>.claudeBackend` | string | 否 | Claude 适配器模式：`print`（默认，使用 `-p` + stream-json）或 `tui`（在 tmux 下交互式 Claude + jsonl tail）。非 claude 后端忽略。 |
| `profiles.<name>.thinking` | string | 否 | 思考档位，取后端原生值域：`claude` 为 `low`/`medium`/`high`/`xhigh`/`max` 之一（以 `--effort` 标志传递），`pi` 为 `off`/`minimal`/`low`/`medium`/`high`/`xhigh` 之一（作为会话的 thinking level 传递）。不写则使用后端自身默认值。fallback 条目不继承——每条自行声明。 |
| `profiles.<name>.fallback` | array | 否 | 有序的回退配置项列表。如果主后端失败，Cortex 按顺序尝试每个回退项。每个回退项继承主配置中未指定的字段。 |

### 配置解析 {#profile-resolution}

在智能体生成时，Cortex 通过以下链解析配置：

1. 如果显式提供了配置名称（通过 `--profile`，或由对话的执行环境指定），使用它。
2. 否则，使用 `profiles.json` 中的 `defaultProfile`。
3. 解析后的配置提供 `model`、`backend`、`mode`、`extraEnv`、`extraOption`、`claudeBackend` 和 `thinking`。
4. 直接会话可以在该 profile 之上覆盖 `model`、`provider`、`thinking` 和 `mode`——在 Web 输入框的引擎选择器里选定，按 channel 保存。其余一概不可覆盖：后端、环境变量与回退链仍属于 profile。参见 [backends.md](./backends.md#per-session-model-thinking-level-and-route)。
5. 如果后端调用因瞬态错误失败，Cortex 遍历 `fallback` 数组（如果有），按顺序尝试每个条目。

### 验证规则 {#validation-rules}

配置名称必须匹配 `^[a-zA-Z0-9_-]+$`。后端必须是 `claude` 或 `pi`。如果指定，`claudeBackend` 必须是 `print` 或 `tui`。如果指定 `thinking`，其值必须属于该条目后端的值域（见字段表）。未知字段会被静默忽略。

## 执行环境 {#execution-environments}

执行环境决定一次对话除了"用哪个模型"之外的跑法：系统提示、内置工具列表、加载哪些插件、
会话拿到哪些 Cortex MCP 工具，以及带上多少环境上下文（规则、hook、项目块、后端自己的
skill）。每个执行环境是一个文件 `config/environments/<name>.json`，文件名就是它的名字。

Cortex 随包提供两个：

| 执行环境 | 用途 |
|---|---|
| `main` | 通用工作，跑在当前激活的 profile 上，加载 Cortex 的系统、commission 与飞书插件。它是默认环境：没选过执行环境的会话都跑在 `main` 里，且 `main` 不能删除 |
| `creative` | 用于写作、图像提示词、起名与文案的干净环境，运营性上下文全部剥掉（见[最小工具面](#a-minimal-surface)） |

随包文件在 `cortex init` 时拷入 `config/environments/`，之后每次服务器启动时，缺失的
文件会再补上。你已有的文件绝不被覆盖，所以你的改动在升级后依然保留；你自己新增的文件
也和随包的一样是一个执行环境。目录变更约 300 毫秒后生效，无需重启。不是合法 JSON、或
`name` 与文件名不一致的文件会被跳过并记录日志。

### 字段 {#environment-fields}

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 必须等于去掉 `.json` 的文件名 |
| `description` | string | 否 | 一行用途说明，显示在选择器里 |
| `profile` | string | 是 | `profiles.json` 中的某个 profile，或 `"__active__"` 表示跟随对话当前解析出的 profile。指定具体 profile 时，它只覆盖该环境下各轮的模型，不改写对话自己的 profile |
| `directive` | string | 否 | 前置到提示前面的角色或身份说明 |
| `systemPrompt` | string | 否 | 替换后端默认的系统提示 |
| `promptTemplate` | string | 否 | 包裹每条消息；`{{input}}` 代表发送的内容 |
| `claudeAgent` | string | 否 | Claude Code 的 agent 名称，以 `--agent` 传入。仅 Claude |
| `outputStyle` | string | 否 | Claude Code 的输出风格。仅 Claude |
| `tools` | string | 否 | 逗号分隔的内置工具列表，替换后端的默认工具集 |
| `pluginDirs` | string[] | 否 | 要加载的插件目录，非绝对路径时相对于 `$CORTEX_HOME`。缺省时不加载任何插件 |
| `mcpComposition` | `"direct"` \| `"none"` | 否 | `direct`（默认）让会话拿到 Cortex MCP 工具；`none` 不给任何 MCP，插件里的 server 也不给 |
| `mcpToolAllowlist` | string[] | 否 | 把 Cortex MCP 工具收窄到所列名字。缺省时保留完整工具面 |
| `loadRules` | boolean | 否 | 默认 `true`：前置 `rules/` 中的全局规则 |
| `disableHooks` | boolean | 否 | 默认 `false`。`true` 时会话不运行生命周期 hook |
| `skills` | boolean | 否 | 默认 `true`。`false` 移除后端的 skill 层，连 `Skill` 工具一起拿掉 |
| `settingSources` | string[] | 否 | 读取哪些 Claude 设置文件：`user`、`project`、`local` 任选。缺省时用 CLI 默认值；`[]` 一个都不读 |
| `projectContext` | boolean | 否 | 默认 `true`：在会话第一轮告诉它属于哪个项目 |

三个提示字段都可以写成 `file:<name>` 而不是字面文本，文本分别从 `prompts/directives/`、
`prompts/systemPrompts/`、`prompts/promptTemplates/` 读取；随包的 `main` 用的就是
`"systemPrompt": "file:direct.md"`。schema 不认识的字段、缺失的提示文件或缺失的插件目录
只会报警告，执行环境照常加载。

### 插件与 Environments 面板 {#plugins-and-the-environments-panel}

插件挂在执行环境上。执行环境的 `pluginDirs` 就是其会话加载的完整插件目录集合；执行环境的
Plugins 标签页写的就是这个字段，**Settings → Plugins** 则显示每个已安装插件被哪些执行环境使用
（见[技能与插件](./skills-and-plugins.md#assigning-plugins)）。

在 Web 工作台和桌面应用中，**Settings → Environments** 列出所有执行环境，一次编辑一个：
带实时校验的 JSON 正文、显示错误与警告的 Validation 标签页，以及管理插件集合的 Plugins
标签页。新建的执行环境从一个本身就能通过校验的骨架开始，已有的可以换个名字复制一份。
错误会阻止保存，警告不会；如果文件在你编辑期间已在磁盘上被改动，保存会被拒绝而不是覆盖它。
编辑一个仍与随包默认值相同的执行环境时会先提示，因为从那以后它不再跟随随包版本。`main`
不能删除。Android 的设置页把 Environments 标为仅限桌面端。

## 执行环境与 profile {#environments-vs-profiles}

决定一次会话怎么跑的是两个实体，它们各自独立变化。

**profile** 管模型路由：backend、model、mode、thinking 级别、额外环境变量和
fallback 链。**执行环境**（见上文）管会话的其余一切：提示、工具、插件、MCP 面与环境上下文。

`!profile <name>` 只换模型不动环境；`!agent <name>` 只换环境不动模型。钉了
`"profile": "__active__"` 的执行环境跟随所在对话当前解析出的 profile；指定了具体 profile
的执行环境则以 override 的形式在运行路径上生效——它不会改写对话自己的 profile，所以之后
`!agent reset` 时模型仍停在原处。

### 按对话选执行环境 {#choosing-an-environment-per-conversation}

执行环境的选择方式与 profile 相同：按对话选，下面垫着一个全局默认。

| 命令 | 作用 |
|---|---|
| `!agent` | 显示本对话的执行环境、它回退到的全局默认，以及可选列表——Slack 与飞书上是按钮 |
| `!agent <name>` | 让**本对话**从下一轮起跑在 `<name>` 里 |
| `!agent reset` | 把本对话交还给全局默认。`clear`、`off`、`none`、`disable` 同义 |
| `!agent global <name>` | 设置全局默认：所有没自己选过的对话跑哪个 |
| `!agent global off` | 清除全局默认，回到 `main` |

所有不带前缀的形式都只作用于当前对话；只有显式的 `global` 前缀才会动全局默认。

Web 与桌面端里，同一个选择有自己的控件：输入框上紧挨引擎胶囊左侧的一枚胶囊——先说在哪里
跑，再说用什么跑。它直接显示本对话所在的执行环境；本对话没选过时，显示它将回退到的全局
默认，并以灰色呈现，好让“自己选的”和“只是回退到的”一眼可分。点开是一个平铺列表：最上面的
`default` 表示“跟随全局默认”，下面是本机声明的每个执行环境，各自标注用途与它钉住的 profile。
只声明一个执行环境的机器不画这枚胶囊——没有可选的余地。新对话里的选择随第一条消息一起提交；
进行中的对话立即生效，从下一轮开始。

一轮对话按这条链解析自己的执行环境：会话自己的选择 → 所在对话的 → 全局默认 → `main`。已经无法解析的名字（执行环境被改名或删除）会被跳过。

切换遵循与 `!profile` 相同的规则：有历史的对话不能换 backend，所以钉在另一个 backend 的
profile 上的执行环境会被拒绝，并说明它需要哪个 backend。尚无对话轮次的会话可以任选。同一
backend 内切换在下一轮生效，历史保留——也就是说模型会看到自己在上一个环境里产生的那几轮；
不希望如此就 `!new`。

### 最小工具面 {#a-minimal-surface}

随包提供的 `creative` 是 Cortex 内置最小的环境——写作、图像提示词、起名、文案，运营性
上下文全部剥掉：

```json
{
  "name": "creative",
  "profile": "__active__",
  "systemPrompt": "file:creative.md",
  "tools": "Read,Write,Edit",
  "pluginDirs": [],
  "skills": false,
  "settingSources": [],
  "mcpComposition": "direct",
  "mcpToolAllowlist": ["send_file", "send_view", "cortex_ask_user"],
  "loadRules": false,
  "disableHooks": true,
  "projectContext": false
}
```

三个内置工具，没有 Cortex 插件、没有环境规则、没有 hook、没有项目块，MCP 面正好三个
工具：`send_file` 和 `send_view` 负责交付，`cortex_ask_user` 负责发问。用它开的会话被
问到自己能看到什么时，报的是三个工具、零个 skill。

`mcpToolAllowlist` 是上界，不是要求。它把会话的 MCP 面收窄到所列的名字；某个名字在这次
spawn 的 surface 上本来就不存在，那它在那里就只是不存在而已。所以同一份列表到处都能用：
这个 `creative` 在 Web 与桌面端保留三个工具，在 Slack 与飞书只剩 `cortex_ask_user`（它们
的文件交付是另一个工具，本列表没写）。
而一个在本机任何 bundle 里都不存在的名字仍然会让 spawn 失败：那是拼写错误，不是 surface。

### `pluginDirs` 之外的 skill {#skills-outside-plugindirs}

`pluginDirs` 并不是 skill 层的全部。无论 Cortex 传什么，Claude Code 每次 spawn 都会加载
它自己的那一份：`~/.claude/settings.json` 里启用的 plugin、`~/.claude/skills/` 下的内容，
以及 CLI 的内置 skill。有两个执行环境字段能够到它们。`settingSources: []` 让设置文件根本
不被读取，于是启用的 plugin 带来的 skill 随之消失；`skills: false` 直接移除整层，内置的
也不剩，连 `Skill` 工具一起拿掉。两个都设的执行环境看到的是零 skill、零斜杠命令。

## config/settings.json

位于 `$CORTEX_HOME/config/settings.json`。该文件保存服务器的**运行时行为设置**：这些开关与上限过去是环境变量，改动必须重启守护进程才生效。现在改这个文件无需重启。

它是一个扁平 JSON 对象，**只存放你显式覆盖的键**。没写的键在存在旧环境变量时先回退到该变量，再回退到内置默认值。文件本身是可选的——全新安装没有这个文件，完全按默认值运行；它会在第一次被写入时创建：下文的启动迁移、admin channel 自动探测，或 Web 工作台的设置面板。

```json
{
  "turnNotify": false,
  "turnNotifyThresholdS": 120,
  "uiCorsOrigins": ["cortexui://localhost"]
}
```

读取文件时会按下表的类型逐键校验。类型不符的键会让整个文件被判为无效：启动时回退到环境变量与默认值，热重载时则保留上一份有效设置。两种情况都会记录原因日志。未知键被忽略。

### 键 {#keys}

| 键 | 类型 | 默认值 | 作用 | 旧环境变量 |
|---|---|---|---|---|
| `turnNotify` | boolean | `true` | 当一个耗时较长的回合结束时，向会话发送一条新消息，让你收到推送通知（内联状态是以编辑方式封口为「✓ 完成」，而 Slack 与飞书都不会对消息编辑推送）。成功和失败都会提醒 | `CORTEX_TURN_NOTIFY` |
| `turnNotifyThresholdS` | number | `60` | 触发上述完成提醒所需的最短回合时长（秒）。更短的回合保持静默 | `CORTEX_TURN_NOTIFY_THRESHOLD_S` |
| `notifyCompaction` | boolean | `true` | 在 agent 的上下文被压缩（compaction）时向会话发送一条提示。覆盖 Claude Code（print 模式）与 pi 两个后端 | `CORTEX_NOTIFY_COMPACTION` |
| `showToolCalls` | boolean | `false` | 在 VirtualMessage 尾部内联渲染工具调用 | `CORTEX_SHOW_TOOL_CALLS` |
| `statusNewqButton` | boolean | `false` | 在状态消息上显示「New (quiet)」按钮（`=!newq`，跳过 pre-close 钩子） | `CORTEX_STATUS_NEWQ_BUTTON` |
| `autoResume` | boolean | `true` | 当用量限制窗口重置后，自动继续被该限制中断的对话，并注入一条提示让其从中断处接着做。设为 `false` 可让被中断的工作保持暂停、由人工继续 | `CORTEX_AUTO_RESUME` |
| `providerRateLimits` | object | `{}` | 按 provider 和额度窗口配置限流策略。Provider 条目通过 `windows` 数组保存 `{ type, label?, enabled, threshold? }`；`threshold` 是大于 `0` 且不超过 `1` 的比率 | — |
| `streamDeltas` | boolean | `true` | 按 token 流式输出助手文本。关闭后每条助手消息整条投递 | `CORTEX_STREAM_DELTAS` |
| `bgContinuation` | boolean | `true` | 后台任务结束时，把其输出续投回会话 | `CORTEX_BG_CONTINUATION` |
| `eventLog` | boolean | `true` | 把事件总线写入按日滚动的 JSONL 事件日志 | `CORTEX_EVENT_LOG` |
| `diskMonitor` | boolean | `true` | 每五分钟检查 `$CORTEX_HOME` 所在文件系统的可用空间，低于 500 MiB 时发送系统通知。设为 `false` 会停止计时器；重新设为 `true` 会立即检查一次 | `CORTEX_DISK_MONITOR` |
| `disableUserContext` | boolean | `false` | 设为 `true` 可停止把 `USER.md` 上下文注入普通直接对话轮次（默认注入） | `CORTEX_DISABLE_USER_CONTEXT` |
| `serverUpdateDisable` | boolean | `false` | 设为 `true` 可禁用服务器自动更新检查（默认开启） | `CORTEX_SERVER_UPDATE_DISABLE` |
| `commissionEnabled` | boolean | `true` | 委托（commission）模式的总开关——以契约锚定的长任务。默认开启：任何会话都能中途进入该模式，既可以由 agent 自己调用 `cortex_commission_start`，也可以由你在输入框的委托胶囊里切换。关掉它会拒绝所有入口（创建、输入框、start webhook）并停止注入契约块；已有委托在看板上仍可查看 | `CORTEX_COMMISSION_ENABLED` |
| `teamEnabled` | boolean | `false` | 实验性的团队模式：任何网页会话都能用 `worker_*` 工具创建并管理持久的 worker 会话。关闭后，下一轮起不再提供这些工具，已有的 worker 变回普通会话。见 [team.md](./team.md) | `CORTEX_TEAM_ENABLED` |
| `hooksLegacy` | boolean | `false` | 绕过钩子注册表，改用固定的内置表构建 Claude 的 hook 设置。参见 [hooks.md](./hooks.md) | `CORTEX_HOOKS_LEGACY` |
| `waitpointSweepMs` | number | `30000` | waitpoint 扫描的间隔（毫秒）：收取落盘的信号（本机以及已连接设备上的）、让逾期的 waitpoint 过期、重试失败的投递。参见 [waitpoints.md](./waitpoints.md) | `CORTEX_WAITPOINT_SWEEP_MS` |
| `waitpointTtlMs` | number | `604800000` | agent 未指定时 waitpoint 的默认存活时长（7 天）。单个 waitpoint 可以要更短，也可以更长但不超过 30 天硬上限；超时后 waitpoint 过期，并会告知 session「什么都没来」 | `CORTEX_WAITPOINT_TTL_MS` |
| `waitpointMaxWakesPerHour` | number | `12` | 单个 waitpoint 每小时唤醒其 session 的次数上限。失控的信号循环会被限流（并只提示一次），而不是刷屏 | `CORTEX_WAITPOINT_MAX_WAKES_PER_HOUR` |
| `injectWaitMaxS` | number | `600` | 一条中途注入的消息等待回复的时长上限（秒），超过即释放 busy 闸门。防止卡死的进程永久占住守护进程的重启闸门 | `CORTEX_INJECT_WAIT_MAX_S` |
| `memoryIndexRegenEnabled` | boolean | `true` | 运行内置实验、知识和模式索引重建；从 `false` 切换为 `true` 时立即执行一次 | — |
| `memoryIndexRegenIntervalMs` | number | `86400000` | 记忆索引重建的执行间隔，单位为整数毫秒 | — |
| `sessionRetentionDays` | number | `30` | 以天为单位的整型保留窗口，必须落在安全范围 `1` 到 `104249991`。保留协调器会在 daemon 启动时于后台启动一轮清理（启动流程不等待它完成），之后每 6 小时运行一次，并在该键热重载后立即再跑一轮；它会清理过期的 session registry 条目、孤儿 `conversation-history`、孤儿 PI transcript bundle、孤儿 Claude capture 日志、孤儿工具图片目录，并同步 Claude 用户设置里的 `cleanupPeriodDays`，同时跳过活跃会话/活跃 capture | — |
| `piCompactReserveTokens` | number | `16384` | 仅 PI 后端：PI 预留的上下文余量，单位 token。上下文超过 `窗口 - reserveTokens` 时 PI 就压缩 —— turn 之间会压，PI 0.84.4 起也会**在 turn 进行中**于工具批次边界压 —— 所以余量越大压缩越早，长 turn 里留下的可用空间越多。取值为 `1024` 到 `131072` 之间的整数。Cortex 把它写进私有 PI agent 目录的 `settings.json`，这也是唯一的入口：PI 没有为它提供 setter | `CORTEX_PI_COMPACT_RESERVE_TOKENS` |
| `maxContextTokens` | number \| null | `null` | 两个后端共用的上下文窗口上限，单位 token：可用窗口取模型自身窗口与该值中较小的一个，各后端在到达它之前压缩。取值为 `100000` 到 `1000000` 之间的整数（即 Claude Code 自身接受的范围），或 `null` 表示每个模型使用自身窗口。Claude 以 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 接收它，优先级高于 Claude 设置文件里的 `autoCompactWindow`；模型窗口超过上限时，PI 在 `上限 - piCompactReserveTokens` 处压缩。上下文占用百分比按截断后的窗口计算 | — |
| `uiCorsOrigins` | string[] | `[]` | Web UI HTTP 宿主为哪些 origin 返回 CORS header。参见 [desktop-app.md](./desktop-app.md) | `CORTEX_UI_CORS_ORIGINS`（逗号分隔） |
| `adminChannel` | string \| null | `null` | 发送系统通知（启动、限流、磁盘告警）的 Slack 频道。第一次给机器人发私信时会被自动探测并持久化到这里 | `SLACK_ADMIN_CHANNEL`，然后 `CORTEX_ADMIN_CHANNEL` |
| `feishuAdminChannel` | string \| null | `null` | 同类通知的飞书 admin `chat_id`（`oc_...`）。与 `adminChannel` 相互独立——Slack 的频道 id 在飞书上不可用 | `FEISHU_ADMIN_CHANNEL` |

Web 工作台可写其中一部分：**设置 → 通知**（`turnNotify`、`autoResume`、`notifyCompaction`）、**设置 → 高级**（`eventLog`、`diskMonitor`、`showToolCalls`、`disableUserContext`、`serverUpdateDisable`、`commissionEnabled`、`teamEnabled`、`sessionRetentionDays`、`maxContextTokens`、`piCompactReserveTokens`，以及内置作业的开关和间隔），以及桌面端/移动端 **Usage** 页面（`providerRateLimits`）。其余键都靠手工编辑该文件。

`providerRateLimits` 是 `settings.json` 中按 provider id 建立的对象。每个 provider 条目可包含 `windows` 数组，数组元素为 `{ type, label?, enabled, threshold? }`。普通额度行以 provider 上报的 `type` 为身份；模型额度行同时使用 `type` 和 provider 上报的精确 `label`。精确窗口策略优先于旧版 provider 级 `enabled`/`threshold` 字段；这些根字段只作为兼容回退，非默认时会在 Usage 中明确显示并可一键清除。

桌面端和移动端 Usage 会分别在每条 5 小时、weekly、含超额 weekly、Codex 主/次窗口及带名称的模型额度行上显示独立控件。省略 `threshold` 时使用该行系统默认值：`seven_day` 与 `seven_day_overage_included` 为 `0.95`，其他窗口为 `0.90`。只显示花费的卡片没有额度控件。模型策略依赖 provider 上报的显示名称；名称变化后旧条目不会再匹配。策略改动只作用于后续额度观测；已经激活的额度窗口或 outage 窗口会保持当前状态，直到自然重置或被手动 **Resume now** 清除。

内置作业间隔必须是 `1000` 到 `2147483647` 之间的整数毫秒，这是 Node timer 的安全范围。启用的作业会在 daemon 启动时执行一次。记忆索引重建不会重叠运行；运行期间修改间隔会在本轮结束后生效。

`sessionRetentionDays` 是 **设置 → 高级** 中唯一的数值型保留控制项。桌面 Web UI 通过与布尔运行时开关相同的 `config.set { section: 'settings' }` 路径写入它，客户端也会执行与服务端相同的上界校验。`piCompactReserveTokens` 在同一张卡片、走同一条写入路径；客户端接受 `1024`–`131072`，与服务端校验一致。Cortex 在创建 PI 会话时把它写进 PI 的私有 `settings.json`，所以新值无需重启即可作用于下一个 PI 会话；已经在池子里的会话仍沿用创建时的余量。

`maxContextTokens` 也在这张卡片里。输入框接受 `100000`–`1000000`；清空后保存为 `null`，即每个模型使用自身窗口。PI 每次判断是否压缩时都会读取这个上限，所以运行中的 PI 会话会立即遵循新值；Claude 在 CLI 进程启动时读取它，所以新值作用于下一个 Claude 会话。固定环境的 CLI 兼容性试运行不会收到它。

这个保留时钟覆盖六类 housekeeping surface：live session-registry 过期删除（先写 `delete-intent`，再写 `delete-commit`）、孤儿 `data/conversation-history/*.jsonl`、`logs/sessions-pi/` 下的孤儿 PI transcript bundle、`logs/sessions/` 下的孤儿 Claude capture 文件、`tmp/tool-images/` 下按会话存放的孤儿图片目录，以及同步后的 Claude 用户 `cleanupPeriodDays` helper。会话既不在用、也不在待删除列表中，且目录在保留窗口内没有变动时，其图片目录会被删除。孤儿 history 与 PI 文件采用两轮确认后才删除。活跃直接会话、运行中的 execution、待响应 interaction/bg-held session、仍在使用的 PI backend session id，以及活跃 Claude capture pair 都会被保护。

registry 过期删除会把所有过期 session 的 delete intent 合并为一次 journal 追加，再以每批 100 个 session 清理并提交，每批无论包含多少 session 都只需三次 registry 追加。daemon 关闭时，正在进行的清理会在批次之间停下；尚未提交删除的 session 保持 pending，由下一轮清理优先完成。

### 热更新 {#hot-reload}

config 目录被监视。`settings.json` 的变更去抖 300 毫秒后重新读取文件，之后一律使用新值——**无需重启守护进程**。有两点值得注意：

- 每个设置在各自的使用点生效：下一个回合、下一次 agent 生成、下一次内置作业运行，或下一个 HTTP 请求。`uiCorsOrigins` 在每个请求时解析；`adminChannel` 与 `feishuAdminChannel` 一变更就推送给正在运行的平台适配器。`diskMonitor=false` 会停止计时器，恢复为 `true` 时会重新启动并立即检查。每个内置作业开关也会立即停止或启动对应计时器，间隔修改会重排下一次空闲运行。
- 坏文件不会打挂服务器。JSON 非法或类型不符时保留上一份设置并记录错误日志；修好文件后，下一次写入即被重新加载。

### 旧环境变量与弃用提示 {#legacy-environment-variables-and-deprecation}

表中列出旧环境变量的键会保留该变量作为回退，并按既定语义解析——`CORTEX_EVENT_LOG=off`、`CORTEX_TURN_NOTIFY=0`/`false`/`off`/`no`、`CORTEX_NOTIFY_COMPACTION=0`/`false`/`off`/`no`，两个 `string[]` 键用逗号分隔的列表，等等。优先级始终是：`settings.json` 中的键 → 旧环境变量 → 内置默认值。`adminChannel` 的优先级链是先看 `SLACK_ADMIN_CHANNEL`，再看 `CORTEX_ADMIN_CHANNEL`。

当某个旧环境变量第一次实际供值时，守护进程会记录一条弃用警告，指明该变量和它喂给的设置项（`Deprecated env <VAR> supplies settings.<key>; move it to settings.json`）。这层回退只为迁移期的兼容而存在——新的配置应写进 `settings.json`。

### 从 .env 自动迁移 {#automatic-migration-out-of-env}

每次守护进程启动、`.env` 加载之后，Cortex 会扫描 `$CORTEX_HOME/config/.env` 中是否存在上表中的旧变量。只要发现至少一个：

1. `.env` 被复制为同目录下的 `.env.bak-<时间戳>`，其中 `<时间戳>` 是把 `:` 和 `.` 替换为 `-` 的 ISO 8601 时刻（例如 `.env.bak-2026-07-30T09-12-33-482Z`）。
2. 每个旧值按其原语义解析后写入 `settings.json`。`settings.json` 中已存在的键绝不被覆盖——文件优先于 `.env`。
3. 被迁移的赋值行从 `.env` 中删除；`.env` 保持原有文件权限，并在头部加上一行注释 `# Legacy server settings migrated to settings.json; secrets remain in .env.`。
4. 同一趟顺带删除死变量 `CORTEX_SERVER_UPDATE_ENABLE`——已经没有任何代码读它。

迁移是幂等的：`.env` 中没有旧变量时原样不动，之后的启动也什么都不做。若任一步失败，错误会被记录，`.env` 保持完整，服务器继续按环境变量回退运行——迁移失败的代价仅仅是那些弃用警告。

### 仍然留在 .env 的内容 {#what-stays-in-env}

有三类变量刻意留在 `.env`：

- **密钥与凭据**——`SLACK_BOT_TOKEN`、`SLACK_SIGNING_SECRET`、`SLACK_APP_TOKEN`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`ANTHROPIC_API_KEY`、`CORTEX_CLIENT_TOKEN`。它们广义上也是设置，但把它们挡在一个 Web UI 可读可写的文件之外，能把影响面压到最小。
- **由子进程消费的变量**——`CORTEX_HOME`、`CORTEX_PROJECTS_DIR`、`WEBHOOK_PORT`、`DEBUG`、`CORTEX_LANG` 以及数据文件覆盖项。钩子、MCP server、CLI 和 `cortex-client` 都继承守护进程的环境；服务器侧的 JSON 文件根本传不到它们那里。
- **启动拓扑**——`CORTEX_PLATFORM`、`CORTEX_MACHINE`、`CORTEX_UI_HTTP`、`CORTEX_UI_PORT`、`CORTEX_UI_SPA_DIR`、`CORTEX_UI_TOKEN_LOGIN`。它们决定启动时存在哪些适配器与监听器，热更新对它们没有意义，结构上就必须重启。

### 与 .claude/settings.json 同名不同物 {#not-the-same-file-as-claudesettingsjson}

`$CORTEX_HOME/config/settings.json`（本文件）配置的是 **Cortex 服务器**。`$CORTEX_HOME/.claude/settings.json` 配置的是 **Claude Code** 的钩子与权限，由 Claude CLI 读取，Cortex 不读它。文件名相同，但目录不同、归属不同、schema 不同——见下一节。

## .claude/settings.json（Claude Code） {#claudesettingsjson-claude-code}

位于 `$CORTEX_HOME/.claude/settings.json`。这是 Cortex 数据根目录下由 Cortex 脚手架生成的 Claude Code 项目设置文件。`cortex init` 会从 `defaults/.claude/settings.json` 为它做一次初始化，之后 Cortex 不会再覆盖这个路径。

但 Claude Code 自己还可能读取 spawn cwd 下更高优先级的项目文件（`.claude/settings.local.json`，然后 `.claude/settings.json`），以及用户设置文件 `$CLAUDE_CONFIG_DIR/settings.json` 或 `~/.claude/settings.json`。Cortex 完全不会脚手架、同步或覆盖这些 cwd 下的项目级 `.claude` 文件；这里说的“从不覆盖”只针对上面这个 `$CORTEX_HOME/.claude/settings.json` 种子路径。

会话保留协调器另有一项独立的 Claude housekeeping 写入：它会用 guarded read-merge-temp-sync-rename 流程，把 `cleanupPeriodDays` 合并到用户设置文件（`$CLAUDE_CONFIG_DIR/settings.json` 或 `~/.claude/settings.json`）里。这个 helper 只拥有那一个键，保留其它所有 Claude 设置原样，不会接管 hooks/permissions 的归属，也不会改任何项目级 `.claude` 文件。

文件遵循 Claude Code 的设置格式，包含 `hooks` 和 `permissions` 部分。钩子系统文档参见 [hooks.md](./hooks.md)。它与 [`config/settings.json`](#configsettingsjson) 中的 Cortex 运行时设置毫无关系。

## defaults/config/ 布局 {#defaultsconfig-layout}

npm 包中的 `agent-server/defaults/` 目录包含随包发布的默认值。多数在 init 期间复制到 `$CORTEX_HOME/`；钩子资产与执行环境还会在服务器每次启动时重新同步：

| 源 | 目标 | 覆盖行为 |
|---|---|---|
| `defaults/AGENTS.md` | `$CORTEX_HOME/AGENTS.md` | 从不 |
| `defaults/gitignore` | `$CORTEX_HOME/.gitignore` | 从不 |
| `defaults/.claude/settings.json` | `$CORTEX_HOME/.claude/settings.json` | 从不——这里只指 `$CORTEX_HOME/.claude/settings.json` 这个脚手架路径；任意仓库内的本地 `.claude/settings.json` 都不在 Cortex 的 copy/sync 回路里 |
| `defaults/config/budget.json` | `$CORTEX_HOME/config/budget.json` | 仅 `--force` |
| `defaults/config/environments/` | `$CORTEX_HOME/config/environments/` | 逐文件 copy-if-missing，init 时与之后每次服务器启动时各执行一次：你尚未拥有的随包执行环境会被拷入；你已有的文件绝不被覆盖——`--force` 对这棵树不生效 |
| `defaults/config/hooks/` | `$CORTEX_HOME/config/hooks/` | 每次服务器启动时逐文件按 CalVer 同步：缺失则添加，发布的 `version` 更新则刷新。没有 `version` 的声明（你自己的）永不被覆盖 |
| `defaults/prompts/` | `$CORTEX_HOME/prompts/` | 逐文件：新文件总是添加，已有文件保留除非 `--force` |
| `defaults/plugins/` | `$CORTEX_HOME/plugins/` | 逐文件：新文件总是添加，已有文件保留除非 `--force` |
| `defaults/rules/` | `$CORTEX_HOME/rules/` | 逐文件：新文件总是添加，已有文件保留除非 `--force` |
| `defaults/hooks/` | `$CORTEX_HOME/hooks/` | init 时逐文件：从不覆盖除非 `--force`。每次服务器启动时，除非已部署文件带有相等或更新的 `@cortex-hook-version`，否则重新复制发布的脚本 |
| `defaults/data/schedules.json` | `$CORTEX_HOME/data/schedules.json` | 从不（除非 `--force`） |
| `defaults/context/` | `$CORTEX_HOME/context/` | 脚手架文件：从不覆盖 |

这种设计意味着 npm 包升级会自动提供新的提示、插件、规则、钩子和执行环境，而不会覆盖用户的自定义内容。整文件型配置（如 `budget.json`）仍需 `--force` 才能替换；`config/environments/` 则改为逐文件合并，新发货的执行环境能到达已有安装，同时不动你的改动。

## 热重载行为 {#hot-reload-behavior}

`config/` 下通过文件监视器热更新的配置，在监视器无法启动或运行期报错时，会自动切换为每 5 秒一次的文件系统快照轮询。每个加载器在轮询模式下沿用其处理文件事件时的校验和失败行为。

- **`config/settings.json`** — 通过文件监视器监视，去抖 300 毫秒。新值在下一个使用点生效，无需重启；文件损坏时保留上一份设置。参见 [config/settings.json](#configsettingsjson)。
- **`schedules.json`** — 通过文件监视器监视。更改在几秒钟内生效，无需重启。完整调度系统参见 [scheduling.md](./scheduling.md)。
- **`profiles.json`** — 缓存在内存中并监视可解析的 JSON 变更。更新会在下一个智能体生成前刷新缓存；JSON 语法损坏时保留上一份配置。
- **`machines.json`** — 监视并在有效变更后重新加载。条目无效时保留上一份机器注册表。
- **`environments/`** — 被监视。变更去抖（300 毫秒）后重载所有执行环境，无需重启。参见[执行环境](#execution-environments)。
- **`.env`** — 需要守护进程重启才能生效（启动时通过 dotenv 加载一次）。过去放在这里的行为设置已迁到 `config/settings.json`，后者不需要重启。
- **钩子声明（`config/hooks/*.json`）** — 注册表在每次智能体生成时重新读取，因此新增的 `agent:*` / `cc:*` / `pi:*` 条目对下一个启动的智能体生效。`cortex:*` 条目在服务器启动时被快照，需重启才生效。参见 [hooks.md](./hooks.md)。
- **钩子脚本（`hooks/*.mjs`）** — 每次钩子调用时重新读取。
- **插件、提示、规则** — 每次智能体会话生成时重新读取。

## 各文件位置 {#where-each-file-lives}

| 文件 | 用途 | 路径 |
|---|---|---|
| `.env` | 环境变量 | `$CORTEX_HOME/config/.env` |
| `settings.json` | 运行时行为设置（热更新） | `$CORTEX_HOME/config/settings.json` |
| `profiles.json` | 智能体配置 | `$CORTEX_HOME/config/profiles.json` |
| `environments/` | 执行环境——每个环境一个 JSON | `$CORTEX_HOME/config/environments/` |
| `machines.json` | 机器注册表 | `$CORTEX_HOME/config/machines.json` |
| `budget.json` | 预算限制 | `$CORTEX_HOME/config/budget.json` |
| `mcp-config.json` | MCP 服务器配置 | `$CORTEX_HOME/config/mcp-config.json` |
| `.claude/settings.json` | Claude Code 钩子/权限（不是 Cortex 的设置文件） | `$CORTEX_HOME/.claude/settings.json` |
| `mode.json` | 运行时模式 | `$CORTEX_HOME/data/mode.json` |
| `schedules.json` | 定时任务 | `$CORTEX_HOME/data/schedules.json` |
| `session-registry.jsonl` | 仅追加的 session registry 日志 | `$CORTEX_HOME/data/session-registry.jsonl` |
| `retention-candidates.json` | 两轮确认的孤儿清理候选表 | `$CORTEX_HOME/data/retention-candidates.json` |
| `conversation-history/` | 按会话分文件的 transcript/history JSONL | `$CORTEX_HOME/data/conversation-history/` |
| `logs/sessions/` | Claude capture 日志 | `$CORTEX_HOME/logs/sessions/` |
| `logs/sessions-pi/` | PI transcript bundle | `$CORTEX_HOME/logs/sessions-pi/` |
| `hooks/*.json` | 钩子声明 | `$CORTEX_HOME/config/hooks/` |
