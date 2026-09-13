# 后端 {#backends}


后端是 Cortex 对特定编程智能体的适配器。Cortex 不直接调用 LLM API，而是驱动一个编程智能体——Claude Code 以子进程运行，PI 以服务器进程内的会话运行——向其发送消息，并消费标准化的事件流。每个后端实现 `agent-server/src/agent-adapter/types.ts` 中定义的 `EngineAdapter` 接口。

## 支持的后端 {#supported-backends}

| 后端 | 状态 | 引擎 | 前置要求 | 功能级别 |
|---|---|---|---|---|
| Claude Code | 已支持 | `@anthropic-ai/claude-code` | `PATH` 上有 `claude` 可执行文件 | 完整（11/11 能力） |
| PI | 已支持 | `@earendil-works/pi-coding-agent`，随服务器包一起打包 | 除已登录的 provider 外无需任何额外安装 | 完整（11/11 能力） |

## 后端如何工作 {#how-backends-work}

从一条消息到一个后端进程，只需要三个名词：**运行（run）**、**会话（session）**和**引擎（engine）**。

**运行**是一次用户请求的一次执行：一个对话回合、一个线程步骤、一个钩子智能体、一次编辑重试、一次 ask-user 续跑，或一个子智能体。`startRun`（`domain/runs/service.ts`）从一个完全解析好的 `RunRequest`（配置、提示、策略与上下文，不含回调）打开运行，并返回 `AgentRun`（`domain/runs/run.ts`）；后者持有这次运行的事件流、取消与 steer 句柄、回退链和结果。

**会话**是这次运行所延续的对话身份：稳定的 Cortex session id、后端自身的 resume id、它运行的 profile，以及它绑定的频道。会话拥有它恢复进去的那个引擎。运行复用其会话池中的引擎；不同的 engine key（线程步骤的 slot、钩子注入的回合）各有自己的引擎。

**引擎**就是后端进程本身——池化的 `claude` 子进程，或进程内的 PI SDK 会话。`SessionEngines`（`domain/runs/engines.ts`）是池化引擎的唯一持有者：`acquire(spec)` 在该 engine key 对应的会话仍存活、且由同一 session identity 打开时复用它，否则将其退休并新开一个。适配器是无状态的；它依据 `EngineSpec` 打开一个会话，并翻译该会话发出的事件。

配置每次运行只解析一次。`resolveRunConfig`（`domain/runs/config-resolver.ts`）按优先级选定 profile——显式 override、会话记录的 profile、频道 profile、全局 active profile，最后是 `profiles.json` 的 `defaultProfile`——由 profile 提供后端、模型、provider、gateway mode、思考档位与回退链。`buildEngineSpec`（`domain/runs/engine-spec.ts`）把解析后的运行变成后端中立的 `EngineSpec`，适配器再把它翻译成后端原生形式：对 Claude Code 是子进程的命令行参数，对 PI 是进程内会话的 session options。

此后引擎只发出一条 `RunEvent` 流（`domain/runs/events.ts`）。标准化层（`agent-adapter/normalize/`）把每个后端的原生事件格式翻译成 `NormalizedEvent`，`toRunEvent` 再为它标上运行的阶段，因此运行层永远不需要知道运行的是哪个后端。

## 功能矩阵 {#feature-matrix}

Cortex 定义了后端可能支持的十一种能力。编排层在尝试后端特定操作之前检查这些能力。

| 能力 | Claude Code | PI | 描述 |
|---|---|---|---|
| `hooks` | 是 | 是 | 通过 hook-bridge 的 PreToolUse/PostToolUse/Stop 钩子 |
| `plugins` | 是 | 是 | 角色限定的技能插件 |
| `mcp` | 是 | 是 | MCP 工具服务器集成 |
| `plan-mode` | 是 | 是 | EnterPlanMode/ExitPlanMode 工具支持 |
| `ask-user-question` | 是 | 是 | AskUserQuestion 工具支持 |
| `system-prompt-override` | 是 | 是 | 自定义系统提示注入 |
| `session-resume` | 是 | 是 | 恢复已有会话 |
| `tool-allowlist` | 是 | 是 | 将可用工具限制为子集 |
| `streaming-deltas` | 是 | 是 | 生成期间发布 token 级 assistant 文本 |
| `mid-turn-inject` | 是 | 是 | 向正在进行的回合注入用户输入 |
| `subagents` | 是 | 是 | 承载被委派的子智能体，其事件与用量归入父回合 |

