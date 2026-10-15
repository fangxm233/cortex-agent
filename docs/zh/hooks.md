# 钩子 {#hooks}

钩子是 Cortex 在某件事发生时运行的一条命令——工具即将执行、会话开始、定时任务触发、助手回合结束。每个钩子都是一份**声明**：一个 JSON 文件，写明一个事件、一个可选的 matcher，以及要运行的命令。内置声明随 Cortex 发布，直接从安装目录读取；你自己的声明放在 `$CORTEX_HOME/config/hooks/`。服务器在启动时加载这些声明，各个消费方分别编译自己关心的子集：Claude Code 后端、PI 后端，以及服务器自身的事件派发器。添加一个钩子意味着添加一个文件，而不是改代码。关于钩子在整体系统中的位置，参见 [architecture.md](./architecture.md)。

## 架构概览 {#architecture-overview}

```
  defaults/config/hooks/*.json + $CORTEX_HOME/config/hooks/*.json
              — one declaration per file, built-in and yours
                            │
                            │  load + validate (store/hook-registry.ts)
        ┌───────────────────┼────────────────────────┐
        ▼                   ▼                        ▼
 Claude compiler       PI hook bridge            HookBus
 hooks-builder.ts      pi/hook-bridge.ts         core/hook-bus.ts
 agent:* + cc:*        agent:* + pi:*            cortex:*
        │                   │                        │
        ▼                   ▼                        ▼
 --settings JSON at    pi.on(<native event>)    server-side dispatch
 Claude spawn time     at extension load
        └───────────────────┴────────────────────────┘
                            │
                            ▼
     $CORTEX_HOME/hooks/*.mjs, then defaults/hooks/*.mjs — the scripts
```

## 钩子注册表 {#the-hook-registry}

注册表分两层。内置声明是安装目录 `agent-server/defaults/config/hooks/` 中的 `.json` 文件，直接原地读取，因此始终与正在运行的版本一致；你的声明是 `$CORTEX_HOME/config/hooks/` 中的 `.json` 文件。每个文件是一条声明。两层的文件合在一起按文件名排序读取，这个顺序同时也是同一事件下钩子的执行顺序——内置声明带有数字前缀（`05-…`、`06-…`），使相对顺序一目了然。

`$CORTEX_HOME/config/hooks/` 中与某条内置声明同名的文件不会新增钩子，而是覆盖那条内置声明。它按顶层字段逐个合并到内置声明之上，因此只需写出要改的字段——`{ "enabled": false }` 即可关闭一个内置钩子——且保留内置的 `id`。覆盖文件设置的字段会整体替换内置字段：覆盖 `run` 时必须写出完整的 `run` 对象，包括 `script`。删除该文件即恢复内置声明。Sealed home（`CORTEX_CONFIG_IMMUTABLE=1`，例如 benchmark trial）只挂载自己的声明。

加载是容错的，但出错时会明确报出。JSON 非法、schema 校验失败，或 `id` 与更早的文件重复的文件会被跳过，并在 stderr 打印 `[hook-registry] skipped <file>: <reason>`；注册表的其余部分照常挂载。无法解析的覆盖文件也以同样方式报告，它本想修改的那条内置声明则原样挂载。服务器启动时会记录挂载了多少个已启用的钩子，形如 `Startup: mounted 7 hooks (0 cc / 1 cortex)`。Web UI 的设置面板读取的是同一份列表。

桌面端的 **Settings → Hooks** 面板不只是一份清单，而是这份注册表的完整视图：它按事件命名空间分组、按加载顺序排列声明，显示每条声明实际挂载到哪里（`claude` / `pi` / `server`）、改动是在下次启动智能体时生效还是必须重启服务器后才生效，并标记出两个脚本目录中都找不到的 `run.script`。能在面板里改什么取决于条目来源。**user** 条目完全可编辑，也可以新建和删除。**built-in** 条目只开放启用开关；拨动开关会在 `$CORTEX_HOME/config/hooks/` 写入最小的覆盖文件，拨回原值时再删除该覆盖文件。`result` 的可选项限定为该事件实际支持的模式，从 UI 创建的条目始终是 user 条目。每个条目还可以针对一份可编辑的样例 payload 试跑，退出码、stdout 与 stderr 就地展示；从面板发起的试跑无论声明的超时是多少，都会在 15 秒后停止。筛选标签和搜索框可以缩小列表范围。

