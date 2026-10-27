# 配置 {#configuration}

Cortex 从 `$CORTEX_HOME/config/` 读取配置。消息平台接入是可选的：网页和 App 会话可以在没有 Slack 或飞书机器人的情况下运行。每个启用的消息平台需要自己的凭据。

## 文件层次结构 {#file-hierarchy}

以下所有路径均相对于 `$CORTEX_HOME`（默认：`~/.cortex/`）。

```
$CORTEX_HOME/
├── AGENTS.md                     # 智能体会话的根指令（仅脚手架生成一次）
├── config/
│   ├── .env                      # 密钥、平台凭据、启动变量
│   ├── settings.json             # 运行时行为设置（热更新）
│   ├── preferences.json          # 系统消息的界面语言（`!lang`）
│   ├── models.json             # 默认引擎与收藏模型
│   ├── environments/             # 执行环境——每个环境一个 JSON
│   ├── machines.json             # 远程客户端机器注册表
│   ├── budget.json               # 每日/每月预算限制
│   ├── mcp-config*.json          # 生成的 MCP 配置，每次启动时重写
│   ├── board.css                 # 可选，所有看板的样式表（默认不存在）
│   ├── agents/                   # 你的子智能体角色及对内置角色的覆盖
│   ├── archive/                  # 升级时退役的配置，移到此处保留
│   └── hooks/                    # 你的钩子声明及对内置声明的覆盖
├── data/
│   ├── agent-state.json          # 频道引擎选择、模型记忆、新会话选择、默认智能体
│   ├── schedules.json            # 持久化的定时任务列表
│   ├── boards.json               # 看板注册表
│   ├── executions.json           # 统一执行注册表
│   ├── costs.jsonl               # 90 天滚动费用记录
│   ├── provider-state.json       # provider 用量、限流窗口、恢复队列
│   ├── waitpoints.json           # 已布设与已解决的 waitpoint
│   ├── session-registry.jsonl    # 会话记录、频道绑定、对话头与轮次（唯一所有者）
│   ├── retention-candidates.json # 两轮确认的孤儿保留标记
│   ├── ui-sessions.json          # Web UI 的浏览器登录会话
│   ├── conversation-history/     # 按会话分文件的 transcript/history JSONL
│   ├── archive/                  # 超过一周的已终结执行记录
│   ├── claude/                   # Cortex 自己的 Claude Code 配置目录（CLAUDE_CONFIG_DIR）
│   └── pi/                       # Cortex 的 PI agent 目录
├── .claude/
│   └── settings.json             # Cortex 脚手架生成的 Claude Code 项目设置
├── hooks/                        # 你的钩子脚本（.mjs）
├── plugins/                      # 你的插件，以及你在内置插件上的用户层
├── prompts/                      # 你的系统提示、指令、模板
├── rules/                        # 你为智能体会话写的上下文规则
├── context/                      # Dense Context 知识库
│   └── projects/                 # 研究项目文件
├── logs/                         # 守护进程和后端会话日志
│   ├── events/                   # 按日的事件总线 JSONL（`eventLog` 设置）
│   ├── sessions/                 # Claude capture 日志
│   └── sessions-pi/              # PI transcript bundle
├── tmp/                          # 临时工作区、落盘的信号、工具图片
└── workspaces/                   # 干净模式工作区，每个干净会话或子智能体一个文件夹
```

