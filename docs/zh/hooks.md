# 钩子

钩子是 Cortex 在某件事发生时运行的一条命令——工具即将执行、会话开始、线程结束、任务完成。每个钩子都是一份**声明**：`$CORTEX_HOME/config/hooks/` 下的一个 JSON 文件，声明一个事件、一个可选的匹配器，以及要运行的命令。服务器在启动时加载这些声明，各个消费方分别编译自己关心的子集：Claude Code 后端、PI 后端，以及服务器自身的事件派发器。添加一个钩子意味着添加一个文件，而不是改代码。关于钩子在整体系统中的位置，参见 [architecture.md](./architecture.md)。

## 架构概览

```
        $CORTEX_HOME/config/hooks/*.json   — 一个文件一条声明
                            │
                            │  加载 + 校验（store/hook-registry.ts）
        ┌───────────────────┼────────────────────────┐
        ▼                   ▼                        ▼
 Claude 编译器           PI 钩子桥接               HookBus
 hooks-builder.ts      pi/hook-bridge.ts         core/hook-bus.ts
 agent:* + cc:*        agent:* + pi:*            cortex:*
        │                   │                        │
        ▼                   ▼                        ▼
 Claude 生成时注入      扩展加载时调用            服务器端派发，
 --settings JSON       pi.on(<原生事件>)         外加模板作用域的
                                                 线程钩子
        └───────────────────┴────────────────────────┘
                            │
                            ▼
              $CORTEX_HOME/hooks/*.mjs — 脚本本体
```

## 钩子注册表

注册表就是目录 `$CORTEX_HOME/config/hooks/`。其中每个 `.json` 文件是一条钩子声明。文件按文件名排序读取，这个顺序同时也是同一事件下钩子的执行顺序——随 Cortex 发布的声明带有数字前缀（`01-…`、`02-…`），使相对顺序显式可见。

加载是容错且高声报错的。JSON 非法、schema 校验失败，或 `id` 与更早的文件重复的文件会被跳过，并在 stderr 打印 `[hook-registry] skipped <file>: <reason>`；注册表的其余部分照常挂载。服务器启动时会记录挂载数量，形如 `Startup: mounted 12 hooks (1 cc / 2 cortex)`。Web UI 的设置面板读取同一份列表。

### 条目 schema

```json
{
  "id": "sensitive-file-edit",
  "event": "agent:pre-tool",
  "matcher": "Edit|Write",
  "run": { "script": "sensitive-file-edit.mjs", "timeout": 10 },
  "enabled": true,
  "version": "2026.7.29"
}
```

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | string，必填 | 注册表内唯一。`cortex-hook` 和日志行用它指代钩子 |
| `event` | string，必填 | `agent:*` 事件之一，或任意以 `cc:` / `pi:` / `cortex:` 为前缀的名称 |
| `matcher` | string 或 object | `agent:*` / `cc:*` / `pi:*` 事件用正则；`cortex:*` 事件用等值过滤对象。省略即匹配全部 |
| `run.script` | string | 脚本文件名，相对 `$CORTEX_HOME/hooks/` 解析。绝对路径与 `..` 片段会被拒绝 |
| `run.command` | string | 用裸 shell 命令代替脚本。`script` 与 `command` 必须且只能有一个 |
| `run.timeout` | number | 超时，单位**秒**。默认 30 |
| `scope.backends` | array | 收窄 `agent:*` 钩子编译到 `claude` / `pi` 中的哪些后端 |
| `scope.requiresTool` | string | 仅当智能体的工具列表包含该工具时才挂载此钩子 |
| `blocking` | object | `{ "mode": "webhook", "ttlMin": <正数> }`，由加载器校验，用于需要 webhook 往返阻塞的钩子 |
| `result` | string | `hook-result`、`stdout-as-prompt` 或 `none`。决定 `cortex:*` 钩子的 stdout 如何被解释 |
| `enabled` | boolean | `false` 时从所有消费方移除该钩子而不删除文件。默认 `true` |
| `version` | string | CalVer 版本戳（`2026.7.29`，可带 `-1`），标记该条目为 managed |

