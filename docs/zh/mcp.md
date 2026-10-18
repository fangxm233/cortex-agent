# MCP — Model Context Protocol {#mcp-model-context-protocol}

Cortex 内置按权限面和平台面拆分的 MCP（Model Context Protocol）工具，让智能体能够访问远程机器、子智能体、费用、waitpoint、团队 worker、看板和平台集成。本文说明每个服务器提供什么、它们如何组合，以及如何添加第三方 MCP 服务器。

## 什么是 MCP {#what-mcp-is}

MCP 是一个开放协议，允许 LLM 应用通过标准化的 JSON-RPC 接口（基于 stdio、HTTP 或一对内存 transport）向智能体暴露工具。Cortex 用 MCP 在智能体（它自身够不到任何 agent-server 内部）和服务器能力之间架起桥梁。MCP 支持情况因后端而异——功能矩阵见 [backends.md](./backends.md)。

Claude Code 从 JSON 文件读取 MCP 服务器配置，并把每个 stdio 服务器作为子进程启动。之后智能体就像调用内置工具（Bash、Read、Edit 等）一样调用 MCP 工具，工具名带 `mcp__<server-name>__` 前缀。PI 通过 Cortex 自己的 bridge 连接 MCP 服务器：Cortex 内置工具保持无前缀的原名，plugin 服务器的工具则命名为 `plugin_tool_plugin_server_<server>_<tool>`。

## 为什么 Cortex 内置自己的 MCP 服务器 {#why-cortex-ships-its-own-mcp-servers}

Cortex 的 agent-server 维护着智能体进程无法直接触及的状态：到远程机器的 WebSocket 连接、运行中的子智能体和团队 worker、waitpoint、聊天平台、费用记录以及执行注册表。Cortex MCP 工具是一座受控的桥梁——智能体调用工具，工具向服务器发起请求（经 loopback webhook，或读取服务器的存储），结果再流回智能体。

## 内置 MCP 服务器 {#the-bundled-mcp-servers}

下面的名称是逻辑能力组，而不是独立进程。只要会话的 MCP composition 非空，它就恰好拥有一个由 `agent-server/src/domain/mcp/bundled-server.ts` 构建的 Cortex 自有服务器，且只注册为该会话选中的能力组。Claude Code 把这个服务器作为 stdio 子进程启动；PI 则让它跑在 agent-server 进程内，经一对内存 transport 通信，并绑定专为该会话构建的 tool context。在 Claude 下服务器 key 是 `cortex-core`，因此每个内置工具都带这个前缀——远程工具是 `mcp__cortex-core__remote_*`，上下文工具是 `mcp__cortex-core__cortex_context`。PI 以无前缀的名称暴露同一批工具。

用户提供的 MCP 不在这个 bundle 之内。Portable plugin 服务器、browser MCP、remote HTTP/SSE 服务器，以及已分配的 legacy plugin 中的 Claude-native MCP，各自保留独立的配置、transport 和故障边界。

### cortex-core {#cortex-core}

暴露远程机器操作、只读时钟和子智能体委派。MCP composition 不是 `none` 的每个会话都会加载它，子智能体也包括在内。

| 工具 | 参数 | 描述 |
|---|---|---|
| `remote_bash` | `device`, `command`, `timeout?` (seconds, 1–600, default 120), `description?`, `run_in_background?` | 通过 cortex-client 在远程设备上执行 shell 命令 |
| `remote_read` | `device`, `file_path` (absolute), `offset?`, `limit?` | 从远程设备读取文件（支持图像和 PDF） |
| `remote_write` | `device`, `file_path`, `content` | 向远程设备上的文件写入内容 |
| `remote_edit` | `device`, `file_path`, `old_string`, `new_string`, `replace_all?` | 通过字符串替换编辑远程设备上的文件 |
| `remote_glob` | `device`, `pattern`, `path?` | 在远程设备上查找匹配 glob 模式的文件 |
| `remote_grep` | `device`, `pattern`, `path?`, `glob?`, `type?`, `output_mode?`, `-A?`, `-B?`, `-C?` (alias `context?`), `-i?`, `-n?`, `head_limit?`, `offset?`, `multiline?` | 用 ripgrep 在远程设备上搜索文件内容 |
| `current_time` | `timezone?` | 获取当前日期时间；可选 IANA 时区（默认为服务器本地时区）。返回 Unix 时间戳、UTC ISO 时间，以及带偏移的本地挂钟时间 |
| `agent` | single (`description`, `prompt`, `subagent_type`) **or** `parallel[]` **or** `chain[]` (each item `description`, `prompt`, `subagent_type`, `model?`, `backend?`), plus `model?`, `backend?`, `run_in_background?` | 把工作委派给任一后端上的隔离子智能体 |
| `agent_stop` | `agent_id` | 停止运行中的子智能体，并丢弃它已产出的内容 |