## Claude Code

参考后端。支持所有十一种能力。定义了两种适配器模式；TUI 已废弃：

**Print 模式**（`claudeBackend: "print"`，默认）。使用持久化的 `claude -p` 进程以及 stream-json 输入输出。Cortex 按 session key 池化该进程，并通过同一 NDJSON stream 发送后续回合，直到 session 被关闭、超时或 spawn identity 改变。

**TUI 模式**（`claudeBackend: "tui"`，已废弃）。历史上会在 tmux 下生成交互式 Claude 会话，并尾随会话的 JSONL 文件获取事件。D9 已废弃该模式：适配器会警告一次，并以 print 模式运行该会话。

Claude Code 会话按 engine key 池化以复用（`SessionEngines`，`domain/runs/engines.ts`）。费用报告从 `message.usage` 令牌计数逆向推导 USD 费用，使用 Anthropic 发布的定价。

session-retention 协调器还会把 Claude 用户级 `cleanupPeriodDays` 同步到 `$CLAUDE_CONFIG_DIR/settings.json`（或 `~/.claude/settings.json`）里，值来源于 Cortex 运行时设置中的 `sessionRetentionDays`。这次写入只会 merge 进用户设置文件：保留所有其它 Claude 键，不会碰 spawn cwd 下的项目级 `.claude/settings.local.json` 或 `.claude/settings.json`，也不会借此接管 hook/permission 配置的归属。若用户文件里已是相同的 `cleanupPeriodDays`，则不会重写文件。

## PI

PI 在 Cortex 服务器进程内运行。引擎（`@earendil-works/pi-coding-agent`）随发布的服务器包一起打包，因此既不需要安装 `pi` 可执行文件，也没有 PI 进程需要看管。`agent-server/src/core/pi-sdk.ts` 每个守护进程只导入一次 SDK——因为入口会拉起全部 provider 客户端，所以推迟到第一次 PI 会话或 provider 扫描时才导入——之后所有 PI 会话都由这一个句柄创建。

**会话。** 每个 Cortex 会话跑在一个 PI SDK `AgentSession` 上。`session-options.ts` 把 spawn 配置解析成 session request，`runtime.ts` 据此构建会话：为工作目录创建 `SettingsManager`，创建从 Cortex 私有 PI agent 目录读取 `auth.json` 与 `models.json` 的 `ModelRuntime`，再依次调用 `createAgentSessionServices` 与 `createAgentSessionFromServices`。会话按 session key 池化并跨回合复用。当 spawn identity 改变时池中会话会被退休——模型、工具面或 MCP 集合的变化无法应用到一个活着的会话上——空闲超时或显式关闭时同样退休。`pi-session.ts` 负责回合循环、通过 SDK steer 路径的回合中插话、compaction，以及把活会话重新指向另一份 transcript。恢复既可以给出 session id，也可以给出 transcript 路径；`session-files.ts` 负责由 id 找到对应文件。Transcript 写在 `$CORTEX_HOME/logs/sessions-pi/` 下。

**Cortex 的粘合层。** Cortex 附加的一切都是按会话在 `extensions.ts` 中装配的 inline PI extension：