网关配置默认为 `~/.aistatus/gateway.yaml`，由 `cortex setup-gateway` 和 provider 登录写入。设置 `CORTEX_GATEWAY_HOME` 的实例使用 `<CORTEX_GATEWAY_HOME>/.aistatus/gateway.yaml`，见[本地模型网关](#local-model-gateway)。

## 加载顺序和优先级 {#loading-order-and-precedence}

1. **内置默认值**（`agent-server/defaults/`）随 npm 包一起发布，为每个配置文件提供回退值。内置的插件、钩子、规则、子智能体角色与系统提示词直接从这里原地读取，`$CORTEX_HOME` 中你的文件叠加在它们之上（见[内置资源与你的覆盖](#built-in-assets-and-your-overrides)）。
2. **`$CORTEX_HOME/config/.env`** 在守护进程启动时通过 `dotenv` 加载。启动环境中已有的变量优先于文件，worker 继承 daemon 的环境。
3. **`$CORTEX_HOME/config/settings.json`** 保存运行时行为设置。它被缓存，文件变化时重新读取，每个设置在各自的使用点生效。对它定义的每个键，它的优先级高于同一设置的旧环境变量。
4. **`$CORTEX_HOME/config/models.json`** 缓存并监视文件变化，用于读取默认引擎与收藏模型。
5. **`$CORTEX_HOME/.claude/settings.json`** 是 Cortex 脚手架生成的 Claude Code 项目设置文件。Claude Code 还可能读取 `<spawn cwd>/.claude/settings.local.json`、`<spawn cwd>/.claude/settings.json`，以及它的用户设置文件；对 Cortex 启动的每个 `claude`，这个文件是 `$CORTEX_HOME/data/claude/settings.json`（见 [Claude Code 配置目录](#claude-code-config-directory)）。终端的 `~/.claude/settings.json` 不会被读取。

`.env` 文件支持标准的 `KEY=VALUE` 语法和 `#` 注释。已在 shell 中设置的环境变量优先于 `.env` 文件（dotenv 默认行为）。

## Web UI 中的平台设置 {#platform-settings-in-the-web-ui}

浏览器、桌面 App 和手机 App 的 **设置 → 平台** 提供飞书/Lark 和 Slack 接入表单。启用平台、填写必填凭据后保存。密钥只写不回显：留空保留已保存值，输入新值即替换，**清除已保存值** 则显式地把清除排入下次保存。关闭平台会保留凭据。凭据仅可通过 HTTPS 或本机回环 API 地址提交；原生 App 的本地 webview origin 并不会让远程 HTTP 服务器变得安全。

配置检查会列出缺失的必填字段；它不测试连接或账号权限。接入配置的改动保存到 `config/.env`，需要**重启 daemon**，仅重启 worker 不够。页面会比较已保存的配置与正在运行的服务器环境，并标记差异。如果重启 daemon 后仍有差异，请检查其启动环境中是否有覆盖的变量。保存不会重启任何进程。

每张卡片还可编辑其通知目标（Slack 对应 `adminChannel`，飞书对应 `feishuAdminChannel`）。这些运行时设置作用于后续通知。留空保存会清除路由；飞书可能会在下一次首次接触的私聊时自动注册目标。

飞书卡片中的 **在网页 / App 会话加载飞书技能** 开关控制 `settings.feishuSkillsInWeb`（默认 `false`）。开启后，`web:` 会话（包括桌面和手机 App 会话）可以加载已分配的 `cortex-feishu` 技能插件。飞书会话保持原有范围；Slack 和 CLI 会话不会获得该插件。新建会话以验证。仍需为 agent 分配插件并完成 `lark-cli` 登录与授权；此设置不改变飞书 MCP 加载，也不授予账号权限。

## 环境变量 {#environment-variables}

所有值从 `$CORTEX_HOME/config/.env` 文件加载。每个变量都是可选的；只有要让某个平台上线时才需要该平台的凭据。

服务器的行为设置属于 [`config/settings.json`](#configsettingsjson)，在那里热更新。这些设置对应的旧变量会作为已弃用的回退被读取，并在下一次守护进程启动时自动从 `.env` 迁出（见[从 .env 自动迁移](#automatic-migration-out-of-env)）。

### 路径 {#paths}

| 变量 | 默认值 | 用途 |
|---|---|---|
| `CORTEX_HOME` | `~/.cortex/` | 用户数据根目录（配置、上下文、日志、存储） |
| `CORTEX_PROJECTS_DIR` | `<CORTEX_HOME>/context/projects/` | 覆盖项目目录 |
| `CORTEX_AGENT_CWD` | `$CORTEX_HOME` | 每个智能体后端进程的工作目录。必须是指向已存在目录的绝对路径；否则服务器在启动时停止 |
| `CORTEX_REPO` | — | 源码 checkout 的 `agent-server/` 目录。守护进程监视其 `src/`，变化时重新构建、重新安装并重启（见[热重建](./architecture.md#hot-rebuild-published-progress-and-the-turn-hold)）；设置该变量期间跳过服务器更新检查 |
| `CORTEX_CLIENT_REPO` | — | 一个 `client/` 源码目录，远程客户端 bundle 从它构建，而不使用打包的 bundle |
| `CORTEX_NPM_PREFIX` | 当前安装的 prefix | Cortex 安装或更新自身时使用的 npm prefix |

### 启动 {#startup}

| 变量 | 默认值 | 用途 |
|---|---|---|
| `CORTEX_MACHINE` | `os.hostname()` | 启动私信的机器标签 |
| `CORTEX_LANG` | `config/preferences.json`，否则 `en` | 系统生成消息的语言（`en` 或 `zh`）。优先于 `!lang` 写入的偏好 |
| `CORTEX_CLIENT_PORT` | `3002` | cortex-client 管理器的 WebSocket 端口 |
| `CORTEX_CLIENT_HOST` | 未指定（所有接口） | 仅控制 cortex-client WebSocket 监听地址；服务器启动时读取 |
| `CORTEX_CLIENT_TOKEN` | 自动生成 | 远程客户端出示的共享密钥；桌面 App 和 Web UI 也接受它，作为配对码之外的另一种方式。由 `cortex init` 和服务器首次启动生成 |
| `CORTEX_WEBHOOK_TOKEN` | 自动生成 | 回环 webhook（钩子回调、`cortex-hook ask`）的 Bearer token。生成方式相同 |

全新 Windows 本机 App 安装会在 `config/.env` 中写入 `CORTEX_CLIENT_HOST=127.0.0.1`。已有安装、普通 CLI 初始化和其他平台保留各自的默认值与配置。需要有意启用局域网直连客户端时，须显式将此变量设为合适的绑定地址（例如 `0.0.0.0` 表示所有 IPv4 接口），并重启服务器。Cortex 不自动配置防火墙策略。此设置不影响 Web UI、TUI 或其他服务器监听端口。

### 本地模型网关 {#local-model-gateway}

| 变量 | 默认值 | 用途 |
|---|---|---|
| `CORTEX_GATEWAY_PORT` | `9880` | 本地模型网关端口，`1`–`65535` 的整数 |
| `CORTEX_GATEWAY_HOME` | OS 用户 home | 网关子进程的独立 home，必须是绝对路径；配置、usage、quota、pricing cache 位于其下 `.aistatus/` |

这两项属于 `$CORTEX_HOME/config/.env` 中的启动设置，不热更新。启动环境优先于文件，CLI 也读取同一文件。空值或非法值会阻止启动；修改后须重启该实例的 daemon。网关启动、健康检查、Claude/PI 路由、usage 查询和 `cortex doctor` 共用这个端口。显式端口也写入生成或更新的 YAML；只改 YAML 的 `port:` 不会改变 Cortex 使用的端口。未显式设置端口时，YAML 合并保留既有字段，Cortex 在 `9880` 启动网关。

同机第二个实例使用不同的 `CORTEX_HOME`，并在配置 provider 或启动前**同时设置**两个网关变量。仅更换 `CORTEX_HOME` 不会隔离网关。所有启用的监听端口都须错开，例如第二实例的 `config/.env`：

```dotenv
CORTEX_GATEWAY_PORT=9881
CORTEX_GATEWAY_HOME=/absolute/path/to/cortex-second/data/gateway-home
WEBHOOK_PORT=3101
CORTEX_CLIENT_PORT=3102
CORTEX_CLIENT_HOST=127.0.0.1
CORTEX_TUI_PORT=3103
CORTEX_UI_HTTP=1
CORTEX_UI_PORT=3104
```

启动该实例及运行其 CLI 时，始终指定 `CORTEX_HOME=/absolute/path/to/cortex-second`。`.env` 中路径须写绝对路径，不展开 `~` 或 `$CORTEX_HOME`。所选端口已有健康网关时会复用它，因此独立网关必须使用不同端口。

为第二实例配置 provider 凭据并运行 `cortex setup-gateway`。网关从自己的 YAML 读取托管 key，或从后端请求接收透传 key，不从独立 home 下的 `~/.claude`、`~/.pi` 读取登录。`CORTEX_GATEWAY_HOME` 只改变网关子进程的 home，不改变 Cortex 的 Claude/PI 凭据位置。尤其是 `~/.pi/agent/` 中的 PI 凭据和自定义 provider 目录仍由使用同一 OS home 的 Cortex 实例共享；如需隔离它们，也要为 Cortex 使用独立 OS home。不要跨实例复制会轮换的 OAuth token，应使用后端登录流程。网关 usage-sharing 偏好也按 home 隔离，需单独配置。既有网关文件和凭据不会自动复制。

### 平台 {#platform}

`CORTEX_PLATFORM` 选择消息平台。它接受单个值（`slack`、`feishu`），也接受**逗号分隔列表**让多个平台同时运行（`slack,feishu`），默认为 `slack`。列出的平台中凭据齐全的会上线，其余跳过，所以完全没有凭据的服务器不带聊天平台运行，只服务 Web UI、桌面 App 和 TUI。除非 `CORTEX_TUI=0`，TUI 网关与每个平台并行运行。多平台时消息按平台路由，系统通知扇出到各平台的 admin channel。

| 变量 | 必需 | 用途 |
|---|---|---|
| `CORTEX_PLATFORM` | 否 | `slack`（默认）。多平台填逗号列表，如 `slack,feishu` |
| `SLACK_BOT_TOKEN` | slack 需要 | Slack Bot OAuth 令牌（`xoxb-...`） |
| `SLACK_SIGNING_SECRET` | slack 需要 | Slack 应用签名密钥 |
| `SLACK_APP_TOKEN` | slack 需要 | Socket Mode 的 Slack 应用级令牌（`xapp-...`） |
| `FEISHU_APP_ID` | feishu 需要 | 飞书应用 ID（`cli_...`） |
| `FEISHU_APP_SECRET` | feishu 需要 | 飞书应用密钥 |
| `FEISHU_ENCRYPT_KEY` | 否 | 飞书事件加密密钥（长连接模式下可选） |
| `FEISHU_VERIFICATION_TOKEN` | 否 | 飞书事件验证令牌（可选） |
| `FEISHU_DOMAIN` | 否 | `feishu`（默认）或国际版 `lark` |
| `FEISHU_AUTH_MODE` | 否 | `bot`（默认）或 `user`。`cortex feishu login` 会设为 `user`，于是飞书文档工具以登录用户的身份操作 |
| `FEISHU_USER_SCOPE` | 否 | 未提供 `--scope` 时 `cortex feishu login` 申请的 scope |
| `FEISHU_REDIRECT_URI` | 否 | `cortex feishu login --manual` 使用的重定向 URI |

发送系统通知的 admin channel 是设置项而非环境变量：见 [`config/settings.json`](#configsettingsjson) 中的 `adminChannel` 与 `feishuAdminChannel`。旧变量 `SLACK_ADMIN_CHANNEL`、`CORTEX_ADMIN_CHANNEL`、`FEISHU_ADMIN_CHANNEL` 仍作为已弃用的回退被读取。

### API {#api}

| 变量 | 用途 |
|---|---|
| `ANTHROPIC_API_KEY` | Claude Code 在计量（`api`）路由上运行时使用的 Anthropic API 密钥 |
| `ANTHROPIC_BASE_URL` | 本地网关宕机时 Claude Code 运行使用的 Anthropic endpoint。网关正常时，每次运行的 base URL 是其网关路由 |

### Web UI 与 TUI {#web-ui-and-tui}

Web UI 宿主服务浏览器工作台、桌面 App 和手机 App。[浏览器访问](./browser-access.md)详细介绍 token 登录、配对码与 Cloudflare Access。

| 变量 | 默认值 | 用途 |
|---|---|---|
| `CORTEX_UI_HTTP` | 关 | `1`、`true`、`on` 或 `yes` 启动 Web UI 宿主。`cortex ui enable` 会设置它 |
| `CORTEX_UI_PORT` | `3004` | Web UI 宿主的端口，绑定到 `127.0.0.1` |
| `CORTEX_UI_SPA_DIR` | 打包的 `web/dist` | 宿主所服务的 web app 目录 |
| `CORTEX_UI_TOKEN_LOGIN` | 开 | 用客户端 token 或配对码进行浏览器登录，以及用一次性配对码配对应用。`0`、`false`、`off` 或 `no` 会移除登录与配对路由；已配对的应用继续可用 |
| `CORTEX_UI_SESSION_TTL_DAYS` | `30` | 浏览器登录会话的有效期（天） |
| `CORTEX_ACCESS_TEAM_DOMAIN`, `CORTEX_ACCESS_AUD`, `CORTEX_ACCESS_CERTS_URL` | — | 面向浏览器的 Cloudflare Access JWT 校验；需要前两个都设置才启用 |
| `CORTEX_PORT_FORWARD` | 开 | `0` 禁用 Web UI 到远程机器的端口转发 |
| `CORTEX_TUI` | 开 | `0` 停止 TUI 网关 |
| `CORTEX_TUI_PORT` | `3003` | TUI 网关的端口，也是 `cortex tui` 连接的端口 |

### 速率限制（Slack） {#rate-limiting-slack}

| 变量 | 默认值 | 用途 |
|---|---|---|
| `CORTEX_SLACK_RL_GLOBAL_CAPACITY` | `20` | 全局 API 调用令牌桶容量 |
| `CORTEX_SLACK_RL_GLOBAL_REFILL_PER_SEC` | `1` | 全局每秒补充速率 |
| `CORTEX_SLACK_RL_CHANNEL_CAPACITY` | `1` | 每频道令牌桶容量 |
| `CORTEX_SLACK_RL_CHANNEL_REFILL_PER_SEC` | `1` | 每频道每秒补充速率 |

### Webhook {#webhook}

| 变量 | 默认值 | 用途 |
|---|---|---|
| `WEBHOOK_PORT` | `3001` | 回环 webhook 服务器的端口，接收钩子、waitpoint、子智能体和看板回调 |

### 数据文件覆盖 {#data-file-overrides}

| 变量 | 默认值 | 用途 |
|---|---|---|
| `CORTEX_EXECUTIONS_FILE` | `<STORE_DIR>/executions.json` | 执行记录 |
| `CORTEX_COSTS_FILE` | `<STORE_DIR>/costs.jsonl` | 费用追踪 |
| `CORTEX_BUDGET_FILE` | `<CONFIG_DIR>/budget.json` | 预算配置 |
| `CORTEX_SESSION_TOTALS_FILE` | `<STORE_DIR>/session-totals.json` | 从已归档执行中结转的每会话费用与 token 总计 |

`<STORE_DIR>` 是 `$CORTEX_HOME/data`，`<CONFIG_DIR>` 是 `$CORTEX_HOME/config`。

### 遥测 {#telemetry}

| 变量 | 默认值 | 用途 |
|---|---|---|
| `CORTEX_TELEMETRY` | — | `0` 关闭匿名遥测，无论 `telemetryEnabled` 如何设置。`1` 允许从源码目录运行的服务端发送遥测，并标记为 `dev`。见[遥测](./telemetry.md) |
| `DO_NOT_TRACK` | — | 设为空值、`0`、`false`、`no`、`off` 以外的任何值时关闭遥测，效果同 `CORTEX_TELEMETRY=0` |

### 调优与调试 {#tuning-and-debugging}

| 变量 | 默认值 | 用途 |
|---|---|---|
| `DEBUG` | — | 启用服务器全局调试模式。除调试级日志外，桌面端 transcript 会提供 hover 检查器，用于查看发送给 agent 的确切消息，以及每次工具调用的完整输入/结果。仅 `DEBUG=1` 启用，其他值均关闭。**设置 → 高级 → 诊断** 中显示其是否开启；修改后需重启 agent-server |
| `CORTEX_DEBUG_TOOL_WARNING_CHARS` | `10000` | DEBUG transcript 中，若格式化后的完整参数与完整结果之和严格超过该 Unicode 字符数，则将工具名称 badge 标为琥珀色。仅接受正整数，非法值使用默认值。修改后需重启 agent-server |
| `CORTEX_BG_GRACE_S` | `90` | 后端报告已完成但从未宣告的后台任务，运行会等待它的秒数（见[后端如何工作](./backends.md#how-backends-work)） |
| `CORTEX_BG_WAIT_MAX_S` | `1800` | 一轮等待仍在运行的后台工作的秒数，超过即停止等待；工作本身继续 |
| `CORTEX_STREAM_DELTA_MS` | `120` | 流式助手文本的刷新间隔（毫秒） |
| `CORTEX_AGENT_BROWSER_BIN` | 随附的二进制 | `cortex-browser` 运行的 agent-browser 二进制（见 [Agent 浏览器](./agent-browser.md)）。路径不存在时直接报错 |
| `CORTEX_BROWSER_BINARY` | 自动检测 | 服务器上 agent 浏览器使用的 Chrome 或 Chromium 二进制 |
| `CORTEX_BROWSER_DISPLAY` | 自动检测 | 服务器上 agent 浏览器使用的 X display，跳过 display 检测 |
| `CORTEX_GPU_MONITOR_MOCK` | — | 用于测试的模拟 GPU 数据 JSON（覆盖真实的 nvidia-smi 查询） |

事件日志、工具调用渲染、用户上下文注入、更新检查、压缩提示、回合完成提醒与自动恢复这些开关是设置项——见 [`config/settings.json`](#configsettingsjson)。

`DEBUG` 会把未截断的 prompt、工具参数和工具结果持久化到各会话的 conversation-history 文件中。这些内容可能包含密钥、私有文件内容或体积很大的输出，存储占用也按完整内容增长。仅应在可信的开发服务器上启用，检查完成后及时关闭。关闭后 transcript 响应会立即去掉调试字段和按钮，但此前已记录的内容不会被删除。

## models.json {#modelsjson}

位于 `$CORTEX_HOME/config/models.json`，保存默认引擎选择和收藏模型列表。**设置 → 模型** 管理默认模型与收藏；输入框的完整模型列表也可以用星标收藏或取消收藏。后端详情见 [backends.md](./backends.md)。

### 模式 {#schema}

```json
{
  "default": {
    "backend": "claude",
    "provider": null,
    "model": "opus",
    "thinking": "high",
    "mode": "plan"
  },
  "favorites": [
    { "backend": "claude", "provider": null, "model": "opus" },
    { "backend": "pi", "provider": "deepseek", "model": "deepseek-v4-pro" }
  ]
}
```

### 字段 {#fields}

| 字段 | 类型 | 必需 | 描述 |
|---|---|---|---|
| `default` | object | 是 | 会话与频道都没有选择时使用的完整引擎选择 |
| `default.backend` | string | 是 | `claude` 或 `pi` |
| `default.provider` | string 或 null | 是 | Claude 为 `null`；PI 必须指定 provider id，例如 `openai-codex`、`deepseek` 或[自定义 provider](./backends.md#custom-providers) |
| `default.model` | string | 是 | 非空模型标识符，按后端命名 |
| `default.thinking` | string 或 null | 是 | 后端原生思考档位；`null` 使用后端默认值 |
| `default.mode` | string | 是 | 网关路由，例如 Claude 的 `plan` 或 `api`；PI 使用 provider 名称 |
| `favorites` | object[] | 是 | 按顺序存放模型引用，每项包含 `backend`、`provider`、`model`。同一模型身份最多出现一次 |

收藏只保存模型身份，不保存思考档位或路由。默认模型不必在收藏中，收藏列表也可以为空。Claude 的 `thinking` 接受 `low`/`medium`/`high`/`xhigh`/`max`；PI 接受 `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`。

### 引擎选择解析 {#selection-resolution}

普通回合依次使用会话记录的选择、`data/agent-state.json` 中的频道选择、`models.json` 的 `default`。显式运行请求（例如定时触发）可以直接提供完整选择。每个选择包含 `backend`、`provider`、`model`、`thinking` 和 `mode`；执行环境与此相互独立。

`data/agent-state.json` 保存 `channelSelections`、按模型的 `modelMemory`（`thinking` 和 `mode`，键为 JSON 数组 `[backend, provider, model]`），以及用于新建 Web 对话的上次引擎选择 `selectionDefault`。选择模型时恢复其记住的思考档位与路由。没有记忆时，thinking 为 `null`；Claude 使用 `gateway.yaml` 中第一条 Anthropic 路由（未声明时用 `plan`），PI 使用 provider 名称。用户修改选择时会更新这份记忆。参见[按会话控制](./backends.md#per-session-model-thinking-level-and-route)。

`!backend <claude|pi>` 在配置的默认选择属于目标后端时使用它，否则使用该后端的第一个收藏及其记住的设置。两者都没有时，需要先收藏该后端的一个模型。

### 验证规则 {#validation-rules}

`mode` 和 PI 的 `provider` 必须匹配 `^[a-zA-Z0-9_-]+$`。Claude 的 provider 必须为 null。Thinking 必须为 null 或后端允许的值，收藏中的模型身份不能重复。写入选择时，若 `gateway.yaml` 可用，会据此校验路由。能解析但未通过 schema 校验的文件会被整体拒绝，直到修正。

## 执行环境 {#execution-environments}

执行环境决定一次对话除了"用哪个模型"之外的跑法：系统提示、内置工具列表、加载哪些插件、会话拿到哪些 Cortex MCP 工具，以及带上多少环境上下文（规则、钩子、项目块、后端自己的 skill）。每个执行环境是一个文件 `config/environments/<name>.json`，文件名就是它的名字。

Cortex 随包提供两个：

| 执行环境 | 用途 |
|---|---|
| `main` | 通用工作，使用会话选定的引擎，加载内置的 Cortex 系统、看板与飞书插件。它是默认环境：没选过执行环境的会话都跑在 `main` 里，且 `main` 不能删除 |
| `creative` | 用于写作、图像提示词、起名与文案的干净环境，运营性上下文全部剥掉（见[最小工具面](#a-minimal-surface)） |

随包文件在 `cortex init` 时拷入 `config/environments/`，之后每次服务器启动时，缺失的文件会再补上（sealed home，即设置了 `CORTEX_CONFIG_IMMUTABLE=1` 时，跳过启动时的这次拷贝）。你已有的文件绝不被覆盖，所以你的改动在升级后依然保留；你自己新增的文件也和其他执行环境一样。目录变更约 300 毫秒后生效，无需重启。不是合法 JSON、或 `name` 与文件名不一致的文件会被跳过并记录日志。

### 字段 {#environment-fields}

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 必须等于去掉 `.json` 的文件名 |
| `description` | string | 否 | 一行用途说明，显示在选择器里 |
| `directive` | string | 否 | 前置到提示前面的角色或身份说明 |
| `systemPrompt` | string | 否 | 替换后端默认的系统提示 |
| `promptTemplate` | string | 否 | 包裹每条消息；`{{input}}` 代表发送的内容 |
| `claudeAgent` | string | 否 | Claude Code 的 agent 名称，以 `--agent` 传入。仅 Claude |
| `outputStyle` | string | 否 | Claude Code 的输出风格。仅 Claude |
| `tools` | string | 否 | 逗号分隔的内置工具列表，替换后端的默认工具集 |
| `pluginDirs` | string[] | 否 | 要加载的插件目录，非绝对路径时相对于 `$CORTEX_HOME`。它们按列出的顺序最先加载，随后是内置插件 |
| `disabledPlugins` | string[] | 否 | 该执行环境不加载的内置插件 id。其余内置插件都会加载；`skills` 为 `false` 时只加载 `pluginDirs` |
| `mcpComposition` | `"direct"` \| `"none"` | 否 | `direct`（默认）让会话拿到 Cortex MCP 工具；`none` 不给任何 MCP，插件里的 server 也不给 |
| `mcpToolAllowlist` | string[] | 否 | 把 Cortex MCP 工具收窄到所列名字。缺省时保留完整工具面 |
| `loadRules` | boolean | 否 | 默认 `true`：前置 `rules/` 中的全局规则 |
| `disableHooks` | boolean | 否 | 默认 `false`。`true` 时会话不运行生命周期钩子 |
| `skills` | boolean | 否 | 默认 `true`。`false` 移除后端的 skill 层，连 `Skill` 工具一起拿掉 |
| `settingSources` | string[] | 否 | 读取哪些 Claude 设置文件：`user`、`project`、`local` 任选。缺省时用 CLI 默认值；`[]` 一个都不读 |
| `projectContext` | boolean | 否 | 默认 `true`：在会话第一轮告诉它属于哪个项目 |

三个提示字段都可以写成 `file:<name>` 而不是字面文本。文本分别从 `prompts/directives/`、`prompts/systemPrompts/`、`prompts/promptTemplates/` 读取，`$CORTEX_HOME` 中没有该文件时读取同名的内置提示词；随包的 `main` 用的是 `"systemPrompt": "file:direct.md"`。schema 不认识的字段、缺失的提示文件或缺失的插件目录只会报警告，执行环境照常加载。

### 插件与环境面板 {#plugins-and-the-environments-panel}

插件挂在执行环境上。执行环境的会话加载其 `pluginDirs` 列出的插件，以及 `disabledPlugins` 未列出的所有内置插件；执行环境的 **插件** 标签页写的就是这两个字段，**设置 → 插件** 则显示每个已安装插件被哪些执行环境使用（见[技能与插件](./skills-and-plugins.md#assigning-plugins)）。

在 Web 工作台和桌面 App 中，**设置 → 环境** 列出所有执行环境，一次编辑一个：带实时校验的 JSON 正文、显示错误与警告的 **校验** 标签页，以及管理插件集合的 **插件** 标签页。新建的执行环境从一个本身就能通过校验的骨架开始，已有的可以换个名字复制一份。错误会阻止保存，警告不会；如果文件在你编辑期间已在磁盘上被改动，保存会被拒绝而不是覆盖它。编辑一个仍与随包默认值相同的执行环境时会先给出警告，因为从此它将停止跟随随包版本。`main` 不能删除。Android 的设置页把 **环境** 显示为仅限桌面端的条目。

**系统提示词** 标签页编辑执行环境 `systemPrompt` 解析出的文本，这段文本会整体替换后端默认的系统提示词。字段是 `file:` 引用时，标签页编辑 `prompts/systemPrompts/` 下的那个文件，并列出引用同一文件的其他执行环境，因为一次保存会同时改变它们的提示词。字段是字面文本或未设置时，保存会把文本写入 `prompts/systemPrompts/<name>.md` 并让执行环境指向它。留空则执行环境使用后端默认提示词。随 Cortex 一起提供的提示词文件在你保存自己的版本之前显示内置文本；你的版本写入 `prompts/systemPrompts/` 并代替内置版本使用。**恢复默认** 会把内置文本载入编辑框，保存后即删除你的版本。新会话使用保存后的提示词。已在 PI 后端上打开的会话从下一轮开始使用它；Claude Code 上的会话则保持原提示词，直到其后端进程重启。

## 执行环境与引擎选择 {#environments-and-engine-selection}

引擎选择决定 backend、provider、model、thinking 和 mode。**执行环境**决定提示、工具、插件、MCP 面与环境上下文。两者独立：`!model <id>` 只换模型，`!agent <name>` 只换环境；`!agent reset` 也保留引擎选择。

### 按对话选执行环境 {#choosing-an-environment-per-conversation}

执行环境按对话选择；没有选择时使用全局默认。

| 命令 | 作用 |
|---|---|
| `!agent` | 显示本对话的执行环境、它回退到的全局默认，以及可选列表——Slack 与飞书上是按钮 |
| `!agent <name>` | 让**本对话**从下一轮起跑在 `<name>` 里 |
| `!agent reset` | 把本对话交还给全局默认。`clear`、`off`、`none`、`disable` 同义 |
| `!agent global <name>` | 设置全局默认：所有没自己选过的对话跑哪个 |
| `!agent global off` | 清除全局默认，回到 `main` |

所有不带前缀的形式都只作用于输入它的对话；只有显式的 `global` 前缀才会动全局默认。

在 Web App 和桌面客户端里，同一个选择是输入框自己的控件：一枚独立的胶囊，紧挨在引擎胶囊左侧——先说在哪里跑，再说用什么跑。它显示本对话所在的执行环境；本对话没选过时，显示它回退到的全局默认，并以灰色呈现，好让“自己选的”和“回退到的”一眼可分。点开是一个平铺列表：一行 `default` 表示“跟随全局默认”，下面是本机声明的每个执行环境，各自标注用途。只声明一个执行环境的主机不显示这枚胶囊——没有可选的余地。新对话里的选择随第一条消息一起提交；进行中的对话立即应用，从下一轮开始生效。

一轮对话按这条链解析自己的执行环境：会话自己的选择 → 所在对话的 → 全局默认 → `main`。已经无法解析的名字（执行环境被改名或删除）会被跳过。

切换环境不改变后端，在下一轮生效且保留历史，因此模型会看到上一个环境产生的回合；需要全新上下文时使用 `!new`。

### 最小工具面 {#a-minimal-surface}

随包提供的 `creative` 是 Cortex 内置最小的环境——写作、图像提示词、起名、文案，运营性上下文全部剥掉：

```json
{
  "name": "creative",
  "description": "Clean-room creative environment: writing, image prompts, naming, copy. No skills, no project rules, minimal tools.",
  "promptTemplate": "{{input}}",
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

三个内置工具，没有 Cortex 插件、没有环境规则、没有钩子、没有项目块，MCP 面正好三个工具：`send_file` 和 `send_view` 负责交付，`cortex_ask_user` 负责发问。用它开的会话被问到自己能看到什么时，报的是三个工具、零个 skill。

`mcpToolAllowlist` 是上界，不是要求。它把会话的 MCP 面收窄到所列的名字；某个名字在会话所在的 surface 上本来就没有组装，那它在那里就只是不存在。所以同一份列表到处都能用：这个 `creative` 在 Web 与桌面 App 保留三个工具，在 Slack 与飞书只剩 `cortex_ask_user`（它们的文件交付是另一个工具，本列表没写）。而一个在本机任何 bundle 里都不存在的名字仍然会在 spawn 时被拒绝——那是拼写错误，不是 surface。

### 干净模式 {#clean-mode}

干净对话在一个自己的文件夹里工作，碰不到 Cortex 知道的东西：适合要第二意见、只该看到递给它的材料的审阅者，或者必须从零开始的任务。

Web 与桌面 App、以及手机上，新对话的输入框里有一枚**干净**开关胶囊。每个新对话都默认关闭；打开后，对话从第一条消息起就是干净的，并在整个生命周期内保持。干净对话会在开关原来的位置保留这个标记（手机上在标题栏），点开可以看到工作区路径并复制，桌面 App 里还能直接打开该文件夹。

对话开始时，Cortex 创建它的工作区 `$CORTEX_HOME/workspaces/<id>/`——取会话 id 的前八个字符，同名文件夹已存在时加数字后缀——并在其中建 `inputs/` 文件夹。每一轮里，工作区都是智能体的工作目录。干净会话：

- 不从工作区或其祖先目录加载任何 `AGENTS.md` 或 `CLAUDE.md`。Claude 运行时不带 `project` 设置源：没有声明 `settingSources` 的执行环境得到 `user,local`，声明了列表的则保留该列表、去掉 `project`。PI 不加载任何上下文文件；
- 不加载 Cortex 规则，也不运行智能体钩子；
- 不会收到 `[Session Project]`、`[Session Transcripts]` 或 `[Board]` 块；
- 在 Claude 上，系统提示词里没有 git 状态和 git 说明（`includeGitInstructions: false`），所以存放 `$CORTEX_HOME` 的仓库不会把它的分支和最近提交暴露给智能体。

执行环境给它的其余一切照旧：系统提示词与 directive、工具、skill、MCP 工具、用户画像和团队块。系统提示词之后还会附上一段**工作区（Workspace）**说明：智能体默认只在工作区内读写；用户为当前任务明确授权的外部文件或目录也可访问，但须限于授权的路径和操作，外部写入须有写入授权。路径仅出现在任务、报错或配置文件中不代表授权。草稿文件放在工作区的 `tmp/` 里；需要尚未授权的外部路径时，先请求许可。这段文字随包发布为 `defaults/prompts/clean-workspace.md`；你的 `prompts/clean-workspace.md` 会替换它，其中 `{{workspace}}` 代表工作区的绝对路径。

发到干净对话里的附件会以原名复制进 `inputs/`，智能体拿到的是这些副本的路径。干净模式把 Cortex 上下文挡在会话之外，并要求智能体只访问允许的路径；它不在操作系统层面把智能体关起来。工作区从不删除——保留期清理删掉旧会话时，它的工作区原样保留，因为里面可能有智能体的产出。

子智能体也能以同样的方式干净运行，见[子智能体](./backends.md#subagents)。

### `pluginDirs` 之外的 skill {#skills-outside-plugindirs}

`pluginDirs` 并不是 skill 层的全部。无论 Cortex 传什么，Claude Code 每次 spawn 都会加载它自己的那一份：其设置文件里启用的 plugin（安装在 Cortex 的 Claude 配置目录 `$CORTEX_HOME/data/claude` 下）、`$CORTEX_HOME/data/claude/skills/` 下的内容，以及 CLI 的内置 skill。有两个执行环境字段能够到它们。`settingSources: []` 让设置文件根本不被读取，于是启用的 plugin 带来的 skill 随之消失；`skills: false` 直接移除整层，内置的也不剩，连 `Skill` 工具一起拿掉。两个都设的执行环境看不到任何 skill 和斜杠命令。

## config/settings.json {#configsettingsjson}

位于 `$CORTEX_HOME/config/settings.json`。该文件保存服务器的**运行时行为设置**：开关、上限和通知路由。编辑这个文件无需重启守护进程即可生效，只有少数在启动时读取一次的键除外，表中已标出。

它是一个扁平 JSON 对象，**只存放你显式覆盖的键**。没写的键在存在旧环境变量时先回退到该变量，再回退到内置默认值。文件本身是可选的——全新安装没有这个文件，完全按默认值运行。它会在第一次被写入时创建：下文的启动迁移、admin channel 自动探测，或 Web 工作台的设置面板。

```json
{
  "turnNotify": false,
  "turnNotifyThresholdS": 120,
  "uiCorsOrigins": ["cortexui://localhost"]
}
```

读取文件时会按下面的 schema 校验取值。JSON 类型不符、或取值超出文档范围（作业间隔、`sessionRetentionDays`、`piCompactReserveTokens`、`maxContextTokens`、`cacheKeepWarmHours`、`providerRateLimits` 的结构）的键会让整个文件被拒绝：启动时 Cortex 回退到环境变量与默认值，热重载时则保留上一份有效设置。两种情况都会记录原因日志。未知键被忽略。

### 键 {#keys}

| 键 | 类型 | 默认值 | 作用 | 旧环境变量 |
|---|---|---|---|---|
| `turnNotify` | boolean | `true` | 当一个耗时较长的回合结束时，向会话发送一条新消息，让你收到推送通知（内联状态是以编辑方式封口为「✓ Done」，而 Slack 与飞书都不会对消息编辑推送）。成功和失败都会提醒 | `CORTEX_TURN_NOTIFY` |
| `turnNotifyThresholdS` | number | `60` | 触发上述完成提醒所需的最短回合时长（秒）。更短的回合保持静默 | `CORTEX_TURN_NOTIFY_THRESHOLD_S` |
| `notifyCompaction` | boolean | `true` | 在 agent 的上下文被压缩时向会话发送一条提示。覆盖 Claude Code（print 模式）与 pi 两个后端 | `CORTEX_NOTIFY_COMPACTION` |
| `showToolCalls` | boolean | `false` | 在 Slack 与飞书的回复中为每次工具调用发一行简短记录，连续调用同一工具时合并为一行。也可在 **设置 → 平台** 中设置 | `CORTEX_SHOW_TOOL_CALLS` |
| `statusNewqButton` | boolean | `false` | 在状态消息上显示「New (quiet)」按钮（`=!newq`，跳过 pre-close 钩子） | `CORTEX_STATUS_NEWQ_BUTTON` |
| `autoResume` | boolean | `true` | 当用量限制窗口重置后，自动继续被该限制中断的对话，并注入一条提示让其从中断处接着做。设为 `false` 可让被中断的工作保持暂停、由人工继续 | `CORTEX_AUTO_RESUME` |
| `providerRateLimits` | object | `{}` | 按 provider 和额度窗口配置限流策略。Provider 条目包含由 `{ type, label?, enabled, threshold? }` 组成的 `windows` 数组；`threshold` 是大于 `0` 且不超过 `1` 的比率 | — |
| `showThinking` | boolean | `true` | 采集模型返回的思考内容，在 Web 和手机聊天中显示。关闭后停止采集新的思考，已保存的行仍可见。Claude 请求思考摘要，PI 显示 provider 返回的文本 | `CORTEX_SHOW_THINKING` |
| `streamDeltas` | boolean | `true` | 按 token 流式输出助手文本和已采集的思考。关闭后只投递完整内容块 | `CORTEX_STREAM_DELTAS` |
| `bgContinuation` | boolean | `true` | 后台任务结束时，把其输出转回会话 | `CORTEX_BG_CONTINUATION` |
| `eventLog` | boolean | `true` | 把事件总线写入按日滚动的 JSONL 事件日志 | `CORTEX_EVENT_LOG` |
| `diskMonitor` | boolean | `true` | 每五分钟检查 `$CORTEX_HOME` 所在文件系统的可用空间，低于 500 MiB 时发送系统通知。`false` 停止计时器；切回 `true` 会立即检查一次 | `CORTEX_DISK_MONITOR` |
| `disableUserContext` | boolean | `false` | 设为 `true` 可停止把 `USER.md` 上下文注入直接对话轮次（默认注入） | `CORTEX_DISABLE_USER_CONTEXT` |
| `serverUpdateDisable` | boolean | `false` | 设为 `true` 可禁用服务器自动更新检查（默认开启） | `CORTEX_SERVER_UPDATE_DISABLE` |
| `serverAutoUpdate` | boolean | `true` | 更新检查发现更新的服务器版本时直接安装，无需询问。安装在没有回合运行时才开始，装完立即重启。`false` 则先请求确认；确认后的更新同样等空闲再安装。已跳过的版本保持跳过 | — |
| `clientHotReloadEnabled` | boolean | `true` | 向运行着不同 bundle 的远程客户端推送服务器的客户端 bundle，让它们自行更新。启动时读取 | — |
| `telemetryEnabled` | boolean | `true` | 发送匿名的崩溃报告和使用统计（见[遥测](./telemetry.md)）。关闭时删除已排队的内容。`CORTEX_TELEMETRY=0` 和 `DO_NOT_TRACK` 优先于它 | — |
| `feishuSkillsInWeb` | boolean | `false` | 允许 `web:` 会话（包括桌面和手机 App 会话）加载已分配的 `cortex-feishu` 技能插件（见 [Web UI 中的平台设置](#platform-settings-in-the-web-ui)） | — |
| `teamEnabled` | boolean | `true` | 实验性的团队模式：任何网页会话都能用 `worker_*` 工具创建并管理持久的 worker 会话。关闭后，下一轮起移除这些工具，已有的 worker 成为普通会话。见 [team.md](./team.md) | `CORTEX_TEAM_ENABLED` |
| `waitpointSweepMs` | number | `30000` | waitpoint 扫描的间隔（毫秒）：收取落盘的信号（本机以及已连接设备上的）、让逾期的 waitpoint 过期、重试失败的投递。参见 [waitpoints.md](./waitpoints.md) | `CORTEX_WAITPOINT_SWEEP_MS` |
| `waitpointTtlMs` | number | `604800000` | agent 未指定时 waitpoint 的默认存活时长（7 天）。单个 waitpoint 可以要更短，也可以更长但不超过 30 天硬上限；超时后 waitpoint 过期，并告知会话什么都没来 | `CORTEX_WAITPOINT_TTL_MS` |
| `waitpointMaxWakesPerHour` | number | `12` | 单个 waitpoint 每小时唤醒其会话的次数上限。失控的信号循环会被限流（并提示一次），而不是刷屏 | `CORTEX_WAITPOINT_MAX_WAKES_PER_HOUR` |
| `injectWaitMaxS` | number | `600` | 一条中途注入的消息等待回复的时长上限（秒），超过即释放 busy 闸门。防止卡死的进程永久占住守护进程的重启闸门 | `CORTEX_INJECT_WAIT_MAX_S` |
| `anthropicSubscriptionModes` | string[] | `["plan"]` | 为用量页面轮询其 Anthropic 账号额度的网关 mode。`[]` 关闭轮询 | — |
| `subscriptionBillingModes` | string[] | `["plan", "openai-codex", "google-gemini-cli", "google-antigravity"]` | 由订阅付费的网关 mode。网关仍为其请求计价，但这些 mode 的用量行只显示额度、不显示费用 | — |
| `providerUsageCollectionEnabled` | boolean | `true` | 运行内置的 provider 用量采集作业，刷新额度与花费读数 | — |
| `providerUsageCollectionIntervalMs` | number | `300000` | provider 用量采集的间隔，单位为整数毫秒 | — |
| `claudeWindowWarmupEnabled` | boolean | `false` | 仅限订阅 mode 下的 Claude（见 `anthropicSubscriptionModes`）。Claude 的 5 小时用量窗口从上一个窗口结束后的第一个请求开始计时。开启后，窗口结束且 10 分钟内没有 Claude 运行时，Cortex 会发一个极小请求（Haiku、不带工具，经 Claude Code、走第一个订阅 mode 的路由）开启下一个窗口，使它在 5 小时后结束，而不是从恢复工作时再算 5 小时。这次请求也让 Claude Code 续期自己的登录，Anthropic 用量读数因此保持最新。窗口结束时间取自 Anthropic 用量读数；预热失败 30 分钟后重试。也可以在 **Settings → Advanced** 中设置 | — |
| `storeArchiveEnabled` | boolean | `true` | 每天一次，把超过一周的已终结执行记录从 `data/executions.json` 移到 `data/archive/`。启动时读取 | — |
| `memoryIndexRegenEnabled` | boolean | `true` | 运行内置的实验/知识/模式索引重建。从 `false` 切换为 `true` 时立即执行一次 | — |
| `memoryIndexRegenIntervalMs` | number | `86400000` | 记忆索引重建的间隔，单位为整数毫秒 | — |
| `sessionRetentionDays` | number | `90` | 以天为单位的安全整数保留窗口（有效范围 `1` 到 `104249991`）。保留协调器在 daemon 启动时于后台启动一轮清理（启动流程不等待它），之后每 6 小时运行一次，并在热重载改动后再跑一轮；它会清理过期的 session registry 条目、孤儿 `conversation-history`、孤儿 PI transcript bundle、孤儿 Claude capture 日志、孤儿工具图片目录，并同步 Claude 用户设置里的 `cleanupPeriodDays`，同时跳过活跃会话/capture | — |
| `piCompactReserveTokens` | number | `16384` | 仅 PI 后端：PI 预留的上下文余量，单位 token。上下文超过 `contextWindow - reserveTokens` 时 PI 就压缩——回合之间会压，PI 0.84.4 起也会*在运行中的回合内*于工具批次边界压——所以余量越大压缩越早，长的工具驱动回合里留下的工作空间越多。取值为 `1024` 到 `131072` 之间的整数。Cortex 把它写进私有 PI agent 目录的 `settings.json`，这是唯一的入口：PI 没有为它提供 setter | `CORTEX_PI_COMPACT_RESERVE_TOKENS` |
| `maxContextTokens` | number \| null | `null` | 两个后端上每个模型可用上下文窗口的上限，单位 token：可用窗口取模型自身窗口与该值中较小者，各后端在到达它之前压缩。取值为 `100000` 到 `1000000` 之间的整数（Claude Code 自身接受的范围），或 `null` 表示每个模型使用自身窗口。Claude 以 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 接收它，优先级高于 Claude 设置文件里的任何 `autoCompactWindow`；模型窗口超过上限时，PI 在 `cap - piCompactReserveTokens` 处压缩。上下文占用百分比按截断后的窗口计算 | — |
| `cacheKeepWarmHours` | number | `6` | 仅限订阅 mode 下的 Claude（见 `anthropicSubscriptionModes`），这类会话的 prompt cache 在最后一次使用后保留一小时。上下文不少于 100k token 的闲置会话只要还在等唤醒（有未结束的 waitpoint、有尚未回报的 worker、有在跑的后台 `agent`），Cortex 就每约 50 分钟读一次它的缓存，免得唤醒时按缓存写入价重新发送整段上下文。每次刷新是在会话的分叉上发一条很短的请求，不改动会话本身；花费约为这段上下文输入价的十分之一，在费用记录里归入 `cache-refresh` trigger。距会话最后一次调用模型超过这么多小时后停止刷新。可能已经过期的缓存不会被刷新（例如上次刷新发生在服务器重启之前），这类会话被唤醒时按冷缓存恢复。`0` 关闭；取值 `0` 到 `24` | — |
| `coldResumeClearToolResults` | boolean | `true` | 仅限 Claude。上下文不少于 100k token 的会话在 prompt cache 过期后（距缓存最后一次使用超过 65 分钟）恢复时，Cortex 先把 transcript 中最近一次压缩之后、除最近 10 次以外的工具调用输出换成一句简短占位，再交给 Claude 重新读取，让这次未命中缓存的请求更小。工具调用、模型回复、你的消息、子 agent 的记录，以及换成占位也不会变短的简短工具输出都保持原样；模型看不到旧的工具输出，需要时会重新调用工具。可清掉的内容不足 40,000 字符时不改动 transcript。占位会一直留在 transcript 中，把对话回退到更早的回合后也是如此 | — |
| `uiCorsOrigins` | string[] | `[]` | Web UI HTTP 宿主为哪些 origin 返回 CORS header。参见 [desktop-app.md](./desktop-app.md) | `CORTEX_UI_CORS_ORIGINS`（逗号分隔） |
| `adminChannel` | string \| null | `null` | 发送系统通知（启动、限流、磁盘告警）的 Slack 频道。第一次给机器人发私信时会被自动探测并持久化到这里 | `SLACK_ADMIN_CHANNEL`，然后 `CORTEX_ADMIN_CHANNEL` |
| `feishuAdminChannel` | string \| null | `null` | 同类通知的飞书 admin `chat_id`（`oc_...`）。与 `adminChannel` 相互独立——Slack 的频道 id 在飞书上不可用 | `FEISHU_ADMIN_CHANNEL` |

Web 工作台可写其中一部分：**设置 → 通知**（`turnNotify`、`autoResume`、`notifyCompaction`）、**设置 → 高级**（`disableUserContext`、`teamEnabled`、`claudeWindowWarmupEnabled`、`maxContextTokens`、`piCompactReserveTokens`、`serverUpdateDisable`、`serverAutoUpdate`、`sessionRetentionDays`、`memoryIndexRegenEnabled`、`memoryIndexRegenIntervalMs`、`diskMonitor` 和 `eventLog`）、**设置 → 平台**（`showToolCalls`、`adminChannel`、`feishuAdminChannel`、`feishuSkillsInWeb`）、**设置 → 隐私**（`telemetryEnabled`），以及桌面端/移动端的 **用量** 页面（`providerRateLimits`）。其余键都靠手工编辑该文件。

`providerRateLimits` 是 `settings.json` 中以 provider id 为键的对象。每个 provider 条目可包含 `windows` 数组，数组元素为 `{ type, label?, enabled, threshold? }`。普通额度行以 provider 上报的 `type` 为身份；模型级额度行同时使用 `type` 和 provider 上报的精确 `label`。精确的窗口条目优先于旧的 provider 级 `enabled`/`threshold` 字段。这些根字段保留为向后兼容的回退，非默认时会出现在用量页面中，并附带清除它们的操作。

桌面端和移动端的用量页面会在每条显示出的 5 小时、weekly、weekly-overage、Codex 主/次窗口及带名称的模型行上分别放置控件。省略 `threshold` 时使用该行默认值：`seven_day` 与 `seven_day_overage_included` 为 `0.95`，其他行为 `0.90`。只显示花费的卡片没有额度控件。模型策略的身份取决于上报的显示名称；如果 provider 改了名称，旧条目就停止匹配。策略改动只作用于后续的额度观测；已经激活的额度或 outage 窗口保持当前状态，直到其重置时间或被手动 **立即恢复** 清除。Codex 与 Anthropic 卡片还会显示账号的可用重置以及需要确认的 **重置** 操作；见[账号用量与可用重置](./backends.md#account-usage-and-banked-resets)。

内置作业间隔必须是 `1000` 到 `2147483647` 之间的整数毫秒，这是 Node timer 的安全范围。启用的作业会在 daemon 启动时执行一次。记忆索引重建从不重叠运行；修改后的间隔在当前运行结束后生效。

`sessionRetentionDays` 是 **设置 → 高级 → 数据与维护** 中唯一的数值型保留控制项。桌面 Web UI 通过与布尔运行时开关相同的 `config.set { section: 'settings' }` 路径写入它，客户端也执行与服务端校验相同的上界。`piCompactReserveTokens` 位于 **智能体** 分组，走同一条路径；客户端接受 `1024`–`131072`，与服务端校验完全一致。Cortex 在创建 PI 会话时把它写进 PI 的私有 `settings.json`，所以新值无需重启即可作用于下一个 PI 会话——已经在池中的会话保留创建时的余量。

`maxContextTokens` 也在 **智能体** 分组里。输入框接受 `100000`–`1000000`；清空后保存为 `null`，即每个模型使用自身窗口。PI 每次判断是否压缩时都会读取这个上限，所以运行中的 PI 会话立即遵循新值。Claude 在 CLI 进程启动时读取它，所以新值作用于下一个 Claude 会话；固定版本的 CLI 兼容性试运行从不接收它。

这个保留时钟覆盖六类 housekeeping surface：live session-registry 过期删除（先写 `delete-intent`，再写 `delete-commit`）、孤儿 `data/conversation-history/*.jsonl`、`logs/sessions-pi/` 下的孤儿 PI transcript bundle、`logs/sessions/` 下的孤儿 Claude capture 文件、`tmp/tool-images/` 下按会话存放的孤儿图片目录，以及同步 Claude 用户 `cleanupPeriodDays` 的 helper。当会话既不在用、也不在待删除状态，且目录内在保留窗口内没有任何变动时，其图片目录会被删除。孤儿 history 与 PI 文件采用两轮确认后才删除。活跃直接会话、运行中的 execution、待响应 interaction/bg-held 会话、仍在使用的 PI backend session id，以及活跃 Claude capture pair 都受保护。

registry 过期删除会把所有过期会话的 delete intent 写成一次 journal 追加，再以每批 100 个会话清理并提交；每批无论包含多少会话都只需三次 registry 追加。daemon 关闭时，正在进行的清理会在批次之间停下。尚未提交删除的会话保持 pending，由下一轮清理优先完成。

### 热更新 {#hot-reload}

config 目录被监视。`settings.json` 的变更去抖 300 毫秒后重新读取文件，之后一律使用新值——**无需重启守护进程**。有两点值得注意：

- 每个设置在各自的使用点生效：下一个回合、下一次 agent 生成、下一次内置作业运行，或下一个 HTTP 请求。`uiCorsOrigins` 在每个请求时解析；`adminChannel` 与 `feishuAdminChannel` 一变更就推送给正在运行的平台适配器。`diskMonitor=false` 会停止其计时器，恢复为 `true` 时会启动计时器并立即检查。每个内置作业开关同样立即停止或启动对应计时器，间隔修改会重排下一次空闲运行。
- 坏文件不会打挂服务器。JSON 非法或类型不符时保留上一份设置并记录错误日志；修好文件后，下一次写入即被重新加载。

### 旧环境变量与弃用提示 {#legacy-environment-variables-and-deprecation}

表中列出旧环境变量的键会保留该变量作为回退，并按既定语义解析——`CORTEX_EVENT_LOG=off`、`CORTEX_TURN_NOTIFY=0`/`false`/`off`/`no`、`CORTEX_NOTIFY_COMPACTION=0`/`false`/`off`/`no`，`CORTEX_UI_CORS_ORIGINS` 用逗号分隔的列表，等等。优先级始终是：`settings.json` 中的键 → 旧环境变量 → 内置默认值。`adminChannel` 保留原有的优先级链：先看 `SLACK_ADMIN_CHANNEL`，再看 `CORTEX_ADMIN_CHANNEL`。

当某个旧环境变量第一次实际供值时，守护进程会记录一条弃用警告，指明该变量和它所供给的设置项（`Deprecated env <VAR> supplies settings.<key>; move it to settings.json`）。这层回退只为迁移期的兼容而存在——新的配置应写进 `settings.json`。

### 从 .env 自动迁移 {#automatic-migration-out-of-env}

每次守护进程启动、`.env` 加载之后，Cortex 会扫描 `$CORTEX_HOME/config/.env` 中是否存在上面列出的旧变量。只要发现至少一个：

1. `.env` 被复制为同目录下的 `.env.bak-<timestamp>`，其中 `<timestamp>` 是把 `:` 和 `.` 替换为 `-` 的 ISO 8601 时刻（例如 `.env.bak-2026-07-30T09-12-33-482Z`）。
2. 每个旧值按其原语义解析后写入 `settings.json`。`settings.json` 中已存在的键绝不被覆盖——文件优先于 `.env`。
3. 被迁移的赋值行从 `.env` 中删除；`.env` 保持原有文件权限，并加上头部注释 `# Legacy server settings migrated to settings.json; secrets remain in .env.`
4. 已经没有任何代码读取的死变量 `CORTEX_SERVER_UPDATE_ENABLE` 在同一趟中被删除。

迁移是幂等的：没有旧变量的 `.env` 原样不动，之后的启动什么都不做。若任一步失败，错误会被记录，`.env` 保留其变量，服务器继续按各值实际的来源运行——迁移失败的代价仅仅是那些弃用警告。

### 仍然留在 .env 的内容 {#what-stays-in-env}

有三类变量刻意留在 `.env`：

- **密钥与凭据**——`SLACK_BOT_TOKEN`、`SLACK_SIGNING_SECRET`、`SLACK_APP_TOKEN`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`ANTHROPIC_API_KEY`、`CORTEX_CLIENT_TOKEN`、`CORTEX_WEBHOOK_TOKEN`。它们广义上也是设置，但把它们挡在一个 Web UI 可读可写的文件之外，能把影响面压到最小。
- **由子进程消费的变量**——`CORTEX_HOME`、`CORTEX_PROJECTS_DIR`、`WEBHOOK_PORT`、`DEBUG`、`CORTEX_LANG` 以及数据文件覆盖项。钩子、MCP 服务器、CLI 和 `cortex-client` 都继承守护进程的环境；服务器侧的 JSON 文件根本传不到它们那里。
- **启动拓扑**——`CORTEX_PLATFORM`、`CORTEX_MACHINE`、`CORTEX_UI_HTTP`、`CORTEX_UI_PORT`、`CORTEX_UI_SPA_DIR`、`CORTEX_UI_TOKEN_LOGIN`。它们决定启动时存在哪些适配器与监听器，热更新对它们没有意义，结构上就必须重启。

### 与 .claude/settings.json 同名不同物 {#not-the-same-file-as-claudesettingsjson}

`$CORTEX_HOME/config/settings.json`（本文件）配置的是 **Cortex 服务器**。`$CORTEX_HOME/.claude/settings.json` 配置的是 **Claude Code** 的钩子与权限，由 Claude CLI 读取，Cortex 不读它。文件名相同，但目录不同、归属不同、schema 不同——见下一节。

## .claude/settings.json（Claude Code） {#claudesettingsjson-claude-code}

位于 `$CORTEX_HOME/.claude/settings.json`。这是 Cortex 数据根目录下由 Cortex 脚手架生成的 Claude Code 项目设置文件。`cortex init` 会从 `defaults/.claude/settings.json` 为它做一次初始化，之后 Cortex 从不覆盖这个路径。

Claude Code 自己还可能读取 spawn cwd 下更高优先级的项目文件（`.claude/settings.local.json`，然后 `.claude/settings.json`），以及 Cortex 的 Claude 配置目录里的用户设置文件（见下一节）。Cortex 完全不会脚手架、同步或覆盖这些 cwd 下的项目级文件；这里说的“从不覆盖”只针对上面这个 `$CORTEX_HOME/.claude/settings.json` 种子路径。

文件遵循 Claude Code 的设置格式，包含 `hooks` 和 `permissions` 部分。钩子系统文档参见 [hooks.md](./hooks.md)。它与 [`config/settings.json`](#configsettingsjson) 中的 Cortex 运行时设置毫无关系。

## Claude Code 配置目录 {#claude-code-config-directory}

Cortex 启动的每个 `claude` 进程——会话 engine、子智能体子进程，以及登录流程背后的 `claude auth login`、`status`、`logout` 命令——都以 `CLAUDE_CONFIG_DIR=$CORTEX_HOME/data/claude` 运行，与 daemon 自身环境里的值无关。这是 Cortex 私有的 Claude Code 主目录，与 PI 的 `$CORTEX_HOME/data/pi` 对应：transcript（`projects/<encoded cwd>/<id>.jsonl`）、用户设置文件、user 与 local 作用域的 plugin、`.claude.json` 和登录状态都在这里。使用 `~/.claude` 的终端 `claude` 与 Cortex 互相看不到对方的会话、设置和 plugin。`claude` 二进制本身仍从 `PATH` 获取。

**登录。** 这个目录有自己的登录；Cortex 从不复制或链接终端的 `.credentials.json`，因为每次 OAuth 刷新都会轮换 token，两份副本会让彼此失效。在 **设置 → 账号**、聊天里的 `!login cc`，或 `cortex auth login --backend claude` 中登录（见[远程登录](./backends.md#remote-login)）。macOS 上 CLI 把登录保存在钥匙串条目 `Claude Code-credentials-<first 8 hex of sha256(config dir)>` 中。

**`settings.json`。** 用户设置文件归 Cortex 所有。文件不存在时，服务器在启动时用 `~/.claude/settings.json` 中的 `model`、`effortLevel`、`modelSettings`、`autoCompactWindow`、`autoMemoryEnabled`、`env`、`attribution` 这几个键创建它；文件存在之后就从不读取终端那份。会话保留协调器只维护其中一个键——`cleanupPeriodDays`，取自运行时设置 `sessionRetentionDays`——其余键保持原样。要改变 Cortex 的 Claude 会话使用的设置，直接编辑这个文件。

**插件。** Cortex 的 Claude 会话要加载的插件安装到这个目录：

```bash
cd ~/.cortex
CLAUDE_CONFIG_DIR=$HOME/.cortex/data/claude claude plugin install <plugin>@<marketplace> --scope project
```

project 与 local 作用域的安装会把插件记录在 `$CORTEX_HOME/.claude/settings*.json`，插件文件放在 `$CORTEX_HOME/data/claude/plugins/` 下。

**来自 `~/.claude` 的会话。** 服务器启动时会一次性地把会话注册表中每个存活 Claude 会话在 `~/.claude/projects` 下拥有的文件——transcript、回合备份和 sidecar 目录——移动到 `$CORTEX_HOME/data/claude/projects` 下的相同路径，这些会话因此可以继续 resume。已存在的目标从不覆盖；不属于任何注册表会话的文件原地保留。

## 看板 {#boards}

看板是长任务的状态页，由推进这项工作的 agent 维护（见团队指南中的[看板](./team.md#boards)）。每个看板位于 `<project context>/boards/<slug>/`，`data/boards.json` 列出每个看板及其所属项目、标题和最近使用时间。升级时，早期 Cortex 版本中已登记的 commission 会转为看板：目录从 `commissions/` 移到 `boards/`，文件只移动、从不删除。

看板的样式来自随 Cortex 发布的预设样式表 `agent-server/defaults/board/board.css`。它从安装包读取，从不复制到 `$CORTEX_HOME`，因此每次升级都会带来其当前版本。预设只使用界面的主题变量（`--proto-*`、`--material-*`、`--border-card`、`--r-*`，以及字体 `--font-ui` 和 `--font-code`），所以看板会跟随深浅色模式、配色和 accent。

要改所有看板的样式，新建 `$CORTEX_HOME/config/board.css`。这个文件默认不存在。它在预设之后加载，所以可以重新定义任意变量（预设自己的 `--b-*` 或主题的 `--proto-*`），也可以覆盖任意规则：

```css
:root { --proto-accent: #0f766e; --b-gap: 16px; }
.h { font-size: 14px; }
```

保存后，打开着的看板几秒内刷新；删掉这个文件即恢复预设。

## 内置资源与你的覆盖 {#built-in-assets-and-your-overrides}

Cortex 的插件、钩子、规则、子智能体角色与系统提示词随安装目录的 `agent-server/defaults/` 发布，运行时从那里读取。它们从不复制到 `$CORTEX_HOME`，因此始终与正在运行的版本一致，`$CORTEX_HOME` 中只有你自己的文件。你在对应位置放的文件会替换内置文件，新名称则是新增，删除你的文件即恢复内置版本。

| 资源 | 内置 | 你的 | 你的文件如何与内置文件结合 |
|---|---|---|---|
| 插件 | `defaults/plugins/<id>/` | `plugins/<id>/` | 同一 id：你的 skill 替换或补充内置 skill，你的 `mcp.json` 替换内置的；manifest 保持内置。其他 id 是独立的插件。见[内置插件](./skills-and-plugins.md#built-in-plugins) |
| 钩子声明 | `defaults/config/hooks/*.json` | `config/hooks/*.json` | 同名文件：它写出的每个顶层字段整体替换内置声明中的同名字段，因此 `{ "enabled": false }` 即可关闭一个内置钩子。见[钩子注册表](./hooks.md#the-hook-registry) |
| 钩子脚本 | `defaults/hooks/*.mjs` | `hooks/*.mjs` | 同名文件：替换内置脚本 |
| 规则 | `defaults/rules/*.md` | `rules/*.md` | 同名文件：替换内置规则 |
| 子智能体角色 | `defaults/agents/*.md` | `config/agents/*.md` | 同名文件：替换内置角色 |
| 系统提示词 | `defaults/prompts/systemPrompts/*.md` | `prompts/systemPrompts/*.md` | 同名文件：替换内置提示词 |
| 干净模式工作区提示词 | `defaults/prompts/clean-workspace.md` | `prompts/clean-workspace.md` | 替换内置文字；见[干净模式](#clean-mode) |

规则是给智能体会话用的 Markdown 文件。没有 `paths` frontmatter 的规则会前置到每个其执行环境加载规则（`loadRules`）的会话中；`paths` glob 与会话读取的文件匹配的规则，会在那时由 `rules-loader` 钩子注入，每会话一次。

在设置中做的修改——一个 skill、一个钩子开关、一段系统提示词——同样写入 `$CORTEX_HOME`，Cortex 从不写入安装目录。Sealed home（`CORTEX_CONFIG_IMMUTABLE=1`，例如 benchmark trial）自行声明完整的能力面，不使用任何内置插件、钩子或规则。

由一个在 `$CORTEX_HOME` 中保存这些文件副本的版本建立的 home，会在首次启动时转换：与随包文件完全相同的副本被删除，内容不同的插件与钩子副本移到 `config/archive/builtin-overlay-<timestamp>/`，改过的规则、角色与提示词作为你的覆盖保留，被关闭的内置钩子保持关闭，每个执行环境继续加载同样的插件。

## defaults/ 布局 {#defaults-layout}

npm 包中的 `agent-server/defaults/` 目录包含随包发布的默认值。脚手架文件在 init 期间复制到 `$CORTEX_HOME/`，执行环境还会在服务器每次启动时合并；内置资源则原地读取：

| 源 | 目标 | 覆盖行为 |
|---|---|---|
| `defaults/AGENTS.md` | `$CORTEX_HOME/AGENTS.md` | 从不 |
| `defaults/gitignore` | `$CORTEX_HOME/.gitignore` | 从不 |
| `defaults/.claude/settings.json` | `$CORTEX_HOME/.claude/settings.json` | 从不——这里只指 `$CORTEX_HOME/.claude/settings.json` 这个脚手架路径；任意仓库内的本地 `.claude/settings.json` 文件都不在 Cortex 的 copy/sync 回路里 |
| `defaults/config/budget.json` | `$CORTEX_HOME/config/budget.json` | 仅 `--force` |
| `defaults/config/environments/` | `$CORTEX_HOME/config/environments/` | 逐文件 copy-if-missing，init 时与之后每次服务器启动时各执行一次：你尚未拥有的随包执行环境会被拷入；你已有的文件绝不被覆盖——`--force` 对这棵树不生效 |
| `defaults/data/schedules.json` | `$CORTEX_HOME/data/schedules.json` | 从不（除非 `--force`） |
| `defaults/context/` | `$CORTEX_HOME/context/` | 索引 `AGENTS.md` 文件：从不覆盖。`decisions/` 脚手架：仅 `--force` |
| `defaults/plugins/`, `defaults/config/hooks/`, `defaults/hooks/`, `defaults/rules/`, `defaults/agents/`, `defaults/prompts/` | — | 不复制：原地读取，你的文件叠加其上（见[内置资源与你的覆盖](#built-in-assets-and-your-overrides)） |
| `defaults/board/` | — | 不复制：看板的预设样式表和新看板的骨架从安装包读取 |

init 还会在 `config/machines.json`、`config/preferences.json` 和 `data/agent-state.json` 缺失时（或使用 `--force` 时）生成它们，写入 `config/mcp-config*.json` 文件，并设置网关配置和 `models.json`（见 [`cortex init`](./cli-reference.md#commands)）。服务器每次启动都会重写 `mcp-config*.json` 文件，所以对它们的编辑不会保留。

因此升级会带来当前版本的内置插件、钩子、规则、角色与提示词，新随包的执行环境也能到达已有安装，同时不动你的改动。整文件型配置（如 `budget.json`）需要 `--force` 才能替换。

## 热重载行为 {#hot-reload-behavior}

`config/` 下由文件监视器支持的文件，在监视器无法启动或报告运行期错误时，会自动切换为每 5 秒一次的文件系统快照轮询。每个加载器在轮询模式下沿用其处理文件系统事件时的校验和失败行为。

- **`config/settings.json`** — 通过文件监视器监视，去抖 300 毫秒。新值在下一个使用点生效，无需重启；文件损坏时保留上一份设置。参见 [config/settings.json](#configsettingsjson)。
- **`schedules.json`** — 通过文件监视器监视。更改在几秒钟内生效，无需重启。完整调度系统参见 [scheduling.md](./scheduling.md)。
- **`models.json`** — 缓存并监视可解析的 JSON 变更。更新会在下一次智能体生成前刷新缓存；JSON 损坏时保留上一份配置。
- **`machines.json`** — 监视并在有效变更后重新加载。条目无效时保留上一份机器注册表。
- **`environments/`** — 被监视。变更去抖（300 毫秒）后重载所有执行环境，无需重启。参见[执行环境](#execution-environments)。
- **`.env`** — 需要重启守护进程才能生效（启动时通过 dotenv 加载一次）。行为设置位于 `config/settings.json`，后者不需要重启。
- **钩子声明（`config/hooks/*.json`）** — 注册表在每次智能体生成时重新读取，因此新增的 `agent:*` / `cc:*` / `pi:*` 条目对下一个启动的智能体生效。`cortex:*` 条目在服务器启动时被快照，需重启才生效。参见 [hooks.md](./hooks.md)。
- **钩子脚本** — 每次钩子调用时重新读取。
- **插件、提示、规则、子智能体角色** — 每次智能体会话生成时重新读取。
- **`config/board.css`** — 与所有看板的目录一起被监视。变更后几秒内，打开着的看板重新渲染。参见[看板](#boards)。

## 各文件位置 {#where-each-file-lives}

| 文件 | 用途 | 路径 |
|---|---|---|
| `.env` | 环境变量 | `$CORTEX_HOME/config/.env` |
| `settings.json` | 运行时行为设置（热更新） | `$CORTEX_HOME/config/settings.json` |
| `models.json` | 默认引擎与收藏模型 | `$CORTEX_HOME/config/models.json` |
| `environments/` | 执行环境——每个环境一个 JSON | `$CORTEX_HOME/config/environments/` |
| `machines.json` | 机器注册表 | `$CORTEX_HOME/config/machines.json` |
| `budget.json` | 预算限制 | `$CORTEX_HOME/config/budget.json` |
| `preferences.json` | 系统消息的界面语言 | `$CORTEX_HOME/config/preferences.json` |
| `mcp-config*.json` | 生成的 MCP 服务器配置（每次启动时重写） | `$CORTEX_HOME/config/` |
| `.claude/settings.json` | Claude Code 钩子/权限（不是 Cortex 的设置文件） | `$CORTEX_HOME/.claude/settings.json` |
| `agent-state.json` | 频道引擎选择、模型记忆、新会话选择、默认智能体 | `$CORTEX_HOME/data/agent-state.json` |
| `schedules.json` | 定时任务 | `$CORTEX_HOME/data/schedules.json` |
| `boards.json` | 看板注册表 | `$CORTEX_HOME/data/boards.json` |
| `provider-state.json` | provider 用量、限流窗口、恢复队列 | `$CORTEX_HOME/data/provider-state.json` |
| `waitpoints.json` | Waitpoint | `$CORTEX_HOME/data/waitpoints.json` |
| `board.css` | 可选，所有看板的样式表 | `$CORTEX_HOME/config/board.css` |
| `session-registry.jsonl` | 仅追加的 session registry 日志 | `$CORTEX_HOME/data/session-registry.jsonl` |
| `retention-candidates.json` | 两轮确认的孤儿清理候选 | `$CORTEX_HOME/data/retention-candidates.json` |
| `conversation-history/` | 按会话分文件的 transcript/history JSONL | `$CORTEX_HOME/data/conversation-history/` |
| `logs/sessions/` | Claude capture 日志 | `$CORTEX_HOME/logs/sessions/` |
| `logs/sessions-pi/` | PI transcript bundle | `$CORTEX_HOME/logs/sessions-pi/` |
| `hooks/*.json` | 你的钩子声明与覆盖 | `$CORTEX_HOME/config/hooks/` |