### managed 条目与 user 条目

带合法 CalVer `version` 的条目是 **managed**：它随 Cortex 发布，启动时只要发布版本比已部署版本更新，就从 `defaults/config/hooks/` 刷新过来。没有 `version` 的条目是 **user** 条目，永不被覆盖——正是这条保证让你可以把自己的声明直接放在随发布的声明旁边。钩子脚本以同样方式同步，依据是脚本源码里的 `@cortex-hook-version` 注释。

## 事件命名空间

### `agent:*` — 后端中立的智能体事件

这些是两个编程智能体后端语义真正一致的事件。一条声明同时编译到 Claude Code 与 PI，且两边交给脚本的 payload 都是 Claude 形状，因此同一个脚本可以服务两个后端。

| `agent:*` 事件 | Claude 事件 | PI 事件 |
|---|---|---|
| `agent:pre-tool` | `PreToolUse` | `tool_call` |
| `agent:post-tool` | `PostToolUse` | `tool_result` |
| `agent:session-start` | `SessionStart` | `before_agent_start` |
| `agent:session-end` | — | `session_shutdown` |
| `agent:pre-compact` | — | `session_before_compact` |
| `agent:user-prompt` | — | `input` |
| `agent:turn-end` | — | `turn_end` |

Claude 编译器为前三个事件生成设置；后四个只到达 PI。要挂上对应的 Claude 挂载点，用原生形式声明为 `cc:SessionEnd`、`cc:PreCompact`、`cc:UserPromptSubmit` 或 `cc:Stop`。

### `cc:*` — Claude Code 原生透传

`cc:` 之后的部分原样用作 Claude 设置里的事件名，因此不改代码就能触达 Claude Code 的任意挂载点——`cc:PermissionRequest`（随发布的自动放行钩子即用它）、`cc:SessionEnd`、`cc:PreCompact`、`cc:UserPromptSubmit`、`cc:Stop`。这类声明只挂在 Claude 后端。

### `pi:*` — PI 原生透传

`pi:` 之后的部分直接注册为 PI 扩展事件，因此 `pi:session_start`、`pi:before_provider_headers` 等 PI 独有挂载点也以同样方式可用。这类声明只挂在 PI 后端，且脚本收到的是原始 PI 事件对象，而非 Claude 形状的 payload。

### `cortex:*` — 服务器端事件

这些事件在 agent-server 进程内部触发，由 HookBus 派发。

| 事件 | 触发时机 | payload 字段 |
|---|---|---|
| `cortex:server.start` | 服务器完成接线并开始服务 | `version`、`pid` |
| `cortex:server.shutdown` | 服务器收到 `SIGTERM` | `version`、`pid`、`reason` |
| `cortex:thread.start` | 线程第一个智能体步骤之前 | 完整线程上下文（见下） |
| `cortex:thread.transition` | 智能体步骤之间、转换评估之后 | 完整线程上下文 |
| `cortex:thread.end` | 线程主循环结束之后 | 完整线程上下文 |
| `cortex:dispatch.started` | 一个任务被分发进线程 | `taskId`、`project`、`source`、`templateName` |
| `cortex:schedule.fired` | 一个计划任务触发 | `scheduleId`、`name`、`project` |
| `cortex:task.completed` | 任务被标记为完成 | `taskId`、`project` |
| `cortex:task.blocked` | 任务被阻塞 | `taskId`、`project`、`reason` |
| `cortex:client.connected` | 远程设备客户端注册 | `device` |
| `cortex:client.disconnected` | 远程设备客户端掉线 | `device`，已知时带 `reason` |
| `cortex:session.new` | 会话因 `!new` 或“New”状态按钮而关闭 | `channel`、`sessionId`、`sessionName`、`executionId`、`profile`、`trigger`（`new`）、`timestampIso` |
| `cortex:session.messageEnd` | 一次助手回合完成 | 同样的形状，`trigger` 为 `messageEnd` |

