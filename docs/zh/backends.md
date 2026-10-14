# 后端 {#backends}

后端是 Cortex 对特定编程智能体的适配器。Cortex 不直接调用 LLM API，而是驱动一个编程智能体——Claude Code 以子进程运行，PI 以服务器进程内的会话运行——向其发送消息，并消费标准化的事件流。每个后端实现 `agent-server/src/agent-adapter/types.ts` 中定义的 `EngineAdapter` 接口。

## 支持的后端 {#supported-backends}

| 后端 | 状态 | 引擎 | 前置要求 | 功能级别 |
|---|---|---|---|---|
| Claude Code | 已支持 | `@anthropic-ai/claude-code` | `PATH` 上有 `claude` 可执行文件 | 完整 |
| PI | 已支持 | `@earendil-works/pi-coding-agent`，随服务器包一起安装 | 除已登录的 provider 外无其他要求 | 完整 |

## 后端如何工作 {#how-backends-work}

从一条消息到一个后端进程，涉及三个名词：**运行（run）**、**会话（session）**和**引擎（engine）**。

**运行**是一次用户请求的一次执行：一个对话回合、一个钩子注入的回合、一次编辑重试、一次 ask-user 续跑，或一个子智能体。`startRun`（`domain/runs/service.ts`）根据一个完全解析好的 `RunRequest`（profile、提示、策略与上下文）以及观察它的 observer 打开一次运行，并返回 `AgentRun`（`domain/runs/run.ts`）；后者持有这次运行的事件流、取消与 steer 句柄、回退链和结果。

**会话**是运行所延续的对话身份：稳定的 Cortex session id、后端自身的 resume id、它运行的 profile，以及它绑定的频道。会话拥有它恢复进去的那个引擎。运行复用其会话池中的引擎；钩子注入的回合有自己的 engine key 与引擎。

**引擎**就是后端进程本身——池化的 `claude` 子进程，或进程内的 PI SDK 会话。`SessionEngines`（`domain/runs/engines.ts`）是池化引擎的唯一持有者：`acquire(spec)` 在该 spec 的 engine key 对应的会话仍存活、且由同一 session identity 打开时复用它，否则将其退休并新开一个。适配器是无状态的；它依据 `EngineSpec` 打开一个会话，并翻译该会话发出的内容。

配置每次运行只解析一次。`resolveRunConfig`（`domain/runs/config-resolver.ts`）按优先级选定 profile——显式 override、会话记录的 profile、频道的 profile、active profile，最后是 `profiles.json` 的 `defaultProfile`——由 profile 提供后端、模型、provider、gateway mode、思考档位与回退链。`buildEngineSpec`（`domain/runs/engine-spec.ts`）把解析后的运行变成后端中立的 `EngineSpec`，适配器再把它翻译成后端原生形式：对 Claude Code 子进程是命令行参数，对进程内 PI 会话是 session options。

此后引擎发出一条 `RunEvent` 流（`agent-adapter/run-events.ts`）。每个适配器把其后端的原生事件翻译成 `agent-adapter/normalize/` 中声明的 `NormalizedEvent` 形状，`toRunEvent` 再为它们标上运行的阶段，因此运行层永远不需要知道运行的是哪个后端。

**一次运行比它的回合活得更久。** 后台任务完成时，Claude 会自己开一个回合，所以一次运行有两个结束，而且都在同一条流上。*前台结果*是对这次请求的回答：后端一跑完回合它就落定，`await run.result` 交给界面的就是它——回复会被渲染，状态消息可以进入等待状态，而此时运行仍然活着。*settled 结果*是把每一次续跑都合并进来的整次运行，终态记账、执行记录和成本归属读的是它。前台结果之后如何处理由策略决定（`RunRequest.policy.background`）：交互式回合为续跑保持会话打开（`hold`）；无法产生续跑、或调用方用不到续跑的运行，在第一个结果就结束（`none`）。

有界的是等待本身，不是工作。`ContinuationPhase`（`agent-adapter/continuation-phase.ts`）为后端报告已完成但从未通知的工作设置一个宽限计时器（`CORTEX_BG_GRACE_S`，90 秒），为仍在运行的工作设置一个上限（`CORTEX_BG_WAIT_MAX_S`，30 分钟）；两个默认值都在 `agent-adapter/bg-wait.ts` 中。宽限到期会结束这次运行；上限到期只结束*等待*——一个跑了一小时的隧道或监控任务，完成时它的续跑仍然会流进同一个会话。

## 功能矩阵 {#feature-matrix}

Cortex 定义了后端可能支持的四种能力。编排层在尝试后端特定操作之前检查这些能力。

