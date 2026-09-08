# 后端 {#backends}


后端是 Cortex 对特定编程智能体的适配器。Cortex 不直接调用 LLM API，而是驱动一个编程智能体——Claude Code 以子进程运行，PI 以服务器进程内的会话运行——向其发送消息，并消费标准化的事件流。每个后端实现 `agent-server/src/agent-adapter/types.ts` 中定义的 `AgentAdapter` 接口。

## 支持的后端 {#supported-backends}

| 后端 | 状态 | 引擎 | 前置要求 | 功能级别 |
|---|---|---|---|---|
| Claude Code | 已支持 | `@anthropic-ai/claude-code` | `PATH` 上有 `claude` 可执行文件 | 完整（10/10 能力） |
| PI | 已支持 | `@earendil-works/pi-coding-agent`，随服务器包一起打包 | 除已登录的 provider 外无需任何额外安装 | 完整（10/10 能力） |

## 后端如何工作 {#how-backends-work}

当智能体会话开始时，Cortex 解析活动配置（从 `profiles.json` 或 `--profile` 标志）以确定使用哪个后端。然后它调用 `getAdapter(backend)` 获取适配器实例，并调用 `adapter.spawn(config)` 启动会话。

`AgentSpawnConfig` 携带完整的会话上下文：系统提示、插件目录、工具允许列表、MCP 服务器配置、钩子、模型名称和后端特定的透传参数。适配器把它翻译成后端原生形式：对 Claude Code 是子进程的命令行参数，对 PI 是进程内会话的 session options。

从那里，Cortex 发送用户消息并接收标准化的事件流。标准化层（`agent-adapter/normalize/`）将每个后端的原生事件格式转换为公共的 `NormalizedEvent` 可区分联合类型，因此编排层永远不需要知道运行的是哪个后端。

## 功能矩阵 {#feature-matrix}

Cortex 定义了后端可能支持的十种能力。编排层在尝试后端特定操作之前检查这些能力。

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

## Claude Code

参考后端。支持所有十种能力。有两种适配器模式可用：

**Print 模式**（`claudeBackend: "print"`，默认）。使用持久化的 `claude -p` 进程以及 stream-json 输入输出。Cortex 按 session key 池化该进程，并通过同一 NDJSON stream 发送后续回合，直到 session 被关闭、超时或 spawn identity 改变。

**TUI 模式**（`claudeBackend: "tui"`）。在 tmux 下生成交互式 Claude 会话，并尾随会话的 JSONL 文件获取事件。支持带会话持久化的多轮对话。资源使用更重，但允许交互式工作流。

Claude Code 适配器会话池按键频道以重用会话。费用报告从 `message.usage` 令牌计数逆向推导 USD 费用，使用 Anthropic 发布的定价。

session-retention 协调器还会把 Claude 用户级 `cleanupPeriodDays` 同步到 `$CLAUDE_CONFIG_DIR/settings.json`（或 `~/.claude/settings.json`）里，值来源于 Cortex 运行时设置中的 `sessionRetentionDays`。这次写入只会 merge 进用户设置文件：保留所有其它 Claude 键，不会碰 spawn cwd 下的项目级 `.claude/settings.local.json` 或 `.claude/settings.json`，也不会借此接管 hook/permission 配置的归属。若用户文件里已是相同的 `cleanupPeriodDays`，则不会重写文件。

## PI

PI 在 Cortex 服务器进程内运行。引擎（`@earendil-works/pi-coding-agent`）随发布的服务器包一起打包，因此既不需要安装 `pi` 可执行文件，也没有 PI 进程需要看管。`agent-server/src/core/pi-sdk.ts` 每个守护进程只导入一次 SDK——因为入口会拉起全部 provider 客户端，所以推迟到第一次 PI 会话或 provider 扫描时才导入——之后所有 PI 会话都由这一个句柄创建。

**会话。** 每个 Cortex 会话跑在一个 PI SDK `AgentSession` 上。`session-options.ts` 把 spawn 配置解析成 session request，`runtime.ts` 据此构建会话：为工作目录创建 `SettingsManager`，创建从 Cortex 私有 PI agent 目录读取 `auth.json` 与 `models.json` 的 `ModelRuntime`，再依次调用 `createAgentSessionServices` 与 `createAgentSessionFromServices`。会话按 session key 池化并跨回合复用。当 spawn identity 改变时池中会话会被退休——模型、工具面或 MCP 集合的变化无法应用到一个活着的会话上——空闲超时或显式关闭时同样退休。`pi-session.ts` 负责回合循环、通过 SDK steer 路径的回合中插话、compaction，以及把活会话重新指向另一份 transcript。恢复既可以给出 session id，也可以给出 transcript 路径；`session-files.ts` 负责由 id 找到对应文件。Transcript 写在 `$CORTEX_HOME/logs/sessions-pi/` 下。

**Cortex 的粘合层。** Cortex 附加的一切都是按会话在 `extensions.ts` 中装配的 inline PI extension：