三个 `cortex:thread.*` 事件携带的线程上下文为：`threadId`、`templateName`、`phase`、`source`、`project`、`projectId`、`taskId`、`taskProject`、`currentStepIndex`、`steps`、`activeAgent`、`previousAgent`、`artifactContent`、`userMessage`、`totalCostUsd`、`pendingControlAction`。

### 匹配器

对 `agent:*`、`cc:*`、`pi:*` 事件，匹配器是对工具名求值的正则。`agent:*` 与 `cc:*` 的匹配器使用 Claude 的 PascalCase 名称（`Edit|Write`、`Read|Grep`）；在 PI 侧，桥接会先把 PI 的 `edit` / `read` / `web_fetch` 这类名称映射为上述规范名再做匹配，因此一个匹配器覆盖两个后端。`pi:*` 的匹配器则直接对 PI 的原生工具名求值。非工具事件的匹配对象不同：Claude 用 `SessionStart` 匹配器去匹配启动原因（`startup|resume|clear|compact`），而 PI 桥接只对工具事件应用匹配器，生命周期事件上忽略它。

对 `cortex:*` 事件，匹配器是一个等值过滤对象，其中每个键都必须出现在 payload 中且值完全相等。随发布的分发钩子使用 `{"source": "task-dispatch"}`，因此它只对由任务分发启动的线程触发，而不是每个结束的线程都触发。

## 编译到智能体后端

### Claude Code

生成 Claude 进程时，`agent-adapter/claude/hooks-builder.ts` 中的 `buildHooksSettings()` 加载注册表，保留已启用、挂在 `claude` 后端、且 `scope.requiresTool` 能在该智能体工具列表中得到满足的条目，然后生成一个通过 `--settings` CLI 标志注入的 Claude 设置对象。`run.script` 变为 `node $CORTEX_HOME/hooks/<script>`，`run.command` 原样透传，`run.timeout` 成为 Claude 的每钩子 `timeout`（秒）。同一事件下相邻且匹配器相同的条目会被合并进同一个 matcher 组：

```json
{
  "PreToolUse": [
    { "matcher": "Edit|Write", "hooks": [
        { "type": "command", "command": "node $CORTEX_HOME/hooks/sensitive-file-edit.mjs", "timeout": 10 },
        { "type": "command", "command": "node $CORTEX_HOME/hooks/tasks-yaml-guard.mjs", "timeout": 10 }
    ]},
    { "matcher": "AskUserQuestion", "hooks": [ ... ] }
  ],
  "PostToolUse": [ ... ],
  "SessionStart": [ ... ],
  "PermissionRequest": [ ... ]
}
```

由于每次生成都会重新读取注册表，新声明会在下一个启动的智能体上生效。在环境中设置 `CORTEX_HOOKS_LEGACY=1` 会绕过注册表，改用一张固定的内置表。

### PI

`agent-adapter/pi/hook-bridge.ts` 作为 PI 扩展运行。加载时它取出挂在 `pi` 后端的注册表条目，为每个条目调用一次 `pi.on()`，事件名取自上面 `agent:*` 映射表中的原生名，或 `pi:*` 事件的字面后缀。

对 `agent:*` 条目，桥接把 PI 的形状归一化为钩子脚本期望的 Claude 形式：工具名映射为 PascalCase（`edit` → `Edit`、`web_fetch` → `WebFetch`），并为 `read` / `write` / `edit` 工具把 `input.path` 复制到 `input.file_path`。payload 携带 `hook_event_name`（Claude 名）、`session_id`、`tool_name`、`tool_input`、`tool_use_id`、`cwd`；工具结果事件另加 `tool_output`、`tool_response`、`is_error`。

脚本输出会被原生地兑现。在 `tool_call` 上，`hookSpecificOutput.permissionDecision` 为 `deny` 会阻断该工具并给出 `permissionDecisionReason`，`hookSpecificOutput.updatedInput` 会替换工具输入。在 `tool_result` 上，`hookSpecificOutput.additionalContext` 会追加到工具内容中。在 `before_agent_start` 上，同一字段会追加到 system prompt。`pi:*` 条目还可以在 `pi:tool_call` 上返回 `{"block": true}`、整体替换 `input`，以及在 `pi:before_provider_headers` 上改写 `headers`。