- **MCP 桥接**（`mcp-bridge.ts`）——把按 composition 限定的 Cortex 工具 bundle 以进程内方式经一对内存 MCP transport 提供出来，并绑定到专为该会话构建的 tool context。被指派的 plugin MCP server 与 browser MCP 仍各自保有独立的 stdio 子进程或远程连接。
- **工具垫片**（`tool-shims.ts`）——注册 PI 本地的 `agent`、`agent_stop`、`TodoWrite`、`WebFetch` 与 `WebSearch` 工具，每个都受会话的工具允许列表约束。
- **钩子桥接**（`hook-bridge.ts`）——把注册表中挂在 `pi` 后端的条目挂成 PI 原生事件处理器，Cortex 钩子脚本因此能看到 PI 的工具事件。参见 [hooks.md](./hooks.md)。
- **额度探针**（`quota-probe.ts`）——在经网关路由的运行中从响应头读取 provider 额度，并把每次读数交给限流器。

系统提示覆盖、追加提示与 Cortex 插件 skill 目录都是 session options（`systemPrompt`、`appendSystemPrompt`、`additionalSkillPaths`），而不是命令行标志。

**交互工具。** 用户发起的直接 PI 会话会把 interaction bundle 加入其进程内的 Cortex 工具集，因此 PI 暴露与 Claude TUI、Claude print 相同的 `cortex_ask_user`、`cortex_plan_enter` 与 `cortex_plan_exit` 工具。它们的对话走 PI 的 extension UI 协议，由 `ui-context.ts` 在服务器内应答；参见 [safety-and-approvals.md](./safety-and-approvals.md)。

**凭据。** PI 的 provider 凭据由 Cortex 管理——聊天里的 `!login pi`，或网页端的**设置 → 账号**——并保存在 PI 自己的认证文件 `~/.pi/agent/auth.json` 中。Cortex 会让该文件在其私有 PI agent 目录内可见（Linux 与 macOS 用符号链接，Windows 用复制）供 SDK 读取，并从 `~/.pi/agent/models.json` 读取用户自定义的 provider。因此同时装有终端 `pi` CLI 的机器与 Cortex 共用同一份凭据和同一份 provider catalog。

PI transcript retention 走文件系统扫描：仍在使用的 PI backend session id 会在保留扫描中被保护，而 `$CORTEX_HOME/logs/sessions-pi/` 下失去引用的 transcript bundle 只有在超过保留截止线且连续两轮确认后才会删除。

PI provider 名称与 Cortex backend 名称相互独立。`openai-codex` 仍是受支持的 PI provider（包括 `openai-codex-responses` API kind）；使用它的 profile 仍须设置 `"backend": "pi"`。

## 子智能体 {#subagents}

两个后端共用同一个工具、同一张角色表和同一个 runner，且父子两端都可以是任意后端：Claude 的回合可以把活交给 PI 模型，PI 的回合也可以交给 Claude。

**工具。** PI 在进程内注册 `agent` 与 `agent_stop`。Claude 拿到的是同一对 MCP 工具（`mcp__cortex-core__agent`、`mcp__cortex-core__agent_stop`），同时它内置的 `Agent` 工具会在每次 spawn 时被剥离，因此不存在第二条守护进程看不见的委派路径。一次调用可以跑单个任务、最多八个并行任务，或最多八个串行任务；串行任务提示里的 `{previous}` 会被替换成上一环的输出。

**角色。** 角色是 `$CORTEX_HOME/config/agents/` 下带 YAML frontmatter 的 markdown 文件。`explore`、`general-purpose` 与 `plan` 是随附的默认角色，且只在缺失时才复制进去，所以用户改过的角色在升级后一定保留。角色正文追加到子会话的系统提示。其 frontmatter 可以设置：

| 键 | 含义 |
|---|---|
| `tools` | 规范工具名，翻译成各后端自己的拼写 |
| `model` | PI 子智能体用 `provider/model[:thinking]`，Claude 子智能体用裸模型 id |
| `backend` | `claude` 或 `pi`；不填表示"跟随父会话" |
| `mode` | 子智能体的显式 gateway 路由；不填时回退到 provider 名 |

统一之前就在用 PI 子智能体的安装，其旧的 `pi/agents/` 目录会在首次启动时被并入共享角色表，旧目录随后被改名为 `pi/agents.migrated`——这样在那里做的修改不会悄无声息地毫无效果。