移动端对同一份注册表只读：钩子页面展示分组后的清单以及每行背后的完整声明，但不支持编辑、新建与试跑。要修改钩子，请在桌面端会话中操作。

### 条目 schema {#entry-schema}

```json
{
  "id": "status-md-guard",
  "event": "agent:pre-tool",
  "matcher": "Edit|Write",
  "run": { "script": "status-md-guard.mjs", "timeout": 10 },
  "enabled": true
}
```

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | string，必填 | 在整个注册表中唯一。`cortex-hook` 和日志行用它指代钩子 |
| `event` | string，必填 | `agent:*` 事件之一，或任意以 `cc:` / `pi:` / `cortex:` 为前缀的名称 |
| `matcher` | string 或 object | `agent:*` / `cc:*` / `pi:*` 事件用正则；`cortex:*` 事件用等值过滤对象。省略则匹配全部 |
| `run.script` | string | 脚本文件名，先在 `$CORTEX_HOME/hooks/` 中查找，再在内置脚本中查找。绝对路径与 `..` 片段会被拒绝 |
| `run.command` | string | 用裸 shell 命令代替脚本。`script` 与 `command` 必须且只能出现一个 |
| `run.timeout` | number | 超时，单位为**秒**，须为正数。在 PI 和服务器上默认 30；在 Claude 上不设超时则沿用 Claude Code 自身的默认值 |
| `scope.backends` | array | 收窄 `agent:*` 钩子编译到 `claude` / `pi` 中的哪些后端 |
| `scope.requiresTool` | string | 在 Claude 上，仅当智能体的工具列表包含该工具时才挂载此钩子 |
| `blocking` | object | `{ "mode": "webhook", "ttlMin": <positive number> }`。用于描述需要经 webhook 往返阻塞的钩子的元数据：加载器会校验它、设置面板会展示它，但运行时没有任何机制强制执行它 |
| `result` | string | `cortex:*` 钩子的 stdout 如何使用：`stdout-as-prompt`（只在 `cortex:session.new` 和 `cortex:session.messageEnd` 上接受）或 `none`。加载器会拒绝事件不支持的模式 |
| `version` | string | 可选的声明 CalVer 版本号，在设置面板中只读展示 |
| `enabled` | boolean | 为 `false` 时从所有消费方移除该钩子，但不删除文件。默认 `true` |

加载器还会拒绝以下几种情况：无法编译的 `matcher` 正则表达式；值不是纯字符串、数字或布尔值的对象 matcher；既不是七个 `agent:*` 名称之一、也不是 `cc:`、`pi:` 或 `cortex:` 前缀加名称的 `event`。

### 内置条目与 user 条目 {#built-in-and-user-entries}

在安装目录中声明的条目是 **built-in** 条目，无论 `$CORTEX_HOME/config/hooks/` 中是否有文件覆盖了它的部分字段；`cortex-hook` 与设置面板都会把它报告为内置条目。只在 `$CORTEX_HOME/config/hooks/` 中声明的条目是 **user** 条目。Cortex 从不写入安装目录，只有在你编辑、新增、删除或开关某个钩子时才会写入 `$CORTEX_HOME/config/hooks/`。

## 事件命名空间 {#event-namespaces}

### `agent:*` — 后端中立的智能体事件 {#agent-backend-neutral-agent-events}

这些是两个编程智能体后端语义真正一致的事件。一条声明同时编译到 Claude Code 与 PI，且两边交给脚本的 payload 都是 Claude 的形状，因此同一个脚本可以同时服务两个后端。

| `agent:*` 事件 | Claude 事件 | PI 事件 |
|---|---|---|
| `agent:pre-tool` | `PreToolUse` | `tool_call` |
| `agent:post-tool` | `PostToolUse` | `tool_result` |
| `agent:session-start` | `SessionStart` | `before_agent_start` |
| `agent:session-end` | — | `session_shutdown` |
| `agent:pre-compact` | — | `session_before_compact` |
| `agent:user-prompt` | — | `input` |
| `agent:turn-end` | — | `turn_end` |

Claude 编译器只为前三个事件生成设置；后四个只到达 PI。要挂到对应的 Claude 挂载点，请用原生形式声明为 `cc:SessionEnd`、`cc:PreCompact`、`cc:UserPromptSubmit` 或 `cc:Stop`。