远程工具由 `agent-server/src/domain/mcp/tools/remote-ops.ts` 注册；`agent` 和 `agent_stop` 由 `agent-server/src/domain/mcp/tools/subagent.ts` 注册。

远程工具有一些共同行为：

- 会话工具集中的第一个远程工具会在描述里附上 `machines.json` 中已注册设备的目录，并标出 Windows 机器，让智能体知道有哪些 `device` 值可用。调用未连接的设备会失败，并返回当前在线的设备列表。
- `remote_read`、`remote_write` 和 `remote_edit` 会把目标文件在该设备上的 `AGENTS.md` 祖先链附加到结果中，每个会话每个文件只附加一次（见 [cross-machine.md](./cross-machine.md#remote-agentsmd-files)）。
- `remote_read` 以媒体形式返回图像和 PDF；当 `sharp` 可用时，服务器会把大图缩小。
- 输出超过 30,000 字符（`remote_bash`）、20,000 字符（`remote_grep`）或 100,000 字符（`remote_glob`）时，会保存到 `$CORTEX_HOME/tmp/tool-results/` 下，工具返回该路径和一段 2 KB 的预览。

`agent` 取代 Claude Code 内置的 `Agent` 工具，Cortex 会在每次 Claude spawn 时把后者剥离。它运行在与 PI 原生 `agent` 相同的角色表上，可以把子智能体放到任一后端，并且对 daemon 可见——因此一次委派会出现在父会话的 transcript 里、计入父会话的费用，并且可以从界面上停止。前台调用运行超过 25 分钟仍未结束时，会转入后台，结果稍后送达。见 [backends.md](./backends.md#subagents)。

PI 会话永远拿不到 MCP 版的 `agent` 和 `agent_stop`：PI 注册了自己的 `agent`，同名的两个工具无法共存。子智能体在两种后端上都拿不到这两个工具。这一点由工具 allowlist 强制，而不是靠提示词约束，所以无论子智能体被要求做什么，都无法继续向下扇出。

### cortex-workers {#cortex-workers}

[团队模式](./team.md)中主会话一侧的工具。当 `teamEnabled` 开启、且会话是本身不是 worker 的 Web 直接会话时，会选入这个能力组，Claude 和 PI 都一样。worker 和子智能体永远不加载它。所有工具都立即返回；worker 的汇报和提问以新消息的形式到达主会话。

| 工具 | 参数 | 描述 |
|---|---|---|
| `worker_spawn` | `name`, `prompt`, `backend?`, `model?` | 启动一个持久的 worker 会话并交给它第一个任务；除非用 `backend`/`model`（格式同 `agent`）指定其他模型，否则沿用主会话当前的模型 |
| `worker_send` | `worker`, `message` | 给 worker 发送消息：并入它正在运行的一轮，或开启新的一轮 |
| `worker_list` | `worker?` | 主会话的 worker 名单，或某个 worker 及其完整的上一份汇报 |
| `worker_stop` | `worker` | 停止 worker 当前这一轮 |
| `worker_answer` | `request_id`, `answers?`, `approved?`, `feedback?` | 处理 worker 挂起的提问或计划审批 |

该能力组由 `agent-server/src/domain/mcp/bundled-server.ts` 加载；工具位于 `agent-server/src/domain/mcp/tools/workers.ts`，由 `/webhook/team` 路由提供服务。

### cortex-worker-report {#cortex-worker-report}

[团队模式](./team.md)中 worker 一侧的工具。每个 worker 会话都会加载它，Claude 和 PI 都一样；主会话、普通会话和子智能体永远不加载。

| 工具 | 参数 | 描述 |
|---|---|---|
| `mark_routine` | none | 把当前这一轮标记为例行：它的最终回复作为一条未读动态记给主会话，不会唤醒主会话。失败或被停止的一轮仍会照常汇报 |

该工具位于 `agent-server/src/domain/mcp/tools/workers.ts`，由 `/webhook/team` 路由提供服务；非 worker 会话调用时会被该路由拒绝。

### cortex-ext {#cortex-ext}

暴露 Cortex 管理工具：费用查询、执行记录、上下文解析和 waitpoint。MCP composition 不是 `none` 的每个顶层会话都会加载它，Claude 和 PI 都一样。Claude 子智能体也会加载；PI 子智能体不加载。

| 工具 | 参数 | 描述 |
|---|---|---|
| `cost_query` | `projectId?` | 查询当前费用：今日/本月支出、预算上限、剩余预算、API/plan 分摊、来源细分、token 用量；传入 `projectId` 时只统计该项目 |
| `query_executions` | `execution_id?`, `status?` (`running`, `completed`, `failed`, `cancelled`, `stale`, `all`), `project?`, `limit?` | 查询执行记录——按状态、项目过滤，或按 ID 查找 |
| `cortex_context` | _(none)_ | 返回当前执行上下文：`sessionId`、`project`、`backend`、`model`、`thinking`、`mode`；定时或回调触发的运行还有 `scheduleTaskId` 和 `callbackSource`；Web 会话还有 `board`，即会话绑定的看板（id、title、dir），未绑定时为 null |
| `wait_create` | `label`, `intent`, `members?`, `quorum?`, `fail_fast?`, `max_signals?`, `expires_in_hours?`, `device?` | 登记一个 waitpoint，返回 id、一次性 secret 和可直接粘贴的发信号命令；随后结束这一轮 |
| `wait_check` | `id?` | 查看某个 waitpoint，或列出本会话正在等待的全部内容 |
| `wait_cancel` | `id` | 取消一个 waitpoint，使其无法触发 |

`wait_create` 让会话无需轮询就能等待 Cortex 之外的事情——一次训练、一次构建、一次评测。外部程序通过 `cortex-signal` CLI、loopback `POST /webhook/signal`，或往 spool 目录放一个文件来回报，会话随即带着结果被唤醒。见 [waitpoints.md](./waitpoints.md)。

定时任务不是 MCP 工具：智能体通过 `schedule` skill 使用 `cortex schedule` CLI 管理它们，先用 `cortex_context` 确定项目，再通过 `--project` 传入（见[调度](./scheduling.md)）。

该能力组由 `agent-server/src/domain/mcp/bundled-server.ts` 加载。各个工具位于 `agent-server/src/domain/mcp/tools/`。

### cortex-slack {#cortex-slack}

Slack 平台专属的 MCP 服务器。仅当会话源自 Slack 时加载，提供平台专属的文件上传和消息能力。

| 工具 | 参数 | 描述 |
|---|---|---|
| `slack_send_file` | `file_path`, `file_name?`, `title?`, `comment?`, `device?` | 上传文件到 Slack；带 `device` 时读取该远程设备上的文件 |

该能力组由 `agent-server/src/domain/mcp/bundled-server.ts` 加载；工具位于 `agent-server/src/domain/mcp/tools/slack.ts`。

### cortex-feishu {#cortex-feishu}

飞书/Lark 平台专属的 MCP 服务器。仅当会话源自飞书时加载。它只暴露一个工具——向聊天发送文件。

| 工具 | 参数 | 描述 |
|---|---|---|
| `feishu_send_file` | `file_path`, `file_name?`, `title?`, `channel?`, `device?` | 上传文件到飞书聊天；带 `device` 时读取该远程设备上的文件 |

文档、表格、电子表格和知识库操作**不是** MCP 工具。它们通过飞书官方 CLI（`@larksuite/cli`）完成，由内置 `cortex-feishu` plugin 中的 `feishu-doc` skill 驱动，能够处理原生表格和 block 级编辑。安装/鉴权 preflight，以及如何委托给 CLI 自带的 `lark-doc` / `lark-sheets` / `lark-base` skill 指南，见 `feishu-doc` skill。

该能力组由 `agent-server/src/domain/mcp/bundled-server.ts` 加载。工具位于 `agent-server/src/domain/mcp/feishu/file.ts`。

### cortex-web {#cortex-web}

Web 工作台专属的 MCP 服务器。仅当会话源自 Web UI（其频道带 `web:` 前缀）时加载，因此源自 Slack 或飞书的会话看不到这些工具。

| 工具 | 参数 | 描述 |
|---|---|---|
| `send_file` | `file_path` or `files[]` (`{file_path, file_name?}`), `file_name?`, `caption?`, `device?` | 把一个文件，或把多个文件作为共用一条说明的同一条消息，发进聊天并显示为可下载卡片（图片和视频内联预览）；带 `device` 时读取该远程设备上的文件 |
| `send_view` | `title`, `html` or `file_path`, `caption?`, `height?` (160–900, default 360), `width?` (`narrow`, `wide`, `full`) | 在聊天里内联渲染一块 HTML 视图，作为实时可交互的卡片 |
| `send_decision` | `decisions[]` — each `title`, `decision`, `context`, `reasoning` | 记录智能体刚做出的决策，并在聊天里逐条显示 |
| `board_open` | `title` or `board` (exactly one) | 新建看板，或按 id、slug 接入已有看板，并把会话绑定到它 |

助手可以在 Markdown 回复里用 `![alt](src)` 把图片或视频放在正文对应位置。`src` 支持服务器路径（`/absolute/plot.png`、`~/plot.png`，或相对 `CORTEX_HOME`、通常是 `~/.cortex` 的 `figs/plot.png`）、已有的 `workspace/...` 路径、已登记设备路径（例如 `gpu-box:/home/user/plot.png`、`win-pc:C:/Users/x/clip.mp4`），以及外部 `https://...` 链接。本机和设备文件按消息保存快照，单文件上限 200MB；后续消息再次引用同一路径时保存另一份快照。Workspace 路径直接使用已有文件。`.mp4`、`.webm`、`.mov`、`.m4v` 显示为视频，其他支持的媒体扩展名显示为图片；没有扩展名的外链按图片处理。预览在滚动到附近时加载，点击打开媒体查看器；流式回复中的本机和设备引用先显示占位，回复保存后加载。外链由浏览器直接加载，不发送 referrer；非 HTTPS、本地网络主机名和私有 IP 地址不内嵌。该 Markdown 行为仅用于 Web UI 和原生应用的助手聊天正文；分享可下载附件卡片使用 `send_file`。

`send_file`、`send_view` 和 `send_decision` 不把载荷作为工具输出返回，而是经 loopback webhook 代理给 daemon：归一化事件流中的工具结果是扁平字符串，PI 后端又会把富 MCP 内容压成文本，所以比字符串更复杂的东西只能走带外通道。daemon 把字节复制到 `workspace/outputs/<sessionId>/`（视图再深一层，落在 `views/`），记录一条带附件的 assistant 消息，并发布实时事件。传递的只有路径——大文档既不会进入 transcript，也不会进入事件流。

`send_view` 接受内联 `html` 字符串（上限 256KB），或智能体已经写好的 `.html` 文件路径（上限 2MB）。视图渲染在只开启 `allow-scripts`、不带 `allow-same-origin` 的沙箱 frame 中，因此文档处于 opaque origin：拿不到页面、存储、cookie、Cortex API，在桌面端也拿不到鉴权 token 和 Tauri IPC。它仍然可以通过 https 加载库和数据。正因为有这层隔离，是否渲染由服务器生成的附件分类决定，绝不由文件扩展名决定——用户上传的 `.html` 文件，或智能体用 `send_file` 发送的 `.html` 文件，打开时显示的是源码文本，而不是运行中的文档。

`width` 在三档内联卡片宽度中选一档：`narrow`（默认）落在聊天正文栏内，`wide` 扩展到约一栏半（最宽 1040px），`full` 铺满整个聊天面板。`wide` 和 `full` 会随面板收窄，所以窗口较窄时两者都与面板同宽。档位随消息一起保存，视图在刷新后保持原有宽度。只有桌面端聊天中的内联卡片遵循这个设置；展开视图、停靠视图和手机端聊天总是填满各自的可用空间。

`send_decision` 不阻塞：智能体宣告它替用户做出的选择后继续工作，而不是像 `cortex_ask_user` 那样向用户提出问题。每条决策（单次调用最多 10 条，title ≤120 字符，其余字段 ≤1000）在宣告它的回复下方显示为一行：标题，以及用户回应后的状态。一次多条时显示前三行，其余收成一行，那一行也可以一次全部同意。展开某一行后依次是决策本身、为什么和背景。用户可以同意（仅记录——不向智能体发送任何内容；桌面端鼠标悬停在行上即可直接同意），或回复：同一个输入框可以「请解释」（可不写字）或「按此修改」（必须写明改法）。两者都会按模板生成一条消息，既记录在该决策上，也作为普通用户消息发给智能体。决策及其操作日志持久化在会话历史中，因此在刷新和换设备后都保持状态。

`board_open` 打开长任务的状态页：哪些会话绑定到它、智能体如何写入、在聊天和工作台中如何显示，见[看板](./team.md#boards)。

该能力组由 `agent-server/src/domain/mcp/bundled-server.ts` 加载。工具位于 `agent-server/src/domain/mcp/tools/ui-file.ts`、`agent-server/src/domain/mcp/tools/ui-view.ts`、`agent-server/src/domain/mcp/tools/ui-decision.ts` 和 `agent-server/src/domain/mcp/tools/ui-board.ts`。

### cortex-interaction-bridge {#cortex-interaction-bridge}

直接 Claude TUI 会话、用户发起的直接 Claude print 会话，以及用户发起的直接 PI 会话，都会在各自唯一的 Cortex MCP 服务器中选入这个交互能力组。在加载了它的会话里，Claude 原生的 `AskUserQuestion`、`EnterPlanMode` 和 `ExitPlanMode` 会被移除，因此所有提问和计划都经由这些工具。

| 工具 | 参数 | 描述 |
|---|---|---|
| `cortex_plan_enter` | `reasoning?` | 进入共享的只读规划协议：先调研，把计划写到 `plan/` 下，获批后才实施 |
| `cortex_plan_exit` | `plan_file_path`, `summary?` | 读取计划文件，提交人工审批，并阻塞到审批结束 |
| `cortex_ask_user` | `questions[]` (each `question`, `header?`, `options?[]` of `{label, description?}`, `multiSelect?`), `level?` (`info`, `warning`, `error`; `warn` is an alias), `blocking?` | 通过会话所属平台提出一个或多个自由文本或选择题，可以等待回答，也可以不等直接继续 |

两种模式下 `cortex_ask_user` 张贴问题卡片的方式完全相同；`blocking` 参数决定答案如何回来。默认是阻塞的：工具调用最多等待 30 分钟的交互 TTL，并在自己的 `tool_result` 中返回答案，智能体拿不到答案就无法继续。传入 `blocking: false` 时，卡片一贴出调用就返回，智能体继续工作；人类回答后，答案以一条普通用户消息送达该会话——如果当前轮仍在运行就并入该轮，否则开启新的一轮。无人回答的非阻塞卡片按同样的 TTL 过期，只是不会产生任何消息。在工作台中，只有阻塞提问会把会话标记为等待用户操作；以非阻塞方式提问的会话仍显示为运行中。

卡片在各平台上的样子，以及团队模式下计划审批和提问如何路由，见 [safety-and-approvals.md](./safety-and-approvals.md#plan-approval-and-questions)。计划与提问的处理器位于 `agent-server/src/domain/mcp/tools/interaction-plan.ts` 和 `agent-server/src/domain/mcp/tools/interaction-ask.ts`。

## MCP 配置文件 {#mcp-configuration-files}

Cortex 在启动时生成 Claude 的 MCP 配置文件（通过 `agent-server/src/core/config-generator.ts` 以及 `agent-server/src/entry/startup-helpers.ts` 中的 `ensureMcpConfig()` 调用）。封存的 home（`CORTEX_CONFIG_IMMUTABLE=1`）保留它被给定的文件。

| 文件 | 用途 | 服务器 key | 逻辑能力组 |
|---|---|---|---|
| `$CORTEX_HOME/config/mcp-config.json` | 每个普通 Claude 会话使用的 `direct` composition | `cortex-core` | core + ext |
| `$CORTEX_HOME/config/mcp-config-empty.json` | `none` composition：不含任何 MCP 服务器 | — | — |
| `$CORTEX_HOME/config/mcp-config-core.json` | 显式的受限 composition | `cortex-core` | core |
| `$CORTEX_HOME/config/mcp-config-interaction.json` | 显式的交互 composition | `cortex-interaction-bridge` | interaction |
| `$CORTEX_HOME/config/mcp-config-slack.json` | 显式的 Slack composition | `cortex-slack` | Slack |
| `$CORTEX_HOME/config/mcp-config-feishu.json` | 显式的飞书 composition | `cortex-feishu` | Feishu |
| `$CORTEX_HOME/config/mcp-config-web.json` | 显式的 Web composition | `cortex-web` | Web |

Claude 会话加载 `mcp-config.json` 或 `mcp-config-empty.json`；其余五个文件供显式传入配置路径的调用方使用。每个文件都遵循 Claude Code 的标准 MCP 配置格式：

```json
{
  "mcpServers": {
    "cortex-core": {
      "command": "node",
      "args": [
        "<install>/agent-server/dist/domain/mcp/bundled-server.js",
        "[\"cortex-core\",\"cortex-ext\"]"
      ],
      "cwd": "<install>/agent-server"
    }
  }
}
```

配置文件在每次 agent-server 启动时重写，所以手动编辑不会保留。要自定义 MCP 配置，请使用 plugin（见 [插件提供的 MCP 服务器](#plugin-provided-mcp-servers)）。

在工具 allowlist 下运行的 spawn——子智能体，或声明了 allowlist 的 agent 角色——会得到一份合并后的配置，写入 `$CORTEX_HOME/config/mcp-tool-gates/mcp-composition-<digest>.json`，把 allowlist 传给内置服务器。

### 如何选择正确的配置 {#how-the-right-config-gets-selected}

在 `agent-adapter/claude/spawn-args.ts` 中，`direct` composition 的会话加载 `mcp-config.json`，`none` composition 的会话加载 `mcp-config-empty.json` 并带上 `--strict-mcp-config`。Claude adapter 为它启动的 stdio 子进程把最终的逻辑选择写入 `CORTEX_MCP_BUNDLES`：core 和 ext；用户发起的会话再加 interaction 能力组，团队主会话加 workers 能力组，worker 加 worker-report 能力组，另外加上与会话频道（`slack:`、`feishu:` 或 `web:`）匹配的平台能力组。plugin 的 MCP 配置，以及（对启用浏览器的直接会话而言）browser MCP 配置，作为单独的配置文件加入。

PI 的 bridge 根据会话自身的环境计算出相同的逻辑选择，直接交给进程内的内置服务器，同时为每个 plugin 服务器建立一条独立连接；在 PI 上，interaction、workers 和 worker-report 能力组要求 `direct` composition。子智能体在 allowlist 下运行：Claude 子智能体获得 core（不含 `agent` 和 `agent_stop`）和 ext，PI 子智能体只获得 core，且没有 plugin 服务器。内置服务器注册工具之前，会先对照已选能力组校验 allowlist。

## MCP 工具如何与 agent-server 通信 {#how-mcp-tools-communicate-with-agent-server}

用户提供的 stdio MCP 条目在两种后端下都是独立的子进程，Claude Code 会话还会把 Cortex 自有的 MCP 服务器也作为子进程运行。无论服务器跑在哪里，Cortex MCP 工具都不会直接触及 agent-server 的进程内状态（WebSocket 连接、运行中的会话、waitpoint）。它们通过两条路径通信：

1. **Loopback webhook** — 大多数工具向服务器位于 `http://127.0.0.1:<WEBHOOK_PORT>`（默认 3001）的 webhook 发送 POST 请求，在 `x-cortex-token` 请求头中携带 `CORTEX_WEBHOOK_TOKEN` bearer token 进行认证。远程机器工具使用 `/webhook/remote-command`，它在 `agent-server/src/orchestration/routing/webhook.ts` 中的处理程序把请求转发给 `client-manager.sendCommand()`，再经 WebSocket 发送到设备。子智能体、团队、看板、waitpoint、Web 投递（`ui-file`、`ui-view`、`ui-decision`）和交互（`/hook/ask-user-question`、`/hook/exit-plan-mode`）工具各有自己的路由。

2. **读取存储** — `cost_query` 通过与主服务器相同的仓库层读取费用记录（`data/costs.jsonl`），`query_executions` 读取执行注册表（`data/executions.json`）。两者都不写入。

MCP 调用和 loopback HTTP 请求共用 30 分 30 秒的基础设施 deadline。工具自身的业务 deadline 仍然优先：shell 命令使用其 `timeout` 参数，人工交互保留 30 分钟的响应窗口。多出的 30 秒让业务超时能在外层 transport deadline 关闭请求之前返回结果。

## 插件提供的 MCP 服务器 {#plugin-provided-mcp-servers}

按执行环境分配的第三方 MCP 应放在 `$CORTEX_HOME/plugins/<plugin-id>/` 下的 portable Agent Plugins package 中。package 在根目录的 `mcp.json` 中声明服务器，再由执行环境的 Plugins 标签页（**Settings → Environments**）把 package 分配给该环境。schema 支持 `stdio`、`streamable-http` 和 legacy `sse`；完整的 package 与信任模型见[技能与插件](./skills-and-plugins.md#portable-mcp-servers)。

legacy plugin 目录会原样传给对应的后端。Claude 可以从这类目录加载 Claude-native 的根目录 `.mcp.json`，但 Cortex 不会对这些原生服务器做清点、摘要或确认门控，PI 也拿不到它们。本节所述的保证只适用于 portable 的根目录 `mcp.json`（`agent-server/src/domain/plugins/runtime.ts`；`agent-server/src/agent-adapter/claude/spawn-args.ts`）。

Cortex 在 spawn 时对 package 统一做一次校验和规范化。Claude 获得一份私有的补充配置，叠加在常规 Cortex 配置文件之后。stdio 条目仍是独立进程；每个 remote 条目会变成一个本地 stdio 代理，其 URL 和请求头保存在私有配置中。PI 随会话请求获得规范化后的服务器列表，它的 bridge 为每个条目打开各自的 transport——stdio 条目对应一个 stdio 子进程，remote 条目对应一条直连的 HTTP 或 SSE 连接。两条 remote 路径使用同一个手动处理重定向的 fetch，在配置的请求头或请求体可能被重放之前拒绝所有重定向。连接和工具注册按服务器隔离。materialization 遵循声明的依赖：plugin 作用域的 `PLUGIN_DATA` 不可用时，会省略依赖它的 stdio 服务器，同时保留 remote MCP、skill 和内置工具（`agent-server/src/domain/plugins/runtime.ts`；`agent-server/src/agent-adapter/claude/mcp-config.ts`；`agent-server/src/agent-adapter/claude/remote-mcp-proxy.ts`；`agent-server/src/agent-adapter/pi/mcp-bridge.ts`）。

解析出的 MCP composition 为 `none` 时，portable MCP 会被省略；子智能体完全不加载 plugin。顶层 Claude 和 PI 会话只有通过已分配的 plugin 才会获得它（`agent-server/src/domain/plugins/runtime.ts`；`agent-server/src/agent-adapter/pi/adapter.ts`；`agent-server/src/agent-adapter/pi/mcp-bridge.ts`）。

plugin 目录和 Settings API 只公开经过脱敏的摘要。stdio 摘要包含可执行文件的 basename、参数个数和环境变量的键名；remote 摘要包含 origin 和请求头名称。环境变量的值、完整的 remote URL 和请求头的值都留在服务器端（`agent-server/src/domain/plugins/mcp.ts`；`agent-server/src/domain/ui-service/plugins-shared.ts`）。已安装的 stdio 命令及其工作目录仍属于由管理员信任的 package 输入；私有配置和按服务器隔离并不是代码沙箱。

## 全局自定义 MCP 服务器 {#global-custom-mcp-servers}

`$CORTEX_HOME/config/mcp-config*.json` 下的文件描述 Cortex 的全局 MCP 层和按会话组合的 MCP 层。它们在服务器启动时重写，所以直接编辑只是临时的。要持久加入一个全局服务器，必须在 `agent-server/src/core/config-generator.ts` 中显式修改 builder 和权限组合；它不属于按分配生效的 plugin。

这种区分把 Cortex 的全局权限与管理员安装的 plugin 能力分开。如果服务器应随执行环境的分配而加载，就使用 portable plugin；只有当每一种符合条件的会话 composition 都应获得该服务器时，才修改全局 builder。

## 权限模型 {#permission-model}

MCP 工具跨越了从智能体进程到 agent-server 内部和远程机器的信任边界。已安装的 plugin 属于由管理员信任的代码。对于 portable 的根目录 `mcp.json`，分配时的确认会明确展示新增的能力，但它既不是沙箱，也不是独立的授权边界。legacy 的 Claude-native MCP 配置不经过这一确认。Cortex 施加以下控制：

1. **注册级可用性** — Cortex 内置服务器只注册为该会话选中的逻辑工具面，可选的规范化工具 allowlist 会进一步过滤。顶层会话获得 core 和 ext 工具，用户发起的会话再加交互工具，团队主会话加 worker 工具，worker 加 `mark_routine`，会话所属平台再加上它的投递工具。子智能体拿不到任何委派工具。

2. **独立的 Claude 配置** — Cortex 启动的每个 Claude 进程都以 `CLAUDE_CONFIG_DIR=$CORTEX_HOME/data/claude` 运行，因此为你终端里的 Claude Code（`~/.claude`）配置的 MCP 服务器和 plugin 不属于 Cortex 会话。执行环境的 `settingSources` 可以进一步限定 Claude 读取哪些设置文件。显式分配的 legacy plugin 目录中的 Claude-native `.mcp.json` 仍会被 Claude 加载。

3. **绕过权限确认** — Claude Code 以 `--dangerously-skip-permissions --permission-mode bypassPermissions` 启动，即不会对每次 MCP 工具调用弹出确认。访问控制发生在 MCP 工具的实现层、`agent:pre-tool` hook 以及服务器的 webhook token 上。

4. **网络边界** — 与远程机器通信的 MCP 工具经过 client-manager 的 WebSocket 层。只有在 `machines.json` 中注册的设备才能连接，也只有拥有活跃 WebSocket 连接的设备才能接收命令。

## 传递给 MCP 服务器的环境变量 {#environment-variables-passed-to-mcp-servers}

Cortex 内置服务器根据以下变量构建每个会话的上下文。在 Claude 下，它们设置在 stdio 子进程的环境中；在 PI 下，同样的值直接传给进程内的服务器。

| 变量 | 来源 | 使用者 |
|---|---|---|
| `SLACK_CHANNEL`, `FEISHU_CHANNEL` | 会话的频道 | 平台能力组选择、交互工具、文件投递、子智能体与团队路由 |
| `SLACK_BOT_TOKEN` | 服务器环境 | cortex-slack（`slack_send_file`） |
| `CORTEX_SESSION_ID` | 会话上下文 | 交互工具、`cortex_context`、waitpoint、Web 投递 |
| `CORTEX_PROJECT`, `CORTEX_BACKEND`, `CORTEX_MODEL`, `CORTEX_PROVIDER`, `CORTEX_THINKING`, `CORTEX_MODE` | 会话上下文 | `cortex_context` |
| `CORTEX_SCHEDULE_TASK_ID`, `CORTEX_CALLBACK_SOURCE` | 定时或回调触发的运行时设置 | `cortex_context` |
| `CORTEX_WEBHOOK_TOKEN`, `WEBHOOK_PORT` | 服务器环境 | 所有调用 loopback webhook 的工具 |
| `CORTEX_MCP_BUNDLES` | 后端进程的 composition | 内置服务器中的能力组选择 |
| `CORTEX_MCP_TOOL_ALLOWLIST` | agent 角色或子智能体 spawn | 工具注册过滤 |
| `CORTEX_CLAUDE_MODEL`, `CORTEX_SUBAGENT_PI_MODELS`, `CORTEX_SUBAGENT_CLAUDE_MODELS` | 会话模型与模型目录 | `agent` 和 `worker_spawn` 的模型说明 |
| `PLUGIN_ROOT` | 解析后的所选 plugin 根目录 | Portable stdio plugin 服务器 |
| `PLUGIN_DATA` | 每个 plugin 私有的持久数据目录 | Portable stdio plugin 服务器 |

## 安全考量 {#security-considerations}

MCP 工具赋予智能体在远程机器上执行 shell 命令、读写文件、委派给子智能体和 worker，以及向聊天平台发消息的能力。安全假设如下：

- `cortex-client` 的 WebSocket 端口（3002）要求每个连接都提供 `CORTEX_CLIENT_TOKEN`，但仍最好不要暴露到公网：使用 Tailscale、VPN、隧道或仅绑定 localhost（网络拓扑选项见 [cross-machine.md](./cross-machine.md)）。
- Webhook HTTP 端口（3001）只绑定到 `127.0.0.1`，并要求 `CORTEX_WEBHOOK_TOKEN`——MCP 服务器通过 loopback 而不是网络与之通信。
- 智能体运行在 [safety-and-approvals.md](./safety-and-approvals.md) 所述的同一套影响范围安全边界之内。MCP 工具不会让高权限操作豁免于该边界。