**模型如何选定。** 不查 profile。顺序是：任务显式指定的 `model`，其次角色的 `model`，最后才是父会话自己的模型——且仅当子智能体与父会话同后端时才回退到最后一项，因为 Claude 的模型 id 对 PI 毫无意义，PI 的 `provider/model` 对 Claude 亦然。

**调用方能看到什么。** `subagent_type`、`model` 与 `backend` 三个字段的描述不再写死，而是在注册工具时按本机实际拥有的内容生成。角色取自实时的 `$CORTEX_HOME/config/agents/` 角色表，新增的角色下一个会话就会出现。Claude 模型 id 来自 Cortex 生成 gateway 的 Anthropic 路由所用的同一张表，再加上守护进程当前的模型。PI 父会话直接读自己进程内的模型注册表；Claude 父会话读不到——它的 MCP 工具运行在没有 PI SDK 的 sidecar 进程里，所以由守护进程把自己缓存扫描到的 provider/model 对经 spawn 环境传下去。缓存为空只意味着暂时列不出 PI 模型——不会为了给一次 Claude spawn 装饰而触发扫描。角色和模型各自有字符预算，超出部分渲染为 `(+N more)`。这些列表是快照，会话中途不会变化；它们只是提示而非白名单：未列出的模型 id 仍会被接受并透传。一无所知时，描述回退到通用措辞，工具不会因为缺少 catalog 而失败。

**隔离。** `pi` 子智能体是一个不写 transcript、headless 运行的嵌套进程内会话。`claude` 子智能体则是一次冻结的一次性 `claude` 运行：没有可恢复的会话、没有钩子、没有环境规则、不写 transcript 日志。两种情况下子智能体的 MCP 面都是去掉委派工具后的 `cortex-core` bundle，因此既不能继续向下扇出，也够不到线程控制。

**父会话看到什么。** 子智能体的工具调用、结果与文本会实时流入父会话的 transcript 并标注归属，token 用量并入父会话。归属是 best-effort：父回合已经结束的运行只是不再推送事件，答案照样返回。

**后台运行。** `run_in_background: true` 会立刻返回一个 `agent_id`。Cortex 在运行期间为该会话保持占用——停止按钮够得到它，延迟的守护进程重启也会等它——并在结果就绪时作为一个普通回合投递回来；如果此时已有回合在跑，就并入那个回合。`agent_stop` 用于提前取消并丢弃已产出的内容。停止一个会话同样会停掉它委派出去的运行——前台和后台一视同仁：子代理不会比发起它的那个回合活得更久。

## 远程登录 {#remote-login}

无需 SSH 登录 Cortex 主机，也可以远程完成 backend 登录。同一登录流程有三个渠道入口：

| 渠道 | 入口 | 交互方式 |
|---|---|---|
| Slack | 发送 `!login`、`!login cc` 或 `!login pi [provider]` | 选择器和 secret 输入使用 Slack modal；授权链接发送到频道。 |
| 飞书 | 发送 `!login`、`!login cc` 或 `!login pi [provider]` | 选择器和 secret 输入使用内联卡片表单；授权链接发送到聊天。 |
| Web（桌面与移动端） | 桌面端打开 **设置 → 账号**；移动端点击 **设置 → 账号**，进入 `/m/settings/accounts`。 | 账号分区展示 Claude Code 凭据与全部 PI provider，并提供状态及登录/登出操作；登录仍打开同一套选择器式流程。 |

聊天命令形式如下：

```text
!login
!login status
!login cc
!login pi
!login pi <provider>
!login custom
```