### `cc:*` — Claude Code 透传 {#cc-claude-code-passthrough}

`cc:` 之后的部分原样用作 Claude 设置中的事件名，因此无需改代码就能触达 Claude Code 的任意挂载点——`cc:PermissionRequest`、`cc:SessionEnd`、`cc:PreCompact`、`cc:UserPromptSubmit`、`cc:Stop`。这类声明只挂载在 Claude 后端。注意 Cortex 以 `--permission-mode bypassPermissions` 启动 Claude，因此按当前配置，`cc:PermissionRequest` 永远不会触发。

### `pi:*` — PI 透传 {#pi-pi-passthrough}

`pi:` 之后的部分直接注册为 PI 扩展事件，因此 `pi:session_start`、`pi:before_provider_headers` 等 PI 独有的挂载点也能以同样方式触达。这类声明只挂载在 PI 后端，脚本收到的是原始 PI 事件对象（附加了 `hook_event_name`、`session_id` 和 `cwd`），而不是 Claude 形状的 payload。

### `cortex:*` — 服务器端事件 {#cortex-server-side-events}

这些事件在 agent-server 进程内部触发，由 HookBus 派发。

| 事件 | 触发时机 | Payload 字段 |
|---|---|---|
| `cortex:server.start` | 服务器完成接线并开始提供服务 | `version`、`pid` |
| `cortex:server.shutdown` | 服务器收到 `SIGTERM` | `version`、`pid`、`reason` |
| `cortex:schedule.fired` | 一个定时任务触发 | `scheduleId`、`name`、`project` |
| `cortex:client.connected` | 远程设备客户端完成注册 | `device` |
| `cortex:client.disconnected` | 远程设备客户端掉线 | `device`，已知时附带 `reason` |
| `cortex:session.new` | 会话因 `!new` 或 "New" 状态按钮而关闭 | `channel`、`sessionId`、`backendSessionId`、`executionId`、`backend`、`model`、`trigger`（`new`）、`timestampIso` |
| `cortex:session.messageEnd` | 一次助手回合完成 | 形状相同，`trigger` 为 `messageEnd` |

在 `cortex:schedule.fired` 中，`name` 承载定时任务的消息，`project` 承载它的 `projectId`。该事件在定时任务的 `preCheck` 通过后触发，早于 Cortex 检查这次运行能否启动，因此即使这次运行随后被跳过，事件也照样触发。

### Matcher {#matchers}

对 `agent:*`、`cc:*` 和 `pi:*` 事件，matcher 是对工具名求值的正则表达式。`agent:*` 与 `cc:*` 的 matcher 使用 Claude 的 PascalCase 名称（`Edit|Write`、`Read|Grep`）；在 PI 侧，桥接会先把 PI 的 `edit` / `read` / `web_fetch` 这类名称映射为上述规范名称再做匹配，因此一个 matcher 能同时覆盖两个后端。`pi:*` 的 matcher 则直接对 PI 的原生工具名求值。非工具事件的匹配方式不同：Claude 用 `SessionStart` matcher 去匹配启动原因（`startup|resume|clear|compact`），而 PI 桥接只对工具事件应用 matcher，在生命周期事件上会忽略它。

对 `cortex:*` 事件，matcher 是一个等值过滤对象，其中每个键都必须出现在 payload 中且值完全相等。例如带 `{"device": "gpu-box"}` 的 `cortex:client.disconnected` 钩子只在那一台设备掉线时触发，而不是每个客户端掉线都触发。

## 编译到智能体后端 {#compiling-to-the-agent-backends}

### Claude Code {#claude-code}

启动 Claude 进程时，`agent-adapter/claude/hooks-builder.ts` 中的 `buildHooksSettings()` 会加载注册表，保留满足以下条件的条目：已启用、挂载在 `claude` 后端、且 `scope.requiresTool` 能在该智能体的工具列表中通过检查；然后生成一个 Claude 设置对象，通过 `--settings` CLI 标志注入。`run.script` 会变成 `node <script path>`——`$CORTEX_HOME/hooks/` 中有该脚本时用它，否则用安装目录中的内置脚本；来自 `$CORTEX_HOME/hooks/` 的脚本还会带上 `--import` 预加载，用来解析它对内置辅助库的 import。`run.command` 原样透传，`run.timeout` 成为 Claude 的每钩子 `timeout`（单位为秒）。同一事件下相邻且 matcher 相同的条目会被合并进同一个 matcher 组：