- **MCP 桥接**（`mcp-bridge.ts`）——把按 composition 限定的 Cortex 工具 bundle 以进程内方式经一对内存 MCP transport 提供出来，并绑定到专为该会话构建的 tool context。被指派的 plugin MCP server 与 browser MCP 仍各自保有独立的 stdio 子进程或远程连接。
- **工具垫片**（`tool-shims.ts`）——注册 PI 本地的 `Agent`、`TodoWrite`、`WebFetch` 与 `WebSearch` 工具，每个都受会话的工具允许列表约束。
- **钩子桥接**（`hook-bridge.ts`）——把注册表中挂在 `pi` 后端的条目挂成 PI 原生事件处理器，Cortex 钩子脚本因此能看到 PI 的工具事件。参见 [hooks.md](./hooks.md)。
- **额度探针**（`quota-probe.ts`）——在经网关路由的运行中从响应头读取 provider 额度，并把每次读数交给限流器。

系统提示覆盖、追加提示与 Cortex 插件 skill 目录都是 session options（`systemPrompt`、`appendSystemPrompt`、`additionalSkillPaths`），而不是命令行标志。

**交互工具。** 用户发起的直接 PI 会话会把 interaction bundle 加入其进程内的 Cortex 工具集，因此 PI 暴露与 Claude TUI、Claude print 相同的 `cortex_ask_user`、`cortex_plan_enter` 与 `cortex_plan_exit` 工具。它们的对话走 PI 的 extension UI 协议，由 `ui-context.ts` 在服务器内应答；参见 [safety-and-approvals.md](./safety-and-approvals.md)。

**子智能体。** PI 的 `Agent` 工具把每个子智能体跑在自己的嵌套进程内会话上（`child-session.ts`）：一个不写 transcript 的内存会话，以 headless 方式运行，且只加载 Cortex 自己的 extension。角色是私有 PI agent 目录下 `agents/` 中带 YAML frontmatter 的 markdown 文件；`explore`、`general-purpose` 与 `plan` 是随附的默认角色。角色正文追加到子会话的系统提示，其 frontmatter 中的 `tools` 成为子会话的工具允许列表。模型的选择顺序是：任务显式指定的 `model`，其次角色的 `model`，最后父会话的模型。子智能体自身永远拿不到 `Agent` 工具，其 MCP 面只有 `cortex-core` bundle，因此既不能继续向下扇出，也够不到线程控制。它的工具调用、结果与文本会转发进父会话的 transcript 并标注归属，token 用量并入父会话。一次 `Agent` 调用可以跑单个任务、最多八个并行任务，或最多八个串行任务。

**凭据。** PI 的 provider 凭据由 Cortex 管理——聊天里的 `!login pi`，或网页端的**设置 → 账号**——并保存在 PI 自己的认证文件 `~/.pi/agent/auth.json` 中。Cortex 会让该文件在其私有 PI agent 目录内可见（Linux 与 macOS 用符号链接，Windows 用复制）供 SDK 读取，并从 `~/.pi/agent/models.json` 读取用户自定义的 provider。因此同时装有终端 `pi` CLI 的机器与 Cortex 共用同一份凭据和同一份 provider catalog。

PI transcript retention 走文件系统扫描：仍在使用的 PI backend session id 会在保留扫描中被保护，而 `$CORTEX_HOME/logs/sessions-pi/` 下失去引用的 transcript bundle 只有在超过保留截止线且连续两轮确认后才会删除。

PI provider 名称与 Cortex backend 名称相互独立。`openai-codex` 仍是受支持的 PI provider（包括 `openai-codex-responses` API kind）；使用它的 profile 仍须设置 `"backend": "pi"`。

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

## 费用报告 {#cost-reporting}

费用报告因后端而异：

- **Claude Code** — 从 `message.usage` 令牌计数（输入/输出）逆向推导 USD 费用，使用 Anthropic 发布的每模型定价。费用写入 `$CORTEX_HOME/data/costs.jsonl`。
- **PI** — 读取会话在每条 assistant 消息上报告的用量（`input`、`output`、`cacheRead`、`cacheWrite` 与 `cost.total`），按回合汇总为一条记录，并标注实际服务的 provider 与模型。provider 未报告的 token 字段记为未知，而不是记为 0。记录同样写入 `$CORTEX_HOME/data/costs.jsonl`。

所有费用记录遵循相同的 JSONL 格式，并受 90 天滚动保留窗口的约束。通过 MCP 工具的费用查询汇总所有后端——`cost_query` 工具参见 [mcp.md](./mcp.md)。

## 添加新后端 {#adding-a-new-backend}

新后端在 `agent-server/src/agent-adapter/` 下的新目录中实现 `AgentAdapter` 接口。所需接口：

1. **`adapter.ts`** — 实现 `AgentAdapter`，包括 `spawn()`、`close()`、`kill()` 和 `listSessions()`。从 `spawn()` 返回 `AgentProcess`。
2. **`AgentProcess`** — 暴露用于用户消息的 `send(message)` 和作为 `NormalizedEvent` 异步可迭代的 `events`。还必须支持 `close()` 和 `kill()`。
3. **`event-parser.ts`** — 将后端的原生事件格式转换为 `NormalizedEvent` 可区分联合成员。
4. **注册** — 将适配器添加到 `agent-adapter/index.ts` 中的 `ADAPTERS` 映射，将能力添加到 `capabilities.ts`，并将后端标签包含在 `types.ts` 的 `Backend` 类型联合中。

标准化层（`agent-adapter/normalize/`）提供所有后端使用的事件流排队、工具名称转换和钩子规范的共享工具。