`!login custom` 管理没有登录流程的自建端点，见下文[自定义 provider](#custom-providers)。

无参数的 `!login` 与 `!login status` 都显示认证状态总览。`!login cc` 选择
Claude Code。`!login pi` 先打开 PI provider 选择器；附带 provider 时跳过该步。
Provider 支持多种认证类型时，认证类型同样在交互中选择。不要在命令后追加 `oauth`、
API key、授权码或 provider 专用 OAuth 参数。

只有当已安装 PI provider 的 `provider.auth.oauth.login` 是函数时，界面才提供 OAuth。
参考安装环境的本机实测结果是 39 个 provider 中 7 个满足该判据；清单由运行时动态发现，
因此只支持 API key 的 provider 不会显示无法使用的 OAuth 选项。Claude Code 的 API key
与订阅登录也通过选择器提供。

Claude Code 订阅登录由 Cortex 启动 `claude auth login --claudeai`：命令输出的授权 URL
发送到发起渠道，用户通过渠道表单提交返回的 code，Cortex 再把 code 写入该命令的标准输入。
OAuth 交换和凭据持久化完全由 Claude Code 负责。只有在清空认证相关环境变量后执行
`claude auth status --json` 并得到 `loggedIn: true`，Cortex 才会把流程标记为成功；
Cortex 不读取也不保存最终 token。订阅登出同样交给 `claude auth logout`，并验证登出状态。
旧版 Cortex-managed subscription token 仅在 Claude Code 尚未登录时作为可删除的 runtime
credential 保持兼容；它不会让账号显示为已登录，并会在 CC 拥有凭据后被抑制。

运行中的 backend 报告认证过期时，Cortex 会发送点名 backend/provider 的通知卡，卡片上的
一键重登按钮会预填已有选择。每日过期扫描只检查使用中的账号，并对即将过期、已过期或缺失
的凭据发送同一种可操作提醒。若某个 provider 在提醒窗口内已被运行时通知提醒过，每日扫描会跳过它，
因此定时预警不会重复你刚收到的通知。反方向是有意不去重的：即使当天扫描已预警过，运行时失败仍会通知——
你正撞上失败的那一刻，最需要的就是那条提示。

在主机上做只读状态检查可运行：

```bash
cortex auth status
cortex auth status --json
```

文本形式提供简洁总览；`--json` 返回完整的归一化状态快照。两者都不包含凭据。精确命令契约
参见 [CLI 参考](./cli-reference.md#cortex)。

## 自定义 provider {#custom-providers}

自定义 provider 指 PI 没有内置定义的端点：本地推理服务、实验室的 GPU 机器，或公司内的代理。
它没有登录流程——没有厂商可供认证——所以它是"定义出来"的而不是"登录进去"的，管理入口与其他
功能一致，共三处：

| 入口 | 用法 |
|---|---|
| CLI | `cortex auth provider list \| add \| remove` |
| Web（桌面与移动） | **设置 → 账号 → 自定义 Provider** |
| Slack / 飞书 | `!login custom [list \| add <名称> <协议> <地址> <模型…> \| remove <名称>]` |

一条定义需要四样东西：名称、端点使用的请求协议（`anthropic-messages`、`openai-completions`、
`openai-responses` 或 `google-generative-ai`）、上游地址，以及至少一个模型 id。上游密钥是可选
的；不填时网关会直接透传调用方自己的 key。

保存会写两份文件。`~/.pi/agent/models.json` 里新增 `providers.<名称>`，其 `baseUrl` 指向网关，
因此终端的 `pi` 和 Cortex 共用同一份定义；`~/.aistatus/gateway.yaml` 里新增指向真实端点的路由，
上游密钥保存在这里。**密钥只存在于网关配置中**——PI 目录里放的是占位符，所以把那份 catalog
复制到别处也不会把密钥带走。于是每次调用都经过网关，与其他路由一样计入用量与限流。生成的网关
配置会写入顶层 `max_body_size_mb: 100`；aistatus 0.0.8 及以上版本按该值限制每个缓冲请求体的
MiB 大小，可直接修改。网关会自己热重载配置，路由和请求体限额变更都无需重启。

聊天命令刻意不接受密钥参数：聊天记录不是放密钥的地方。要配密钥，请用 CLI 的 `--key -`
（从标准输入读取）或 Web 表单，两者都不会把它留在任何聊天记录里。

要用上自定义 provider，再建一条指向它的 profile，例如
`{"backend": "pi", "provider": "my-vllm", "mode": "my-vllm", "model": "Model-27B"}`
（profile 结构参见 [configuration.md](./configuration.md)）。删除 provider 会同时移除 catalog
条目与网关路由，仍指向它的 profile 将无法解析，请先改掉那些 profile。

## 选择后端 {#selecting-a-backend}

后端在 `$CORTEX_HOME/config/profiles.json` 中按配置选择（完整配置模式参见 [configuration.md](./configuration.md)）：

```json
{
  "defaultProfile": "plan",
  "profiles": {
    "plan": {
      "model": "claude-sonnet-4-20250514",
      "backend": "claude"
    },
    "execute": {
      "model": "claude-sonnet-4-20250514",
      "backend": "pi"
    }
  }
}
```

`backend` 字段只接受 `"claude"` 或 `"pi"`。如果省略，默认为 `"claude"`。

线程模板也可以为每个智能体指定配置，允许同一管道中的不同智能体使用不同的后端。模板配置参见 [threads.md](./threads.md)。

## 思考档位 {#thinking-level}

可选的 `thinking` 配置字段设置后端的推理深度，取值使用后端各自的值域。Claude Code 接受 `low`/`medium`/`high`/`xhigh`/`max`，以 `--effort` 标志传入；PI 接受 `off`/`minimal`/`low`/`medium`/`high`/`xhigh`，作为会话的 thinking level 传入。字段缺省时后端使用自身默认值。fallback 条目不继承主配置的值——每条自行声明。

## 回退行为 {#fallback-behavior}

每个配置项可以指定一个 `fallback` 数组作为备选配置。如果主后端调用因瞬态错误失败（网络超时、速率限制、认证），Cortex 按顺序遍历回退链。每个回退项继承主配置中未指定的字段。

示例：

```json
{
  "plan": {
    "model": "claude-sonnet-4-20250514",
    "backend": "claude",
    "fallback": [
      { "model": "claude-sonnet-4-20250514", "backend": "pi" }
    ]
  }
}
```

## 用量限流与自动恢复 {#usage-limit-throttling-and-auto-resume}

回退链处理单次调用失败，滚动用量窗口由独立的限流机制处理。Provider 标识是任意字符串，不受固定枚举限制，因此 Cortex 可以同时维护任意数量的 provider、窗口类型和重置时间。限流门禁同时匹配 provider 与 route mode；两个 provider 即使使用相同 mode 名称，也不会互相阻塞。

这套策略通过 [`config/settings.json`](./configuration.md#configsettingsjson) 里的 `providerRateLimits` 配置。它按 provider id 建立对象，每个 provider 可用 `windows` 数组保存 `{ type, label?, enabled, threshold? }`，因此 5 小时、weekly、含超额 weekly、Codex 主/次窗口及带名称的模型窗口都能独立配置。`threshold` 是大于 `0` 且不超过 `1` 的比率；省略时，已知 weekly 窗口使用 `0.95`，其他窗口使用 `0.90`。精确窗口策略优先于可见且可清除的旧版 provider 回退。桌面端和移动端 Usage 都编辑这些行；只显示花费的 provider 不显示额度控件。

被中断的直接会话和线程会连同其 provider 一起持久化。某个 provider 完全恢复后，Cortex 只恢复属于该 provider 的工作，其他仍处于限流状态的 provider 继续等待。直接会话在原频道恢复并保留上下文；线程若被中断的 step 已经产生过实际工作，则复用该 step 的后端会话并发送一段简短的续跑提醒，保留已完成的部分进度；未产生任何活动的 step 仍从原始 prompt 重新执行。多项恢复会错开启动，避免刚开放的窗口立即再次耗尽。

限流详情会显示每个 provider 正在等待的直接会话数和线程数，并保留同时激活的模型窗口名称。Provider key 是当前隔离边界：多个账户或额度池若使用同一个 provider key，就共享同一条 provider 记录；类型与名称都相同的窗口保留较晚的重置时间。定时限流要求观测中带有重置时间。Claude 的 live 账户用量拉取会把所有窗口提交给每个已配置的 Anthropic mode，而 stale PI 缓存不会被重放；PI 的响应头额度仍通过原有 push 链路进入。

策略改动只作用于未来收到的额度观测，不会回写已经处于激活状态的窗口。已经激活的额度窗口或 outage 重试窗口会保持生效，直到窗口自然重置，或被手动 **Resume now** 清除。Outage 重试行为使用自己独立的 outage 窗口，不受额度阈值策略改动影响。

限流窗口与带 provider 归属的恢复队列持久化在 `data/provider-state.json` 中。启动时 Cortex 会重新装载仍有效的计时器，并立即恢复在停机期间已经解除限流的 provider 工作，即使另一个 provider 仍在限流。旧数据中没有 provider 的条目会等待所有 provider 都解除。已有活跃直接会话的频道或此后已结束的线程会被跳过；等待时长本身不会导致条目被丢弃。

自动恢复默认开启。在 [`config/settings.json`](./configuration.md#configsettingsjson) 中设置 `"autoResume": false` 后，已经满足恢复条件的队列条目会被移除，但不会自动派发；改动无需重启守护进程即刻生效。`.env` 中的旧变量 `CORTEX_AUTO_RESUME=0` 仍作为已弃用的回退被读取。

### 为什么限额信号是注入而不是事件

适配器通过注入的回调（`RateLimitReporter`）把 provider 的限额窗口上报给宿主，而不是发一条 `RunEvent`。后端会在回合之间以及自发续跑回合期间发出 `rate_limit_event`，也就是恰好没有回合在飞的时候——如果把它塞进"按回合"的事件流，最需要这条观测的时刻反而会丢失。因此 `RunEvent` 里的 `rate_limit` 只作为转录层通知存在（`agent-runner` 忽略它），节流状态由注入的 reporter 喂给；配额观测走同一条路。

## 费用报告 {#cost-reporting}

费用报告因后端而异：

- **Claude Code** — 从 `message.usage` 令牌计数（输入/输出）逆向推导 USD 费用，使用 Anthropic 发布的每模型定价。费用写入 `$CORTEX_HOME/data/costs.jsonl`。
- **PI** — 读取会话在每条 assistant 消息上报告的用量（`input`、`output`、`cacheRead`、`cacheWrite` 与 `cost.total`），按回合汇总为一条记录，并标注实际服务的 provider 与模型。provider 未报告的 token 字段记为未知，而不是记为 0。记录同样写入 `$CORTEX_HOME/data/costs.jsonl`。

所有费用记录遵循相同的 JSONL 格式，并受 90 天滚动保留窗口的约束。通过 MCP 工具的费用查询汇总所有后端——`cost_query` 工具参见 [mcp.md](./mcp.md)。

## 添加新后端 {#adding-a-new-backend}

新后端在 `agent-server/src/agent-adapter/` 下的新目录中实现 `EngineAdapter` 接口。所需接口：

1. **`adapter.ts`** — 实现 `EngineAdapter` 的 `open(spec)`，返回 `EngineSession`。适配器无状态：池由 `SessionEngines` 持有。
2. **`EngineSession`** — 提供用于一个回合的 `run(prompt, opts)`，返回 `EngineRun`；其 `events` 是 `RunEvent` 的异步可迭代，其 `result` 是前台 `AgentResult`；另有 `steer()`、`respondToDialog()`、`compact()`、`close()` 和 `kill()`。
3. **`event-parser.ts`** — 将后端的原生事件格式转换为 `NormalizedEvent` / `RunEvent` 成员。
4. **注册** — 将适配器加入 `domain/runs/adapters.ts` 的装配，并在 `domain/runs/engines.ts` 的 `SessionEngines.acquire` 中加一个分支；将能力加入 `capabilities.ts`；将后端标签加入 `core/types/agent-types.ts` 的 `Backend` 类型联合。

标准化层（`agent-adapter/normalize/`）提供所有后端使用的事件流排队、工具名称转换和钩子规范的共享工具。