```json
{
  "PreToolUse": [
    { "matcher": "Edit|Write", "hooks": [
        { "type": "command", "command": "node <install>/defaults/hooks/status-md-guard.mjs", "timeout": 10 }
    ]}
  ],
  "PostToolUse": [
    { "matcher": "Read|Grep", "hooks": [ ... ] },
    { "matcher": "Read|Edit|Write|Skill", "hooks": [ ... ] },
    { "matcher": "Read|Edit", "hooks": [ ... ] }
  ],
  "SessionStart": [ ... ]
}
```

由于每次启动都会重新读取注册表，新声明会在下一个启动的智能体上生效。

### PI {#pi}

`agent-adapter/pi/hook-bridge.ts` 作为 `cortex-hook-bridge` PI 扩展在服务器进程内运行。加载时，它取出挂载在 `pi` 后端的注册表条目，为每个条目调用一次 `pi.on()`，事件名取自上面 `agent:*` 映射表中的原生事件名，或 `pi:*` 事件的字面后缀。PI 上不应用 `scope.requiresTool`。

对 `agent:*` 条目，桥接会把 PI 的数据形状归一化为钩子脚本期望的 Claude 形式：工具名映射为 PascalCase（`edit` → `Edit`、`web_fetch` → `WebFetch`），并且对 `read` / `write` / `edit` 工具把 `input.path` 复制到 `input.file_path`。payload 携带 `hook_event_name`（Claude 事件名——四个 PI 独有事件分别为 `SessionEnd`、`PreCompact`、`UserPromptSubmit` 和 `Stop`）、`session_id`、`tool_name`、`tool_input`、`tool_use_id` 和 `cwd`；工具结果事件另外附加 `tool_output`、`tool_response` 和 `is_error`。钩子进程的环境中会有 `CORTEX_SESSION_ID`。

如果 `run.script` 导出了 `runHook(payload, env)` 函数，它会被 import 并在进程内调用，而不是作为子进程启动；其返回值按子进程脚本打印的 JSON 同样处理。

脚本输出会按原生语义生效。在 `tool_call` 上，`hookSpecificOutput.permissionDecision` 为 `deny` 时会阻断该工具并给出 `permissionDecisionReason`，`hookSpecificOutput.updatedInput` 会替换工具输入。在 `tool_result` 上，`hookSpecificOutput.additionalContext` 会追加到工具内容中。在 `before_agent_start` 上，同一字段会追加到 system prompt。`pi:*` 条目还可以在 `pi:tool_call` 上返回 `{"block": true}`、整体替换 `input`，以及在 `pi:before_provider_headers` 上改写 `headers`。

## 服务器端派发器 {#the-server-side-dispatcher}

`core/hook-bus.ts` 负责派发 `cortex:*` 事件。服务器在启动时把注册表快照进 bus，因此新增的 `cortex:*` 声明会在服务器下次启动时生效。

事件触发时，bus 选出 `event` 完全相同、且对象 matcher 被 payload 满足的已启用条目，然后逐个运行。每个钩子以 `sh -c '<command> "$@"' hook <args>` 运行，工作目录为 `$CORTEX_HOME`，payload 以 JSON 形式从 stdin 送入。`run.timeout` 秒即进程时限——默认 30，会话事件在声明未另行指定时用 60。

bus 如何处理 stdout 取决于 `result`：

- `stdout-as-prompt` — 去掉首尾空白后的 stdout 作为提示使用。会话事件用它来注入一个回合。
- `none` 或省略 — 输出被丢弃；钩子是即发即忘的。

超时或以非零码退出的钩子会连同其 stderr 末尾一起记入守护进程日志，然后被跳过；会话事件钩子在成功时也会记录 stderr。钩子绝不会让其所处的主流程失败。

## 会话事件与提示注入 {#session-events-and-prompt-injection}

`cortex:session.new` 在会话被 `!new` 或 "New" 状态按钮拆除之前触发，前提是有钩子声明了该事件且频道上有活跃会话。`cortex:session.messageEnd` 在带有实时流的会话每次完成助手回合后触发。二者与其他钩子一样以声明方式配置；内置的 `session-new-hook` 声明指向 `new-session-hook.mjs`，`result` 为 `stdout-as-prompt`。