| 能力 | Claude Code | PI | 描述 |
|---|---|---|---|
| `mid-turn-inject` | 是 | 是 | 向正在进行的回合注入用户输入 |
| `usage` | 否 | 是 | 从拉取源或推送缓存报告限定范围的 provider 用量 |
| `background-continuation` | 是 | 否 | 在前台结果之后自行开启一个续跑回合 |
| `subagents` | 是 | 是 | 承载被委派的子智能体，其事件流式归入父回合并计入父回合费用 |

## Claude Code {#claude-code}

参考后端。每个会话运行一个持久化的 `claude -p` 进程，以 stream-json 输入输出。Cortex 按 session key 池化该进程，并通过同一 NDJSON 流发送后续回合，直到会话被关闭、超时或其 spawn identity 改变。

Claude Code 会话按 engine key 池化以复用（`SessionEngines`，`domain/runs/engines.ts`）。每个回合的费用是 CLI 自身累计 `total_cost_usd` 的增量，从恢复的会话起始时的累计值开始计算（参见[费用报告](#cost-reporting)）。

Cortex 启动的每个 `claude` 进程都以 `CLAUDE_CONFIG_DIR=$CORTEX_HOME/data/claude` 运行，这是 Cortex 自己的 Claude Code 配置目录，因此它的 transcript、用户设置、plugin 和登录都与使用 `~/.claude` 的终端 `claude` 分开。pinned 基准测试 trial 保留其自身环境指定的配置目录。该目录、从 `~/.claude/settings.json` 的一次性 seed，以及 plugin 安装命令见[配置 → Claude Code 配置目录](./configuration.md#claude-code-config-directory)。session-retention 协调器让该目录的 `cleanupPeriodDays` 与运行时设置 `sessionRetentionDays` 保持一致，其余键保持原样。

## PI {#pi}

PI 在 Cortex 服务器进程内运行。引擎（`@earendil-works/pi-coding-agent`）打包在发布的服务器包中，因此既不需要单独安装 `pi` 命令行，也没有 PI 进程需要看管。`agent-server/src/core/pi-sdk.ts` 每个守护进程只导入一次 SDK——在第一次 PI 会话或 provider 扫描时导入，因为入口会拉起全部 provider 客户端——之后所有 PI 会话都由这一个句柄创建。

**会话。** 每个 Cortex 会话跑在一个 PI SDK `AgentSession` 上。`session-options.ts` 把 spawn 配置解析成 session request，`runtime.ts` 据此构建会话：为工作目录创建 `SettingsManager`，创建从 Cortex 私有 PI agent 目录读取 `auth.json` 与 `models.json` 的 `ModelRuntime`，再依次调用 `createAgentSessionServices` 与 `createAgentSessionFromServices`。会话按 session key 池化并跨回合复用。spawn identity 改变时池中会话会被退休——模型、工具面或 MCP 集合的变化无法应用到活着的会话上——空闲或被显式 teardown 关闭时同样退休。`pi-session.ts` 负责回合循环、经 SDK steer 路径的回合中插话、compaction，以及把活会话重新指向另一份 transcript。恢复时给出 session id 或 transcript 路径；`session-files.ts` 把 id 映射到对应文件。Transcript 写在 `$CORTEX_HOME/logs/sessions-pi/` 下。

**回合内压缩。** 一个 Cortex 回合就是一整个 PI agent loop，所以工具驱动的长回合必须能在 loop 内部压缩。PI 自己就会做：工具结果落定之后、下一次 assistant 回复之前，如果上下文已越过 `contextWindow - reserveTokens` 就压缩，然后继续同一次运行，因此回合不会被中止，仍是同一个 Cortex 回合。Cortex 只负责设定阈值——`piCompactReserveTokens`（默认 16384，即 PI 自己的默认值）会在会话创建时写进私有 agent 目录的 `settings.json`，余量越大 PI 压缩得越早，留下的工作空间也越多。Claude 不需要这些：CLI 自己就会在回合内压缩。

**上下文上限。** `maxContextTokens` 限制两个后端所有模型的可用窗口。Claude 以 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 接收它。在 PI 上，Cortex 不改模型自身的窗口（PI 还用它判断溢出），而是把 `runtime-settings.ts` 上报的余量加上窗口超出上限的部分。于是 PI 在 `cap - piCompactReserveTokens` 处压缩；余量最多取上限的一半，避免余量过大导致每个回合都压缩。

**Cortex 的粘合层。** Cortex 附加的一切都是按会话在 `extensions.ts` 中装配的一组 inline PI extension：

- **图片优先**（`image-first.ts`）——在每次请求中把工具结果里的图片移到文本之前。
- **MCP 桥接**（`mcp-bridge.ts`）——把按 composition 限定的 Cortex 工具 bundle 以进程内方式经一对内存 MCP transport 提供出来，并绑定到专为该会话构建的 tool context。被指派的 plugin MCP server 与 browser MCP 仍各自保有独立的 stdio 子进程或远程连接。
- **工具垫片**（`tool-shims.ts`）——注册 PI 本地的 `web_fetch`、`web_search` 与 `todo_write` 工具，每个都按其 Claude 名称（`WebFetch`、`WebSearch`、`TodoWrite`）受会话的工具允许列表约束；在会话可以委派时，还注册 `agent` 与 `agent_stop` 委派工具（参见[子智能体](#subagents)）。
- **钩子桥接**（`hook-bridge.ts`）——把钩子注册表中面向 `pi` 后端的条目挂成 PI 原生事件处理器，Cortex 钩子脚本因此能看到 PI 的工具事件。参见 [hooks.md](./hooks.md)。
- **额度探针**（`quota-probe.ts`）——在经网关路由的运行中从响应头读取 provider 额度，并把每次读数交给限流器。

系统提示覆盖、追加提示与 Cortex 插件 skill 目录都是 session options（`systemPrompt`、`appendSystemPrompt`、`additionalSkillPaths`），而不是命令行标志。

**交互工具。** 用户发起的直接 PI 会话会把 interaction bundle 加入其进程内的 Cortex 工具集，因此 PI 暴露与 Claude TUI、Claude print 相同的 `cortex_ask_user`、`cortex_plan_enter` 与 `cortex_plan_exit` 工具。它们的对话框走 PI 的 extension UI 协议，由 `ui-context.ts` 在服务器内应答；参见 [safety-and-approvals.md](./safety-and-approvals.md)。

**缓存预热。** Cortex 在主会话和子智能体会话中都关闭 PI 的自动 prompt-cache 预热。provider 的普通提示缓存仍可使用；Cortex 不会额外发起用量不在其费用统计之内的预热请求。这是运行时覆盖，不会改动终端 PI 的设置。

**凭据。** PI 的 provider 凭据由 Cortex 管理——聊天里的 `!login pi`，或网页端的**设置 → 账号**——并保存在 PI 自己的认证文件 `~/.pi/agent/auth.json` 中。Cortex 让该文件在其私有 PI agent 目录内可见（Linux 与 macOS 用符号链接，Windows 用复制）供 SDK 读取，并从 `~/.pi/agent/models.json` 读取用户自定义的 provider。因此同时装有终端 `pi` CLI 的安装与 Cortex 共用同一份凭据和同一份 provider catalog。

PI transcript 的保留基于文件系统。活跃的 PI 后端 session id 在保留扫描中受保护，而 `$CORTEX_HOME/logs/sessions-pi/` 下的孤立 transcript bundle 只有在超过保留截止线后仍无引用、且经过第二轮确认扫描后才会删除。

PI provider 名称与 Cortex 后端名称相互独立。特别地，`openai-codex` 是受支持的 PI provider（包括 `openai-codex-responses` API kind）；使用它的 profile 仍须设置 `"backend": "pi"`。

## 子智能体 {#subagents}

两个后端通过同一个工具、同一张角色表和同一个 runner 进行委派，且任一后端都可以做父端或子端。Claude 的回合可以把工作交给 PI 模型，PI 的回合也可以交给 Claude。

**工具。** PI 在进程内注册 `agent` 与 `agent_stop`。Claude 以 MCP 工具形式拿到同一对工具（`mcp__cortex-core__agent`、`mcp__cortex-core__agent_stop`），同时它内置的 `Agent` 工具会在每次 spawn 时被剥离，因此不存在守护进程看不见的第二条委派路径。一次调用可以跑单个任务、最多八个并行任务，或最多八个串行任务；串行提示里的 `{previous}` 会被替换成上一环的输出。

**角色。** 角色是带 YAML frontmatter 的 markdown 文件。`explore`、`general-purpose` 与 `plan` 是内置角色，从安装目录的 `agent-server/defaults/agents/` 读取；`$CORTEX_HOME/config/agents/` 中的文件新增一个角色，或替换同名的内置角色，删除该文件即恢复内置角色。角色正文追加到子会话的系统提示。其 frontmatter 必须设置 `name` 与 `description`——缺少它们的文件会被忽略——并可以设置：

| 键 | 含义 |
|---|---|
| `tools` | 规范工具名，翻译成各后端自己的拼写 |
| `model` | PI 子智能体用 `provider/model[:thinking]`，Claude 子智能体用裸模型 id |
| `backend` | `claude` 或 `pi`；不填表示"父端运行的是哪个就用哪个" |
| `mode` | 子智能体的显式 gateway 路由；不填时回退到 provider 名 |

当 `$CORTEX_HOME/config/agents/` 尚不存在时，Cortex 私有 PI agent 目录内 `agents/` 目录中的角色会在启动时被移入其中，该目录随后被改名为 `agents.migrated`，这样在那里做的修改不会悄无声息地毫无效果。

**模型如何选定。** 不查 profile。模型依次取任务显式给出的 `model`、角色的 `model`，最后是父端自己的模型——但最后一项仅在子端与父端运行同一后端时适用，因为 Claude 的模型 id 对 PI 毫无意义，PI 的 `provider/model` 对 Claude 亦然。

**调用方能看到什么。** `subagent_type`、`model` 与 `backend` 三个字段的描述在注册工具时按本机实际拥有的内容生成，而不是写死。角色取自实时的角色表——内置角色叠加上 `$CORTEX_HOME/config/agents/`——因此你新增的角色在下一个会话就会出现。Claude 模型 id 来自 Cortex 生成 gateway 的 Anthropic 路由所用的同一张表，再加上守护进程当前的模型。PI 父端读取自己的实时模型注册表；Claude 父端读不到，因为它的 MCP 工具运行在没有 PI SDK 的 sidecar 进程里，所以守护进程把自己缓存扫描到的 provider/model 对经 spawn 环境传下去。缓存为空只意味着暂时还列不出 PI 模型——不会为了装饰一次 Claude spawn 而触发扫描。角色和模型各自有字符预算，超出部分渲染为 `(+N more)`。这些列表是快照，会话中途不会变化；它们是提示而非白名单：未列出的模型 id 仍会被接受并透传。一无所知时，描述回退到通用措辞，工具不会因为缺少 catalog 而失败。

**隔离。** `pi` 子端是一个不写 transcript、headless 运行的嵌套进程内会话。`claude` 子端是一次冻结的一次性 `claude` 运行：没有可恢复的会话、没有钩子、没有环境规则、没有 transcript 日志。无论哪种，子端的 MCP 面都是去掉委派工具后的 `cortex-core` bundle，因此不能继续向下扇出。

**父端看到什么。** 子端的工具调用、结果与文本会流入父端的实时 transcript 并归属到该子智能体，其 token 用量并入父端。归属是 best-effort：父回合已经结束的运行只是停止推送，答案照样返回。

**后台运行。** `run_in_background: true` 会立刻返回一个 `agent_id`。Cortex 在运行期间保持会话打开——停止按钮够得到它，延迟的守护进程重启也会等它——并在答案就绪时作为一个普通回合投递；如果此时有回合在跑，就并入那个回合。`agent_stop` 提前取消运行并丢弃已产出的内容。停止一个会话也会停掉它委派出去的运行，前台和后台都一样：子端不会比请求它的回合活得更久。

## 远程登录 {#remote-login}

无需 SSH 登录 Cortex 主机，也可以远程完成后端登录。同一登录流程有三个渠道入口：

| 渠道 | 入口 | 交互方式 |
|---|---|---|
| Slack | 发送 `!login`、`!login cc` 或 `!login pi [provider]` | 选择器和 secret 输入在 Slack modal 中打开；授权链接发送到频道。 |
| 飞书 | 发送 `!login`、`!login cc` 或 `!login pi [provider]` | 选择器和 secret 输入使用内联卡片表单；授权链接发送到聊天。 |
| Web（桌面与移动端） | 桌面端：打开**设置 → 账号**。移动端：点击**设置 → 账号**，进入 `/m/settings/accounts`。 | 账号分区展示 Claude Code 凭据与全部 PI provider，并提供状态及登录/登出操作，登录打开同一套选择器式流程。 |

聊天命令形式如下：

```text
!login
!login status
!login cc
!login pi
!login pi <provider>
!login custom
```

`!login custom` 管理没有登录流程的自建端点；见下文[自定义 provider](#custom-providers)。

无参数的 `!login` 与 `!login status` 都显示认证状态总览。`!login cc` 选择 Claude Code。`!login pi` 打开 PI provider 选择器；附带 provider 时跳过该选择器。provider 支持多种认证类型时，认证类型同样在交互中选择。不要在命令后追加 `oauth`、API key、授权码或 provider 专用的 OAuth 参数。

同一后端/provider 组合同时最多只有一个进行中的登录。发起登录会取消该组合尚未结束的登录，无论它由哪个渠道发起；除非那次登录已在保存提交的凭据，此时新的发起会被拒绝，直到它结束。登录失败时，先显示 Cortex 的提示，再附上 provider 自身原因的第一行。

只有当已安装 PI provider 的 `provider.auth.oauth.login` 是函数时，才提供 OAuth。清单从已安装的 PI 运行时中发现，因此只支持 API key 的 provider 不会显示无法使用的 OAuth 选项。Claude Code 同样通过选择器提供 API key 与订阅两种选项。

对于 Claude Code 订阅，Cortex 针对自己的 Claude 配置目录启动 `claude auth login --claudeai`，把命令输出的授权 URL 发送到发起渠道，并把返回的 code 写入该命令的标准输入。OAuth 交换和凭据持久化由 Claude Code 负责。只有在清空认证相关环境变量后执行的 `claude auth status --json` 报告 `loggedIn: true` 时，Cortex 才把流程标记为完成；它从不读取或保存最终的 token。订阅登出同样交给 `claude auth logout`，并验证登出后的状态。旧版由 Cortex 管理的订阅 token 在 Claude Code 未登录期间仍是可删除的运行时凭据，但它不会让账号显示为已登录，并会在 Claude 拥有凭据后立即被抑制。

运行中的后端报告认证过期时，Cortex 会发送一张点名 provider 的卡片，提供一键重新登录，并预填失败的那种认证方式：对 Claude Code，运行使用 `api` 模式时是 API key，否则是订阅。该登录进行中时，按钮会重新打开它；登录失败、被取消或过期后，按钮会发起一次新的登录。每日过期扫描检查使用中的账号，并对即将过期、已过期或缺失的凭据发送同一种可操作提醒。若某个 provider 在提醒窗口内已被运行时通知报告过，每日扫描会跳过它，因此定时预警不会重复你刚收到的通知。反方向是有意为之：运行时失败总会通知，即使每日扫描之前已对该 provider 预警过，因为会话中的失败正是你那一刻最需要的消息。

在主机上做只读状态检查，可运行：

```bash
cortex auth status
cortex auth status --json
```

文本形式是简洁总览；`--json` 返回完整的归一化状态快照。两者都不包含凭据。精确命令契约参见 [CLI 参考](./cli-reference.md#cortex)。

## 自定义 provider {#custom-providers}

自定义 provider 指 PI 没有内置定义的端点：本地推理服务、实验室的 GPU 机器，或公司代理。它没有登录流程——没有厂商可供认证——所以它是被定义出来的而不是登录进去的，管理入口与其他一切相同，共三处：

| 入口 | 用法 |
|---|---|
| CLI | `cortex auth provider list \| add \| remove` |
| Web（桌面与移动端） | **设置 → 账号 → 自定义 Provider** |
| Slack / 飞书 | `!login custom [list \| add <name> <api> <url> <model…> \| remove <name>]` |

一条定义需要四样东西：名称、端点使用的请求协议（`anthropic-messages`、`openai-completions`、`openai-responses` 或 `google-generative-ai`）、上游 URL，以及至少一个模型 id。上游密钥可选；不填时网关会透传调用方自己的 key。

保存会写两份文件。`~/.pi/agent/models.json` 新增一条 `providers.<name>`，其 `baseUrl` 指向网关，因此终端的 `pi` 与 Cortex 共用同一份定义。`~/.aistatus/gateway.yaml` 新增转发到真实端点的路由，并携带上游密钥。**密钥只存在于网关配置中**——PI catalog 里放的是占位符，所以到处复制 catalog 也不会复制出密钥。因此每次调用都经过网关，与其他路由一样计入用量并受限流。生成的网关配置设置 `max_body_size_mb: 100`。在 aistatus 0.0.8 及以上版本中，该值以 MiB 为单位限制每个缓冲的请求体；要使用其他限额，修改这个顶层值即可。网关会自行重新加载配置，因此路由和请求体限额的变更都无需重启。

聊天命令刻意不提供密钥参数：频道记录不适合放密钥。请用 CLI 的 `--key -`（从标准输入读取）或 Web 表单添加密钥，两者都不会把它留在任何记录里。

要使用自定义 provider，添加一条指向它的 profile，例如 `{"backend": "pi", "provider": "my-vllm", "mode": "my-vllm", "model": "Model-27B"}`（profile 结构参见 [configuration.md](./configuration.md)）。删除 provider 会同时移除 catalog 条目与网关路由；仍指向它的 profile 将无法解析，因此请先把它们改指向别处。

## 选择后端 {#selecting-a-backend}

后端在 `$CORTEX_HOME/config/profiles.json` 中按 profile 选择（完整的 profile 结构参见 [configuration.md](./configuration.md)）：

```json
{
  "defaultProfile": "plan",
  "profiles": {
    "plan": {
      "backend": "claude",
      "model": "opus",
      "mode": "plan"
    },
    "deepseek": {
      "backend": "pi",
      "provider": "deepseek",
      "mode": "deepseek",
      "model": "deepseek-v4-pro"
    }
  }
}
```

`backend` 字段接受 `"claude"` 或 `"pi"`。省略时默认为 `"claude"`。`pi` profile 必须指定 `provider`，它决定请求协议和 gateway 端点；没有默认值。`mode` 是运行所走的 gateway 路由——对 Anthropic 端点而言是 `plan`（订阅）或 `api`（计量密钥）。在聊天中，`!profile <name>` 切换频道的 profile，`!backend <claude|pi>` 把频道切换到该后端的默认 profile（`profiles.json` 中的 `defaultProfileByBackend`）。对于已经在另一后端上有回合的对话，两者都会被拒绝。

## 按会话选择模型、思考档位与路由 {#per-session-model-thinking-level-and-route}

在直接对话里，profile 是**基座**而不是全部。Web 输入框上的引擎胶囊会打开一个选择器，分段依次是 profile、模型、思考档位，以及——当该端点有不止一种计费方式时——路由。（其中的 `agent` 一行完全属于另一条轴——会话的执行环境而非引擎；见 [configuration.md](./configuration.md#choosing-an-environment-per-conversation)。）profile 以下的所有选择都作为按会话生效的覆盖值，叠在该会话所用的 profile 之上。覆盖只在一个地方应用（`effectiveProfile`），所以后端、`extraEnv` 与回退链仍由 profile 提供；能被替换的只有 `model`、`provider`（在 `pi` 上）、`thinking` 和 `mode`。每个选择器分段都有一行「跟随 profile」，用来把该字段交还给 profile。

选择器受两条规则约束，两条都由服务端强制执行，并由客户端提前预览：

- **已开始的对话不换后端。** 想用另一后端上的模型，要切换到运行它的 profile；而已有回合的会话不能做这个切换——对应行会灰显，并提示需要新建会话。新草稿可以自由切换。
- **指定 profile 会清除会话的覆盖值。** 选择 profile 意味着「按声明运行这个 profile」；模型与思考档位回到它所写的值。

选择一个 provider 与 profile 不同的 PI 模型时，会话会改挂到一个已经运行该 provider 的同级 profile 上，以便使用已配置的 gateway 路由而不是猜一个；没有这样的 profile 时，路由回退到 provider 自己的名字。在这里选定的思考档位也优先于 profile 的 `extraOption` 中残留的 `--effort` / `--thinking`，否则那些标志会不声不响地胜出。

**路由**是 gateway 端点的计费通道：Anthropic 端点声明 `plan`（订阅）与 `api`（计量密钥），选哪条就决定由哪条为下一个回合付费。只提供该端点在 `gateway.yaml` 中实际声明的通道；只有一条通道的端点不提供选择，这一段也就不出现。

选择器读取的正是 profile 编辑器所用的那份 `models.catalog`：每个 gateway 端点一条，带有该端点的后端、provider、通道与模型。档位列表是该后端自己的取值范围（见下文），并在 PI 报出所选模型自己的档位阶梯时收窄到那一份——PI 各模型接受的档位并不相同。如果主机上既没有 PI profile 也没有 PI 凭据，PI 那一半会被整体跳过，因此不会仅为画一个菜单就加载 PI SDK；首次 provider 扫描进行中时，菜单会如实说明，而不是把半份列表当作全部。

新对话从本机上一次选定的引擎开始——profile 与覆盖值一起——而不是每次都退回默认 profile。

平台频道保留自己的控制方式：`!profile <name>` 切换频道的 profile，`!model <id>` 在其之上设置频道的模型，`!thinking <level>` 设置其思考档位。`!model reset` 与 `!thinking reset` 把该字段交还给 profile。它们都按选择器所用的同一条规则写入。

## 思考档位 {#thinking-level}

可选的 `thinking` profile 字段设置后端的推理深度，取值使用后端自己的值集。Claude Code 接受 `low`/`medium`/`high`/`xhigh`/`max`，以 `--effort` 标志传入；PI 接受 `off`/`minimal`/`low`/`medium`/`high`/`xhigh`，作为会话的思考档位传入。字段缺省时后端使用自身默认值。fallback 条目不继承主条目的值——每个条目自行声明。

## 回退行为 {#fallback-behavior}

每个 profile 条目可以指定一个 `fallback` 数组作为备选条目。当一次尝试因可重试错误失败时，Cortex 按顺序转到下一个条目。可重试指速率限制、用量限制、过载或额度拒绝（包括后端标记为 rate-limited 的结果）、HTTP 408 或 5xx、连接被重置或超时之类的传输失败，或 provider 消息表明请求可以重试。认证错误与永久性拒绝——无效请求、超出上下文窗口、余额耗尽——从不回退。已经开始工具调用的尝试也不会重试，因为回退会把该工具再运行一次；回合以一条请你重新发送的消息结束。

每个 fallback 条目自行声明 `model`。省略时它从主条目继承 `backend` 与 `mode`，此外不继承任何字段：`provider`、`thinking`、`extraEnv`、`extraOption` 与 `maxOutputTokens` 只在写明处生效，`pi` 条目必须指定 `provider`。

示例：

```json
{
  "plan": {
    "backend": "claude",
    "model": "opus",
    "mode": "plan",
    "fallback": [
      { "backend": "pi", "provider": "deepseek", "mode": "deepseek", "model": "deepseek-v4-pro" }
    ]
  }
}
```

## 用量限流与自动恢复 {#usage-limit-throttling-and-auto-resume}

回退链处理单次失败的调用，滚动用量窗口由另一套机制处理。provider 标识是不透明字符串，因此限流器可以跟踪任意数量的 provider，无需固定的 provider 枚举。每个 provider 保有自己的窗口类型和重置时间。限流门禁作用于 provider 与 route mode 的组合，不会阻塞恰好使用相同 mode 名称的另一个 provider。

这套策略在 [`config/settings.json`](./configuration.md#configsettingsjson) 中以 `providerRateLimits` 配置，它是一个以 provider id 为键的对象。每个 provider 可以有一个由 `{ type, label?, enabled, threshold? }` 条目组成的 `windows` 数组，因此 5 小时、weekly、含超额 weekly、Codex 主/次窗口以及带标签的模型窗口都能独立配置。`threshold` 是大于 `0` 且不超过 `1` 的比率；省略时，weekly 窗口（`seven_day`、`seven_day_overage_included`）使用 `0.95`，其他所有窗口（包括 `five_hour`）使用 `0.90`。精确窗口策略优先于可见且可清除的旧版 provider 回退。桌面端和移动端的用量页面编辑这些行；只统计花费的 provider 不显示额度控件。

### 为什么限额信号是注入而不是流式发送 {#why-a-rate-limit-signal-is-injected-not-streamed}

适配器通过注入的回调（`RateLimitReporter`）把 provider 的限额窗口上报给宿主，而不是发一条 `RunEvent`。后端在回合之间以及自发续跑回合期间发出 `rate_limit_event`，也就是恰好没有回合在进行的时候——把它塞进按回合的事件流，会丢掉最关键的那次观测。因此 `RunEvent` 中的 `rate_limit` 只作为 transcript 层面的通知存在（`agent-runner` 忽略它），限流器本身由注入的 reporter 提供数据。额度观测走同一条路径。

被中断的对话会连同限制它的 provider 一起保存。某个 provider 完全恢复后，Cortex 只恢复该 provider 的工作；属于其他仍受限 provider 的条目继续排队。对话在原频道恢复，之前的上下文完整保留。恢复会错开启动，避免刚开放的窗口立刻再次耗尽。

当前限流详情会显示每个 provider 正在等待的对话数，并保留同时生效的模型窗口的标签。provider key 是隔离边界：在同一 provider key 下上报的多个账号或额度池共享一条 provider 记录，类型与标签都相同的窗口保留较晚的重置时间。定时限流需要带重置时间的观测。Claude 实时账号用量拉取会为每个已配置的 Anthropic mode 提交所有上报的窗口，而过期的 PI 缓存读数从不重放；PI 响应头观测经其推送路径到达，每次用量采集对 OpenAI Codex 与 Claude 账号的读取见[下文](#account-usage-and-banked-resets)。

策略改动只作用于未来的额度观测，不会改写已经生效的窗口。已生效的额度窗口或 outage 重试窗口会持续生效，直到其重置时间或被手动 **立即恢复** 清除；Codex 或 Claude 额度窗口在新的账号读数显示低于阈值时也会解除。outage 重试行为使用自己的 outage 窗口，不受额度策略阈值改动影响。

限流窗口与带 provider 归属的恢复条目持久化在 `data/provider-state.json` 中。启动时 Cortex 会重新装载仍有效的计时器，并立即恢复那些 provider 窗口在停机期间已到期的条目，即使另一个 provider 仍受限。旧数据中没有 provider 的条目会等到所有生效的 provider 都解除。已有活跃对话的频道会被跳过；仅凭已过去的时长不会丢弃工作。

自动恢复默认开启。在 [`config/settings.json`](./configuration.md#configsettingsjson) 中设置 `"autoResume": false`，会丢弃已就绪的恢复条目而不是自动派发；改动无需重启守护进程即可生效。`.env` 中的旧变量 `CORTEX_AUTO_RESUME=0` 仍作为已弃用的回退被读取。

### 账号用量与储备重置 {#account-usage-and-banked-resets}

每次用量采集——内置的 provider 用量作业、打开用量页面，或点击 **刷新**——都会直接读取两个订阅账号：

- **OpenAI Codex**，以 ChatGPT 套餐登录。读数填入 Codex 订阅行的主窗口与次窗口。读取失败时，该行保留上次从 Codex 响应头观测到的窗口，并附上相应说明。
- **Claude**，通过 `claude login` 登录。读数填入 Anthropic 订阅行的 5 小时与 7 天窗口。Cortex 使用 Claude Code 保存的访问令牌，且无法刷新它，因此令牌过期、使用 API key 或未登录时，该行回退到网关的额度观测；读取失败时同样回退，并附上说明。账号只向当前版本的 Claude Code 客户端提供重置，因此这些请求以本机安装的 `claude` CLI 版本标识自己。

每次读数还会列出账号的储备重置：可用数量，以及最早一个的过期时间。账号读数从不开启限流，但会解除该 provider 已回落到阈值以下的限流窗口，因此在其他设备上使用的重置同样会放行 Cortex 暂停的工作。

储备重置作用于整个账号、所有设备，且无法撤销。Codex 重置恢复 Codex 用量窗口，在发放约 30 天后过期。Claude 重置清空其授予项列出的窗口——通常是 5 小时、7 天与含超额 7 天限额——对 claude.ai 及其他所有 Claude 客户端同样生效。Cortex 从不自行使用重置。在桌面端与移动端用量页面的 Codex 与 Anthropic 卡片上，有可用重置时会显示 **重置**，并先请求确认；Claude 的确认会列出该重置将清空的窗口，并在账号未达限额时显示这些窗口的当前用量。Cortex 使用账号下一个提供的重置，否则使用最早过期的那一个。在聊天中，`!usage` 显示同样的数量与过期时间，并带有 **重置 Codex** 或 **重置 Claude** 按钮，点击后在线程中发出确认提示；账号持有重置时，Codex 或 Claude 限流通知会在 **立即恢复** 旁带上该按钮。重置后，Cortex 清除该 provider 的限流、恢复它暂停的工作，并在几秒内反复读取用量，直到账号显示被清空的窗口已恢复。账号拒绝时——没有可重置的内容、重置已被使用、处于冷却期，或账号当前无法使用重置——不会消耗重置，Cortex 会说明属于哪种情况。

## 费用报告 {#cost-reporting}

费用报告因后端而异：

- **Claude Code** — 读取 CLI 在每个回合结束时报告的累计 `total_cost_usd`，记录相对上一回合的增量，以及同一结果中的 token 计数。恢复的会话从 CLI 恢复出的累计值开始，因此其历史不会被重复计费。记录写入 `$CORTEX_HOME/data/costs.jsonl`。
- **PI** — 读取会话在每条 assistant 消息上报告的用量（`input`、`output`、`cacheRead`、`cacheWrite` 与 `cost.total`），按回合汇总为一条记录，并标注实际服务的 provider 与模型。provider 未报告的 token 字段记为未知，而不是记为 0。记录同样写入 `$CORTEX_HOME/data/costs.jsonl`。

所有费用记录遵循相同的 JSONL 格式，并受 90 天滚动保留窗口约束。通过 MCP 工具进行的费用查询会汇总所有后端——`cost_query` 工具参见 [mcp.md](./mcp.md)。

## 添加新后端 {#adding-a-new-backend}

新后端在 `agent-server/src/agent-adapter/` 下的新目录中实现 `EngineAdapter` 接口。所需接口：

1. **`adapter.ts`** — 以 `open(spec)` 实现 `EngineAdapter`，返回一个 `EngineSession`。适配器无状态：池由 `SessionEngines` 持有。
2. **`EngineSession`** — 带有其 `backend`、`identity` 与 `backendSessionId`，并提供用于一个回合的 `run(prompt, opts)`，返回一个 `EngineRun`：其 `events` 是 `RunEvent` 的异步可迭代对象，其 `result` 是前台 `AgentResult`，其 settled 结果合并任何续跑，并带有 `cancel()`；另有 `steer()`、`respondToDialog()`、`ingestExternal()`、`compact()`、`close()` 和 `kill()`。
3. **事件翻译** — 把后端的原生事件格式转换为 `NormalizedEvent` / `RunEvent` 成员（对 Claude 而言是 `event-parser.ts` 与 `event-translator.ts`）。
4. **注册** — 把适配器加入 `domain/runs/adapters.ts` 中的装配，并在 `domain/runs/engines.ts` 的 `SessionEngines.acquire` 中加一个分支；把能力加入 `capabilities.ts`；把后端标签加入 `core/types/agent-types.ts` 中的 `Backend` 类型联合。承载子智能体的后端还需要在 `domain/agents/subagent/runner.ts` 中加一个分支。

共享部分位于适配器旁边：`agent-adapter/normalize/` 中的标准化事件类型、提示构建与工具结果图片处理，`agent-adapter/run-events.ts` 中的 `RunEvent` 队列，以及 `core/tool-names.ts` 中的工具名翻译。