## 服务器端派发器

`core/hook-bus.ts` 派发 `cortex:*` 事件。服务器在启动时把注册表快照进 bus，因此新增的 `cortex:*` 声明在服务器下次启动时生效。

事件触发时，bus 选出 `event` 完全相同、且对象匹配器被 payload 满足的已启用条目，然后逐个运行。每个钩子以 `sh -c '<command> "$@"' hook <args>` 运行，工作目录为 `$CORTEX_HOME`，payload 以 JSON 从 stdin 送入，stderr 被捕获进守护进程日志。`run.timeout` 秒即进程上限——默认 30，会话事件在声明未另行指定时用 60。

bus 如何处理 stdout 取决于 `result`：

- `hook-result` — stdout 按 JSON 解析并交回调用方。线程生命周期钩子用它请求一次后续智能体回合。
- `stdout-as-prompt` — 去掉首尾空白的 stdout 作为提示使用。会话事件用它注入一个回合。
- `none` 或省略 — 输出被丢弃；钩子是即发即忘的。

超时、非零退出或输出无法解析的钩子会被记录并跳过，绝不会让其所处的主流程失败。

## 线程模板作用域的钩子

有些钩子属于某一个线程模板而非整个系统，因此模板在 `$CORTEX_HOME/config/thread-templates/templates/<name>.json` 里保留自己的钩子块：

```json
{
  "name": "example",
  "hooks": {
    "onEnd": {
      "command": "node $CORTEX_HOME/hooks/post-task-hook.mjs",
      "args": ["reviewer"],
      "timeout": 10000
    }
  }
}
```

`onStart`、`onTransition`、`onEnd` 分别对应 `cortex:thread.start`、`cortex:thread.transition`、`cortex:thread.end`。它们与注册表钩子经由同一个 bus、在同一次触发中派发，使用合成 id `template:<template>:<phase>`，且始终按 `hook-result` 语义处理。与注册表条目有两点不同：这里的 `timeout` 单位是**毫秒**（默认 30000），且 `args` 以位置参数 `$1`、`$2` 传给命令。以编程方式启动线程的调用方可以为该次运行单独提供同样形状的额外钩子；它们以 `extra:<threadId>:<phase>` 出现。

线程钩子通过向 stdout 写 JSON 来控制接下来发生什么：

```json
{
  "insertAgent": true,
  "profile": "__active__",
  "prompt": "审查线程输出并建议下一步。"
}
```

`insertAgent` 会为该提示生成一个临时智能体。若要把提示路由给线程中已有的智能体，指名即可：

```json
{
  "targetAgent": "reviewer",
  "prompt": "规划器已完成。这里是额外的上下文……"
}
```

`targetAgent` 把提示发送到该智能体的持久会话；两种模式下都可用可选的 `directive` 前置到提示之前。

## 会话事件与提示注入

`cortex:session.new` 在会话被 `!new` 或“New”状态按钮拆除之前触发，`cortex:session.messageEnd` 在每次助手回合之后触发。二者与其他钩子一样以声明方式配置；随发布的 `session-new-hook` 声明指向 `new-session-hook.mjs`，`result` 为 `stdout-as-prompt`。

除了 stdin 上的 JSON payload，会话钩子还会在环境中收到 `CORTEX_HOOK_CHANNEL`、`CORTEX_HOOK_SESSION_ID`、`CORTEX_HOOK_SESSION_NAME`、`CORTEX_HOOK_TRIGGER` 和 `CORTEX_HOOK_EXECUTION_ID`。非空 stdout 会作为一次新的智能体回合注入——对 `session.new`，注入到仍存活的会话上，并使用一个事后关闭的隔离会话键，使这次关闭前的回合不会把旧会话复活到频道槽位上；对 `session.messageEnd`，注入在频道本身上，因此后续回合延续实时对话，其输出也挂在触发它的那条回复之下。

## hook-bridge：经 HTTP 阻塞的工具调用