`sessionId` 是 Cortex 会话 id——会话注册表的键，`cortex-hook` 辅助工具据此解析出频道。`backendSessionId` 是后端为该会话的对话分配的 id（即其 transcript 的名字），会话尚无任何回合时为 `null`；一旦后端分配了自己的 id，或回退（rewind）移动了对话，两者就会不同。

除了 stdin 上的 JSON payload，会话钩子还会在环境变量中收到 `CORTEX_HOOK_CHANNEL`、`CORTEX_HOOK_SESSION_ID`、`CORTEX_HOOK_TRIGGER` 和 `CORTEX_HOOK_EXECUTION_ID`，会话已有后端对话时还会收到 `CORTEX_HOOK_BACKEND_SESSION_ID`。非空 stdout 会作为一次新的智能体回合注入，续接这段对话——对 `session.new`，注入到一个事后关闭的隔离会话键上，使这次关闭前的回合不会把旧会话复活到该频道下；对 `session.messageEnd`，直接注入到频道本身，使后续回合延续实时对话，其输出也挂在触发它的那条回复的线程之下。没有后端对话的会话无可续接，因此其钩子输出只展示、不注入。

## hook-bridge：经 HTTP 阻塞的调用 {#the-hook-bridge-blocking-calls-over-http}

有两类交互需要人参与其中，而智能体进程自己无法完成：向用户提问，以及让计划获得批准。二者都向服务器的 loopback webhook 监听端口（`WEBHOOK_PORT`，默认 3001）POST 到 `/hook/ask-user-question` 和 `/hook/exit-plan-mode`，在 `x-cortex-token` 请求头中携带 `CORTEX_WEBHOOK_TOKEN` bearer token 进行认证，并阻塞等待响应。以 `blocking: false` 发出的提问会在卡片弹出后立即返回。

智能体经 `cortex_ask_user` 与 `cortex_plan_exit` 两个 MCP 工具接入这个 bridge；钩子脚本则经 `cortex-hook-api.mjs` 或 `cortex-hook ask` CLI 接入（见[在钩子里向用户提问](#asking-the-user-from-a-hook)）。拥有这些交互工具的 Cortex 会话中不包含 Claude 原生的 `AskUserQuestion` 和 `ExitPlanMode`，因此不需要任何钩子去拦截它们。

在服务器侧，`orchestration/routing/hook-bridge.ts` 注册一个 TTL 为 30 分钟的挂起 promise，并在事件总线上发布 `ask-user.requested` 或 `plan.submitted`。`hook-bridge-subscribers.ts` 中的订阅者把它们呈现在会话所在的平台上——Web UI 上是内联卡片，Slack 和飞书上是交互式消息（见 [safety-and-approvals.md](./safety-and-approvals.md#where-the-cards-appear)）。用户作出响应后，交互处理器解析该 promise，HTTP 响应随之返回给等待中的调用方。

## 钩子脚本 {#hook-scripts}

脚本是普通的 Node.js `.mjs` 文件：从 stdin 读取 JSON 上下文，向 stdout 写 JSON（对 `stdout-as-prompt` 钩子则写纯文本）。内置脚本直接在安装目录 `agent-server/defaults/hooks/` 中原地运行；你的脚本放在 `$CORTEX_HOME/hooks/`。查找脚本名时先查 `$CORTEX_HOME/hooks/`，因此那里与内置脚本同名的文件会替换内置脚本，删除该文件即恢复内置脚本。`$CORTEX_HOME/hooks/` 中的脚本可以用与内置脚本相同的相对路径 import 内置辅助库（`./cortex-hook-api.mjs`、`./cortex-context-lib.mjs` 等）：`$CORTEX_HOME/hooks/` 中无法满足的 import 会改到内置脚本目录中解析。内置脚本如下：

| 脚本 | 使用方 | 用途 |
|---|---|---|
| `status-md-guard.mjs` | `agent:pre-tool`，`Edit\|Write` | 让项目的 `STATUS.md`、`ISSUES.md` 以及记忆树中的 `AGENTS.md` 索引保持在各自的体积上限内（见下文） |
| `memory-ref-tracker.mjs` | `agent:post-tool`，`Read\|Grep` | 把对实验、知识和模式条目的访问记录到 `_meta/access-log.jsonl`（见[引用追踪](#reference-tracking)） |
| `rules-loader.mjs` | `agent:post-tool`，`Read\|Grep` | 读到匹配路径时注入按路径限定的[规则](./configuration.md#built-in-assets-and-your-overrides)——内置规则以及 `$CORTEX_HOME/rules/` 中的规则——每条规则每个会话只注入一次 |
| `session-activity-tracker.mjs` | `agent:post-tool`，`Read\|Edit\|Write\|Skill` | 把活动记录追加到 `logs/session-activity/<session_id>.jsonl` |
| `agents-md-injector.mjs` | `agent:post-tool`（`Read\|Edit`）与 `agent:session-start` | 把 AGENTS.md 祖先链注入智能体上下文，按会话去重 |
| `new-session-hook.mjs` | `cortex:session.new` | 从即将关闭的会话中回忆有价值的信息并写入上下文文件 |

声明也可以用内联的 `run.command` 代替脚本。

`status-md-guard` 执行的体积上限：

| 文件 | 警告阈值 | 超过即拒绝 |
|---|---|---|
| `context/projects/<project>/STATUS.md`、`ISSUES.md` | 60 行或 4 KB | 80 行或 6 KB |
| `context/` 下的任意 `AGENTS.md` | 90 行或 6.5 KB | 120 行或 8 KB |

越过任一上限的编辑会被拒绝，并附上应删减哪些内容的建议。对已经超限的文件，缩减体积的编辑会被放行但给出警告，这样超大的文件可以逐步削减下来。

内置脚本中有几个文件不是钩子入口。`cortex-hook-api.mjs` 是供钩子脚本 import 的辅助库（见下文）。`cortex-context-lib.mjs` 包含 AGENTS.md 去重缓存、内联体积预算和规则 `paths:` 解析器，由 `agents-md-injector.mjs`、`rules-loader.mjs` 与服务器共用，因此钩子与 MCP 侧对远端 AGENTS.md 文件的注入读写的是同一份按会话的缓存。`git-support.mjs` 是 `memory-ref-tracker.mjs` 使用的 Git 辅助模块，`overlay/` 中存放 `--import` 加载器，使 `$CORTEX_HOME/hooks/` 中的脚本能够 import 内置辅助库。

## 在钩子里向用户提问 {#asking-the-user-from-a-hook}

任何钩子都可以在当前会话绑定的消息平台——Slack、飞书或 Web UI——上弹出一张 ask-user-question 卡片，并阻塞直到用户作答。这张卡片与 `cortex_ask_user` 工具生成的交互表单相同，并接受一个可选的严重级别（`info`、`warning` 或 `error`，`warn` 为别名）：在 Web UI 上以通知配色呈现，在 Slack 和飞书上加图标前缀。不指定级别时，卡片保持中性外观。

Node 钩子脚本按相对路径 import 该辅助库，`$CORTEX_HOME/hooks/` 中的脚本同样可以这样做（见[钩子脚本](#hook-scripts)）。`askUser` 接受 `questions`、`level`、`channel`、`sessionId`、`dryRun` 以及客户端侧的 `timeoutMs`（默认 60 分钟），解析结果为 `{ answers, error? }`；`error` 取值为 `timeout`、`post_failed` 或 `bus_not_initialized`。

```js
import { askUser } from './cortex-hook-api.mjs';

const { answers, error } = await askUser({
  questions: [{
    question: 'Disk is almost full — clean old checkpoints?',
    header: 'Disk',
    options: [{ label: 'Clean' }, { label: 'Keep' }],
  }],
  level: 'warning',
});
if (error === 'timeout') process.exit(0); // user did not answer — pick a safe default
```

`run.command` 钩子（以及任何基于 shell 的场景）则使用 CLI：

```bash
cortex-hook ask --question "Disk is almost full — clean old checkpoints?" \
  --options "Clean|Keep" --level warning
# → { "ok": true, "answers": { "Disk is almost full — clean old checkpoints?": "Clean" } }
```

两个入口都携带 `CORTEX_WEBHOOK_TOKEN`（由 Cortex 运行的钩子会继承它）POST 到服务器的 `/hook/ask-user-question` webhook，因此共享同一套路由与阻塞约定：

- **路由。** 显式指定的 `channel` 优先。否则辅助库与 CLI 回退到钩子环境变量：先 `CORTEX_HOOK_CHANNEL`（会话钩子），再 `SLACK_CHANNEL`（智能体侧钩子）。只有 `sessionId` 可用时（`CORTEX_HOOK_SESSION_ID` 或显式传入），服务器会从会话注册表中解析出该会话的频道。`cortex:schedule.fired` 这类服务器事件不携带频道，因此它们的钩子必须自行传入 `channel` 或 `sessionId`。
- **阻塞。** 服务器在 hook-bridge 中挂起请求，TTL 为 30 分钟。响应为 `{ answers }`，TTL 到期时则为 `{ error: "timeout", answers: {} }`。`cortex-hook ask` 收到答案时退出码为 `0`，超时为 `2`，其他错误为 `1`，因此 shell 钩子可以按 `$?` 分支。发起提问的钩子必须把 `run.timeout` 设得高于预期的等待时长，并应声明 `blocking: { "mode": "webhook", "ttlMin": 30 }`，让设置面板显示它会阻塞。
- **多个问题。** `askUser` 接受任意非空的问题数组；`cortex-hook ask --payload <file|->` 接受同样的 JSON 数组，例如 `cat questions.json | cortex-hook ask --payload - --session-id <id>`。Cortex 不限制问题数量上限，但目标平台仍可能拒绝超出其自身限制的 payload。
- **冒烟测试。** `--dry-run`（CLI）或 `dryRun: true`（辅助库）只记录事件并合成一个结果返回，不真正发出卡片。

智能体本身则通过 `cortex_ask_user` MCP 工具的 `level` 参数获得同样的严重级别选项。

## cortex-hook CLI {#the-cortex-hook-cli}

`cortex-hook` 用于查看和操作已挂载的钩子。每条命令都向 stdout 输出 JSON；`--help` 输出纯文本，错误则报告在 stderr 上，退出码为 `1`。

| 命令 | 标志 | 作用 |
|---|---|---|
| `cortex-hook list` | — | 列出每个已挂载的钩子，包含 `id`、`event`、`enabled`、`source`（`builtin` 或 `user`），带覆盖文件的内置钩子还有 `overridden` |
| `cortex-hook show` | `--id <id>` | 打印一条完整声明，包含 `source` |
| `cortex-hook enable` | `--id <id>`、`--dry-run` | 幂等地设置 `enabled: true`：user 钩子写在其声明文件中，内置钩子写在覆盖文件中 |
| `cortex-hook disable` | `--id <id>`、`--dry-run` | 以同样方式设置 `enabled: false` |
| `cortex-hook test` | `--id <id>`、`--payload <file\|->` | 在 `$CORTEX_HOME` 中以 stdin 上的 payload 运行该钩子一次，默认超时 30 秒 |
| `cortex-hook ask` | `--question`、`--header`、`--options "a\|b"`、`--level`、`--channel` / `--session-id`、`--payload <file\|->`、`--multi`、`--dry-run` | 在会话所在平台上发一张 ask-user 卡片并阻塞等待答案（超时退出码为 `2`）。`--header` 默认取问题的前 12 个字符 |

`--help` / `-h` 在根命令和每个子命令上都可用。

```bash
cortex-hook list
cortex-hook show --id session-new-hook
cortex-hook disable --id rules-loader --dry-run
cortex-hook test --id status-md-guard --payload payload.json
cat payload.json | cortex-hook test --id status-md-guard --payload -
```

`enable` 与 `disable` 会报告 `changed`，让你区分真实的状态变化和空操作；`--dry-run` 不写文件，而是附加一个 `would_set` 块。对内置钩子，覆盖文件只记录开关；开关回到内置值时该文件会被删除。

`test` 返回 `ok`、`id`、`exit_code`、`stdout`、`stderr`，进程失败时还有 `error`，并以钩子自身的退出码退出。

## 添加一个钩子 {#adding-a-hook}

1. 把脚本写进 `$CORTEX_HOME/hooks/`，例如 `warn-sensitive-file.mjs`：

   ```javascript
   #!/usr/bin/env node
   const chunks = [];
   for await (const chunk of process.stdin) chunks.push(chunk);
   const input = JSON.parse(Buffer.concat(chunks).toString());

   const path = input.tool_input?.file_path || '';
   if (path.includes('.env') || path.includes('credentials')) {
     console.log(JSON.stringify({
       hookSpecificOutput: {
         hookEventName: 'PreToolUse',
         permissionDecision: 'deny',
         permissionDecisionReason: `Refusing to edit sensitive file: ${path}`
       }
     }));
     process.exit(0);
   }

   console.log(JSON.stringify({
     hookSpecificOutput: {
       hookEventName: 'PreToolUse',
       permissionDecision: 'allow'
     }
   }));
   ```

2. 声明它。把 `$CORTEX_HOME/config/hooks/50-warn-sensitive-file.json` 放进注册表——数字前缀让它排在内置条目之后：

   ```json
   {
     "id": "warn-sensitive-file",
     "event": "agent:pre-tool",
     "matcher": "Edit|Write",
     "run": { "script": "warn-sensitive-file.mjs", "timeout": 5 }
   }
   ```

3. 用 `cortex-hook list`（该 id 出现，source 为 `user`）和 `cortex-hook test --id warn-sensitive-file --payload payload.json` 验证。

`agent:*`、`cc:*` 或 `pi:*` 钩子对下一个启动的智能体生效。`cortex:*` 钩子在服务器下次启动时才会被拾取，因为 bus 在启动时快照注册表。

同样的三步也适用于服务器端事件——声明 `"event": "cortex:schedule.fired"` 并配上 `{"project": "my-project"}` 这样的 `matcher`，就能在该项目的任一定时任务触发时运行某个动作。

## 引用追踪 {#reference-tracking}

`memory-ref-tracker` 钩子为原子化记忆系统实现自动引用追踪（完整架构参见 [memory.md](./memory.md)）。它把每一次触及实验、知识或模式条目——`context/projects/<project>/` 下的 `EXP-NNN.md`、`K-NNN.md` 或 `PAT-NNN.md`——的 Read 与 Grep 记录为一行 JSONL，内容为条目文件名、工具名和时间戳：

```json
{"file": "EXP-012.md", "tool": "Read", "ts": "2026-05-19T10:30:00.000Z"}
```

在项目内执行、但没有匹配到任何条目文件的 Grep 记录为 `"file": "_directory_search"`。日志位于 `<project>/_meta/access-log.jsonl`。当 `$CORTEX_HOME` 是 Git 仓库时，钩子会暂存所有改动过的 `access-log.jsonl`，并以 `chore: update access log` 提交；如果暂存区里已有其他内容，则只暂存不提交。没有 Git 时，访问追踪照样写入日志。记忆索引重建时会读取它来计算访问次数（`refs`）和最后访问时间戳（`last-ref`），二者决定索引排序与冷热分类。

## 调试钩子 {#debugging-hooks}

先用 `cortex-hook list` 确认钩子已挂载且已启用，再用 `cortex-hook test --id <id> --payload <file>` 以你控制的 payload 单独运行它——这样能把“脚本坏了”和“声明根本没匹配上”区分开。服务器端钩子的失败会连同脚本 stderr 的末尾一起记录到 `$CORTEX_HOME/logs/daemon.log`。

- **钩子没出现在 `cortex-hook list` 里** — 加载器拒绝了它。在日志里查找 `[hook-registry] skipped <file>`：JSON 非法、违反 schema，或 `id` 已被更早的文件占用。
- **钩子列出来了却从不触发** — 检查 matcher。`agent:*` 与 `cc:*` 事件的工具 matcher 使用 Claude 的 PascalCase 名称，而 `cortex:*` matcher 要求每个键都出现在 payload 中且值完全相等。
- **`agent:session-end`、`agent:pre-compact`、`agent:user-prompt` 或 `agent:turn-end` 在 Claude 上不起作用** — 这四个只编译到 PI。要挂到 Claude 挂载点，请使用 `cc:` 形式。
- **新的 `cortex:*` 钩子毫无反应** — bus 在启动时快照注册表；请重启服务器。
- **JSON 解析错误** — stdout 不是合法 JSON。确保除结果之外没有其他内容写到 stdout；诊断信息应写到 stderr。
- **超时** — 调大 `run.timeout`（单位为秒）。默认 30 秒，会话事件为 60 秒；在 Claude 上未设置超时时沿用 Claude Code 自身的默认值。
- **`scope.requiresTool` 在 PI 上不起作用** — PI 桥接无论如何都会挂载该钩子；请改用 `scope.backends` 来收窄范围。
- **找不到脚本** — `run.script` 先在 `$CORTEX_HOME/hooks/` 中查找，再在内置脚本中查找；绝对路径与 `..` 片段会被加载器拒绝。