有两个工具事件需要人介入，而智能体进程自己做不到。`ask-user-question-hook.mjs` 与 `exit-plan-mode-hook.mjs` 向服务器的 webhook 监听端口（`WEBHOOK_PORT`，默认 3001）POST 到 `/hook/ask-user-question` 和 `/hook/exit-plan-mode`，并阻塞等待响应。

在服务器侧，`orchestration/routing/hook-bridge.ts` 注册一个带 30 分钟 TTL 的挂起 promise，并在事件总线上发布 `ask-user.requested` 或 `plan.submitted`。`hook-bridge-subscribers.ts` 中的订阅者把它们转成交互式 Slack 消息。当用户点击按钮或提交模态框时，交互处理器解析该 promise，HTTP 响应回到等待中的钩子脚本，脚本把答案写到 stdout——智能体将其读作该工具执行前的结果。

## 钩子脚本

脚本位于 `$CORTEX_HOME/hooks/`，是普通的 Node.js `.mjs` 文件：从 stdin 读 JSON 上下文，向 stdout 写 JSON（对 `stdout-as-prompt` 钩子则写纯文本）。随 Cortex 发布的脚本如下：

| 脚本 | 使用方 | 用途 |
|---|---|---|
| `sensitive-file-edit.mjs` | `agent:pre-tool`，`Edit\|Write` | 直接完成写入，使受保护的智能体配置路径仍可编辑，随后拒绝内置工具以免重复执行 |
| `tasks-yaml-guard.mjs` | `agent:pre-tool`，`Edit\|Write` | 当前进程不持有项目锁时，拒绝对 `TASKS.yaml` 的编辑 |
| `ask-user-question-hook.mjs` | `agent:pre-tool`，`AskUserQuestion` | 把问题转发给 hook-bridge 并阻塞直到用户回答 |
| `exit-plan-mode-hook.mjs` | `agent:pre-tool`，`ExitPlanMode` | 把计划转发给 hook-bridge 并阻塞直到批准或拒绝 |
| `memory-ref-tracker.mjs` | `agent:post-tool`，`Read\|Grep` | 把内存文件访问记录到 `_meta/access-log.jsonl` |
| `rules-loader.mjs` | `agent:post-tool`，`Read\|Grep` | 读到匹配路径时注入 `$CORTEX_HOME/rules/` 下的限定规则，每条规则每会话一次 |
| `session-activity-tracker.mjs` | `agent:post-tool`，`Read\|Edit\|Write\|Skill` | 把活动记录追加到 `logs/session-activity/<session_id>.jsonl` |
| `cortex-md-injector.mjs` | `agent:post-tool`（`Read\|Edit`）与 `agent:session-start` | 把 CORTEX.md 祖先链注入智能体上下文，并按会话去重 |
| `task-status-check.mjs` | `cortex:thread.end`，`{"source": "task-dispatch"}` | 检查被分发的任务是否停留在未决状态，并要求线程收尾 |
| `new-session-hook.mjs` | `cortex:session.new` | 从即将关闭的会话中回忆有价值的信息并写入上下文文件 |
| `post-task-hook.mjs` | 模板的 `onEnd` 钩子 | 提示目标智能体沉淀所学并提交 |

`PermissionRequest` 自动放行声明用的是 `run.command` 而非脚本：一行 `printf`，对 `Edit|Write` 返回 allow 决策。这两个工具的访问控制由上面的 pre-tool 守卫负责。

同目录下的 `cortex-hook-api.mjs` 不是钩子入口，而是供钩子脚本 import 的辅助库（见下一节）。

## 从钩子向用户提问

任何钩子都可以在当前会话绑定的消息平台——Slack、飞书或 Web UI——上弹出一张 ask-user-question 卡片，并阻塞等待用户作答。卡片与 `AskUserQuestion` 工具产生的交互表单相同，并接受可选的分级（`info`、`warning`、`error`，`warn` 是别名）：Web UI 复用 ChatNotice 的分级配色，Slack 与飞书在标题前加对应图标。不带分级时卡片保持中性外观。

Node 钩子脚本直接 import 与其同目录（`$CORTEX_HOME/hooks/`）的辅助库：

```js
import { askUser } from './cortex-hook-api.mjs';

const { answers, error } = await askUser({
  questions: [{
    question: '磁盘即将写满——清理旧 checkpoint？',
    header: 'Disk',
    options: [{ label: '清理' }, { label: '保留' }],
  }],
  level: 'warning',
});
if (error === 'timeout') process.exit(0); // 用户未作答——按安全默认继续
```

`run.command` 型钩子（以及任何 shell 场景）用 CLI：

```bash
cortex-hook ask --question "磁盘即将写满——清理旧 checkpoint？" \
  --options "清理|保留" --level warning
# → { "ok": true, "answers": { "磁盘即将写满——清理旧 checkpoint？": "清理" } }
```

两个入口都 POST 到服务器的 `/hook/ask-user-question` webhook，共享同一套路由与阻塞契约：

- **路由。** 显式 `channel` 优先。否则辅助库与 CLI 回退到钩子环境变量：`CORTEX_HOOK_CHANNEL`（会话钩子），然后 `SLACK_CHANNEL`（智能体侧钩子）。只有 `sessionId` 时（`CORTEX_HOOK_SESSION_ID` 或显式传入），服务器会经 session registry 反解出该会话的 channel。`cortex:thread.*` 的 payload 不含 channel，线程钩子须自行传 `channel` 或 `sessionId`。
- **阻塞。** 服务器在 hook-bridge 中挂起请求，TTL 30 分钟。响应是 `{ answers }`，TTL 到期则是 `{ error: "timeout", answers: {} }`。`cortex-hook ask` 有答案时退出码为 `0`，超时为 `2`，其他错误为 `1`，shell 钩子可按 `$?` 分支。发起提问的钩子应把 `run.timeout` 设得高于预期等待时长，并声明 `blocking: { "mode": "webhook", "ttlMin": 30 }`，与随附的 `ask-user-question-hook` 声明一致。
- **多问题。** `askUser` 接受 1–4 个问题对象；`cortex-hook ask --payload <file|->` 接受同样的 JSON 数组，例如 `cat questions.json | cortex-hook ask --payload - --session-id <id>`。
- **冒烟测试。** `--dry-run`（CLI）或 `dryRun: true`（辅助库）只记录事件并合成返回，不真正发卡片。

智能体本体则通过 `cortex_ask_user` MCP 工具的 `level` 参数获得同样的分级能力。

## cortex-hook CLI

`cortex-hook` 用于查看和操作已挂载的钩子。所有命令都输出 JSON。

| 命令 | 标志 | 作用 |
|---|---|---|
| `cortex-hook list` | — | 列出每个已挂载钩子的 `id`、`event`、`enabled`、`source`（`managed`、`user` 或 `template-scoped`） |
| `cortex-hook show` | `--id <id>` | 打印一条完整声明，含 `source` |
| `cortex-hook enable` | `--id <id>`、`--dry-run` | 幂等地把声明文件中的 `enabled` 设为 `true` |
| `cortex-hook disable` | `--id <id>`、`--dry-run` | 以同样方式设为 `false` |
| `cortex-hook test` | `--id <id>`、`--payload <file\|->` | 用给定 payload 从 stdin 执行该钩子一次 |
| `cortex-hook ask` | `--question`、`--options "a\|b"`、`--level`、`--channel` / `--session-id`、`--payload <file\|->`、`--multi`、`--dry-run` | 在会话的消息平台上发一张 ask-user 卡片并阻塞等待答案（超时退出码 `2`） |

`--help` / `-h` 在根命令和每个子命令上都可用。

```bash
cortex-hook list
cortex-hook show --id task-status-check
cortex-hook disable --id rules-loader --dry-run
cortex-hook test --id sensitive-file-edit --payload payload.json
cat payload.json | cortex-hook test --id sensitive-file-edit --payload -
```

`enable` 与 `disable` 会报告 `changed`，让你区分真实的状态变化和空操作；`--dry-run` 不写文件，改为附加一个 `would_set` 块。禁用一个 managed 钩子会返回警告：之后如果同步部署了该条目的更新版本，会把它恢复为发布时的 `enabled` 状态。模板作用域的钩子是只读的——`enable` 与 `disable` 会拒绝它们，并列出你可以操作的注册表 id。

`test` 返回 `ok`、`id`、`exit_code`、`stdout`、`stderr`，进程失败时还有 `error`，并以钩子自身的退出码退出。

## 添加一个钩子

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
         permissionDecisionReason: `拒绝编辑敏感文件：${path}`
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

2. 声明它。把 `$CORTEX_HOME/config/hooks/50-warn-sensitive-file.json` 放在随发布的条目旁边——数字前缀让它排在它们之后：

   ```json
   {
     "id": "warn-sensitive-file",
     "event": "agent:pre-tool",
     "matcher": "Edit|Write",
     "run": { "script": "warn-sensitive-file.mjs", "timeout": 5 }
   }
   ```

   不要写 `version`。这标记该条目属于你，钩子同步永远不会碰它。

3. 用 `cortex-hook list` 验证（该 id 出现，source 为 `user`），再用 `cortex-hook test --id warn-sensitive-file --payload payload.json` 验证。

`agent:*`、`cc:*`、`pi:*` 钩子在下一个生成的智能体上生效。`cortex:*` 钩子在服务器下次启动时被拾取，因为 bus 在启动时快照注册表。

同样的三步也适用于服务器端事件——声明 `"event": "cortex:task.completed"` 并配上 `{"project": "my-project"}` 这样的 `matcher`，即可在该项目每次完成任务时运行某个动作。

## 引用追踪

`memory-ref-tracker` 钩子为原子化内存系统实现自动引用追踪（完整架构参见 [memory.md](./memory.md)）。它把对实验、知识和模式文件的每次 Read 与 Grep 访问记录为一行 JSONL——被访问的文件名、工具名与时间戳：

```json
{"file": "<entry>.md", "tool": "Read", "ts": "2026-05-19T10:30:00.000Z"}
```

日志位于 `<project>/_meta/access-log.jsonl`，每次写入后自动提交到 git。内存索引重建会读取它来计算访问计数（`refs`）和最后访问时间戳（`last-ref`），这些驱动索引排序与热/冷分类。

## 调试钩子

先用 `cortex-hook list` 确认钩子已挂载且已启用，再用 `cortex-hook test --id <id> --payload <file>` 以你控制的 payload 单独运行它——这能把“脚本坏了”和“声明根本没匹配上”分开。钩子的执行与失败记录在 `$CORTEX_HOME/logs/daemon.log`；脚本写到 stderr 的内容也会被捕获到那里。

- **钩子没出现在 `cortex-hook list` 里** — 加载器拒绝了它。在日志里找 `[hook-registry] skipped <file>`：JSON 非法、schema 违规，或 `id` 已被更早的文件占用。
- **钩子列出来了却从不触发** — 检查匹配器。`agent:*` 与 `cc:*` 事件的工具匹配器用 Claude 的 PascalCase 名称，而 `cortex:*` 匹配器要求每个键都出现在 payload 中且值完全相等。
- **`agent:session-end`、`agent:pre-compact`、`agent:user-prompt` 或 `agent:turn-end` 在 Claude 上没效果** — 这四个只编译到 PI。要挂 Claude 挂载点，请用 `cc:` 形式。
- **新的 `cortex:*` 钩子毫无动静** — bus 在启动时快照注册表；重启服务器。
- **JSON 解析错误** — stdout 不是合法 JSON。确保除结果外没有别的内容写到 stdout；诊断信息应走 stderr。
- **超时** — 调大 `run.timeout`（注册表条目为秒，模板钩子为毫秒）。默认 30 秒，会话事件为 60 秒。
- **找不到脚本** — `run.script` 相对 `$CORTEX_HOME/hooks/` 解析；绝对路径与 `..` 片段会被加载器拒绝。
