# Cortex 线程系统


线程系统是 Cortex 的多智能体编排引擎。线程是一个聚焦的智能体接力——每个智能体拥有自己的系统提示、工具和插件——在它们之间传递共享的产物文件以完成复杂的多步骤研究工作。

## 心智模型

线程就像接力赛。每个智能体（跑者）拿起接力棒（`artifact.md` 文件），完成自己的工作，并根据转换规则将接力棒交给下一个智能体。产物文件是共享内存——智能体将发现写入其中，后续智能体读取之前的输出。

线程由 `~/.cortex/config/thread-templates/` 下的**模板**定义（参见下方"配置文件"章节）。线程通常由任务调度系统启动——任务如何触发线程执行参见 [tasks.md](./tasks.md)。模板指定：哪些智能体参与、以什么顺序、按什么转换逻辑、以及在步骤之间触发什么生命周期钩子。

## 配置文件

线程系统在 `~/.cortex/config/thread-templates/` 目录下配置（从 `$CORTEX_HOME/config/thread-templates/` 读取）——这是一个**目录**，每个实体一个 JSON 文件，分为三个子目录：

```
~/.cortex/config/thread-templates/
├── agents/<name>.json      # 每个文件一个智能体定义
├── templates/<name>.json   # 每个文件一个管道模板（或 shell 绑定）
└── shells/<name>.json      # 每个文件一个 shell 定义（参数化转换图）
```

每个文件只装一个实体，且**文件名（去掉 `.json`）即实体名**。对于 `agents/`，JSON 中的 `name` 字段必须与文件名一致，否则该文件被跳过并告警；对于 `templates/`，`name` 字段可选，但若存在则必须与文件名一致。

**加载优先级。** 若 `config/thread-templates/` 目录存在，则使用该目录。否则加载器回落读取旧的单文件 `config/thread-templates.json`（向后兼容）。注意 shell 绑定仅在目录形式下才能解析——shell 定义位于 `shells/` 下，因此旧的单文件配置无法展开它们。

**一次性迁移。** 服务器启动时，若存在旧的 `config/thread-templates.json` 且目录尚不存在，则将该单文件拆分为目录下的每实体文件，并将原文件改名为 `thread-templates.json.migrated-bak`（原文件保留，绝不删除）。迁移是幂等的——目录一旦存在即为空操作。

**默认值合并。** 随产品发货的默认配置同样是目录。启动时它们以**逐文件 copy-if-missing** 语义合并进你的配置（对齐 plugin-sync）：你尚未拥有的默认 agent/template/shell 文件会被拷入；你已有的文件绝不被覆盖。这让新增的默认实体（例如新发货的 shell 定义）能够到达已有安装，同时不冲掉本地改动。

**热重载。** 每个实体子目录（`agents/`、`templates/`、`shells/`）都被监视，`prompts/` 目录中的任何提示文件也一并监视。更改通过 `fs.watch` 检测、去抖（300ms）后整体重新加载，无需重启服务器。重载为 fail-soft：单个格式错误的 JSON 文件被跳过并告警，而非清空整张表。重载时向管理 Slack 频道发送通知。

### 智能体定义

`agents/` 下的每个文件定义一个智能体——一个独立的实体，有自己的身份、工具和提示。文件中直接放智能体对象本身，其 `name` 必须与文件名一致。

`agents/planner.json`：

```json
{
  "name": "planner",
  "description": "规划研究方法",
  "profile": "claude-sonnet",
  "persistSession": false,
  "directive": "你是一个研究规划器。将问题分解为可测试的假设。",
  "promptTemplate": "file:planner-prompt.md",
  "tools": "Agent,AskUserQuestion,Bash,Read,Grep,Glob,Write,Edit,WebSearch,WebFetch,Skill",
  "pluginDirs": ["plugins/cortex-common", "plugins/cortex-surveyor"]
}
```

**智能体定义字段：**

| 字段 | 类型 | 描述 |
|-------|------|-------------|
| `name` | string | 智能体 ID——必填，且必须与文件名一致（`agents/<name>.json`） |
| `profile` | string | `profiles.json` 中的配置名称，或使用当前运行时配置的 `"__active__"` |
| `persistSession` | boolean | `true`：在迭代间重用相同的 LLM 会话（保留对话上下文）。`false`：每个步骤使用新会话 |
| `directive` | string? | 智能体角色/身份，添加到提示之前。支持 `file:filename.md` 引用 |
| `systemPrompt` | string? | 完整系统提示覆盖。支持 `file:` 引用 |
| `promptTemplate` | string? | 带 `{{input}}`、`{{artifactPath}}`、`{{previousOutput}}`、`{{modifiedFiles}}`、`{{currentDateTime}}` 变量的模板。支持 `file:` 引用 |
| `claudeAgent` | string? | Claude Code 智能体名称（`--agent` 标志，从 `.claude/agents/` 加载） |
| `outputStyle` | string? | Claude Code 输出风格 |
| `tools` | string? | 逗号分隔的工具列表（覆盖默认值） |
| `pluginDirs` | string[]? | 要加载的插件目录（`--plugin-dir` 标志） |

### 多阶段智能体

智能体可以通过 `stages` 字段声明多个**阶段**。当存在阶段时，`promptTemplate` 被忽略——引擎根据转换目标为每个步骤选择适当的阶段提示。

`agents/coder.json`：

```json
{
  "name": "coder",
  "profile": "claude-sonnet",
  "persistSession": true,
  "entryStage": "implement",
  "stages": {
    "implement": {
      "promptTemplate": "你正在实施计划。将代码写入 {{artifactPath}}。",
      "description": "编写实现"
    },
    "review": {
      "promptTemplate": "你正在审查 {{artifactPath}} 中的代码。检查正确性。",
      "continuesSession": true,
      "description": "审查实现"
    }
  },
  "pluginDirs": ["plugins/cortex-coder"]
}
```

当阶段上设置了 `continuesSession: true`，且智能体有一个正在恢复的持久会话时，引擎只发送阶段特定的增量提示——跳过指令、协议引言和自动的 `previousOutput` 注入。

### 文件引用

接受 `file:filename.md` 语法的字段从 `prompts/<subdir>/filename.md` 加载内容：

| 字段 | 子目录 |
|-------|-------------|
| `directive` | `prompts/directives/` |
| `promptTemplate` | `prompts/promptTemplates/` |
| `systemPrompt` | `prompts/systemPrompts/` |

模板系统支持基于 YAML frontmatter 的格式，包括 `extends:`（继承）、`@fill(name)`/`@endfill` 命名块、`@block(name)`/`@endblock` 模板块、`${var}`/`${var:-default}` 变量插值和 `@if(var)`/`@endif` 条件。

## 模板

模板将智能体组合为多步骤管道。`templates/` 下的每个文件装一个模板对象。

`templates/coder-review.json`：

```json
{
  "name": "coder-review",
  "description": "实现一个功能然后审查它",
  "agents": ["planner", "coder", "reviewer"],
  "transitions": [
    {"from": "planner", "to": "coder:implement", "condition": {"type": "always"}},
    {"from": "coder:implement", "to": "coder:review", "condition": {"type": "always"}},
    {"from": "coder:review", "to": "reviewer", "condition": {"type": "always"}}
  ],
  "entryAgent": "planner",
  "maxTotalSteps": 10,
  "maxTotalCostUsd": 5.00,
  "hooks": {
    "onEnd": {
      "command": "node hooks/post-task-hook.mjs",
      "timeout": 30000
    }
  }
}
```

**模板字段：**

| 字段 | 类型 | 描述 |
|-------|------|-------------|
| `name` | string? | 可选；若存在则必须与文件名一致（`templates/<name>.json`）。文件名即模板 ID，用于 `!thread <name>` 和任务调度 |
| `agents` | TemplateAgentRef[] | 有序的参与智能体列表 |
| `transitions` | TransitionRule[] | 控制何时从一个智能体移动到下一个的规则 |
| `entryAgent` | string | 第一个运行的智能体 |
| `entryStage` | string? | 第一步进入哪个阶段（默认为智能体的 `entryStage`） |
| `maxTotalSteps` | number | 智能体步骤总数的硬限制 |
| `maxTotalCostUsd` | number? | USD 费用限制 |
| `hooks` | ThreadHooks? | 生命周期钩子（onStart、onTransition、onEnd） |

### 模板中的智能体引用

模板按名称（字符串）或按模板覆盖（对象）引用智能体：

```json
// 简单引用 — 使用定义的智能体
"agents": ["planner", "reviewer"]

// 带覆盖 — 为此模板自定义智能体
"agents": [
  {"ref": "planner"},
  {"ref": "coder", "promptTemplate": "file:special-coder-prompt.md", "tools": "Read,Write,Edit"}
]
```

覆盖字段：`promptTemplate`、`directive`、`systemPrompt`、`persistSession`、`claudeAgent`、`outputStyle`、`tools`、`pluginDirs`。

### Shell 模板

若多个管道共享同一转换图、仅在由哪些智能体担任角色上不同，可将其一次性定义为一个 **shell**——即一个参数化转换图，以纯 JSON 存于 `shells/<name>.json`——并由 `templates/` 中轻量的 **shell 绑定**引用。

shell 声明其参数，并在转换图中使用占位符：

- `{param}` — 替换为该参数在绑定中的取值（一个智能体名）。
- `{param.entryStage}` — 替换为该智能体的 `entryStage`，从 `agents/` 下该智能体的定义解析。

例如随产品发货的 `worker-review` shell（`shells/worker-review.json`）——一个通用的"产出后审核"环：

```json
{
  "params": ["worker", "reviewer"],
  "agents": ["{worker}", "{reviewer}"],
  "transitions": [
    { "from": "{worker}:{worker.entryStage}", "to": "{reviewer}", "condition": { "type": "always" } },
    { "from": "{reviewer}", "to": "{worker}:retry", "condition": { "type": "convergence", "marker": "[APPROVED]", "maxIterations": 1 } },
    { "from": "{worker}:retry", "to": "{reviewer}", "condition": { "type": "output_not_contains", "pattern": "\\[REVISED\\]" } }
  ],
  "entryAgent": "{worker}",
  "entryStage": "{worker.entryStage}",
  "maxTotalSteps": 4,
  "hooks": {
    "onEnd": { "command": "node ~/.cortex/hooks/post-task-hook.mjs", "args": ["{worker}"], "timeout": 10000 }
  }
}
```

模板随后通过指定 shell 名及其参数来绑定它（`templates/doc-review.json`）：

```json
{
  "shell": "worker-review",
  "worker": "doc-writer",
  "reviewer": "doc-reviewer",
  "description": "文档的通用产出后审核"
}
```

加载时引擎插值占位符并校验结果，产出一个与手写转换图等价的完整模板（此例为：`doc-writer` 在其入口阶段 → `doc-reviewer` → `doc-writer:retry`，直至 `[APPROVED]`）。校验错误——缺少参数、未知占位符、引用的智能体不存在、智能体缺少 `entryStage`、或某转换端点引用了该智能体没有的阶段——会使该单个模板在加载期报错失败；未知的 shell 名则 fail-soft 跳过。任一情形下，配置的其余部分照常加载。

**Shell 定义字段（`shells/<name>.json`）：**

| 字段 | 类型 | 描述 |
|-------|------|-------------|
| `params` | string[] | 必需的绑定参数名 |
| `agents` | string[] | 以占位符字符串表示的智能体槽位（如 `"{worker}"`）——声明哪些参数命名智能体 |
| `transitions` | TransitionRule[] | 带占位符端点的转换图 |
| `entryAgent` | string | 入口智能体占位符 |
| `entryStage` | string? | 入口阶段占位符 |
| `maxTotalSteps` | number | 默认步数预算（绑定的 `maxTotalSteps` 可覆盖） |
| `maxTotalCostUsd` | number? | 以 USD 计的成本上限 |
| `hooks` | ThreadHooks? | 生命周期钩子（args 中允许占位符） |

**Shell 绑定字段（引用 shell 的模板）：**

| 字段 | 类型 | 描述 |
|-------|------|-------------|
| `shell` | string | 要展开的 shell 名 |
| `<param>` | string | 每个 shell 参数一个取值（如 `worker`、`reviewer`）——担任该角色的智能体名 |
| `description` | string? | 人类可读描述（携带到展开后的模板上） |
| `maxTotalSteps` | number? | 覆盖 shell 的默认步数预算 |

## 转换

转换决定线程如何从一个智能体移动到下一个。它们在每个智能体步骤完成后进行评估。

### 转换端点语法

端点使用 `"agent"` 或 `"agent:stage"` 语法。裸智能体名称匹配该智能体的任何阶段。`agent:stage` 端点仅匹配该特定阶段。

### 条件类型

| 类型 | 行为 | 参数 |
|------|----------|------------|
| `always` | 总是转换 | 无 |
| `convergence` | 循环直到产物输出中出现标记字符串，或达到 `maxIterations` | `marker`（要查找的字符串），`maxIterations`（最大循环次数，默认 3） |
| `output_contains` | 如果产物输出匹配正则表达式模式则转换 | `pattern`（正则表达式字符串） |
| `output_not_contains` | 如果产物输出不匹配正则表达式模式则转换 | `pattern`（正则表达式字符串） |

### 评估顺序

转换按模板中出现的顺序评估。**第一个匹配的规则胜出**。如果没有规则匹配，线程停止（终止状态：`no_matching_transition`）。

规则的 `from` 端点与最后完成的步骤匹配。只有 `from` 匹配最后步骤的智能体（和可选的阶段）的规则才会被考虑。

### 收敛示例

```json
{
  "from": "coder:implement",
  "to": "coder:review",
  "condition": {
    "type": "convergence",
    "marker": "[IMPLEMENTATION COMPLETE]",
    "maxIterations": 5
  }
}
```

这表示：`coder:implement` 运行后，检查产物是否包含 `[IMPLEMENTATION COMPLETE]`。如果包含，转换到 `coder:review`。如果不包含，循环回 `coder:implement`。如果循环 5 次没有标记，以 `max_iterations` 停止。

### 模板限制

在评估任何转换之前检查两个硬限制：

- `maxTotalSteps` — 如果线程已达到这么多的总步骤数，以 `max_iterations` 停止
- `maxTotalCostUsd` — 如果累计费用超过此值，以 `cost_limit` 停止

## 线程生命周期

### 状态

线程在其生命周期中经历这些状态：

```
running → completed   （所有步骤成功完成）
running → failed      （不可恢复的错误）
running → cancelled   （用户通过 !cancel 或按钮取消）
running → aborted     （智能体通过 thread_abort 工具自行中止）
running → waiting     （等待用户输入 — 第 6 阶段缓冲）
```

终止状态：`completed`、`failed`、`cancelled`、`aborted`。

### 智能体发起的控制（中止 / 拆分 / 等待）

线程控制是带外（out-of-band）的：智能体通过调用 `thread_abort`、`thread_split`、`thread_wait` MCP 工具来控制自己的线程，而不是向产物写入标记（在产物里提及这些关键字不会触发任何动作）。工具会在该智能体自己的线程上写入结构化的 `metadata.pendingControl`；runner 在每步完成后读取它，**优先级高于所有转换规则**。`thread_abort({ kind, diagnosis })` 立即将线程终止为 `aborted`（`onEnd` 钩子仍会触发）；`thread_split({ subtasks })` 提议对所属派发任务做分解；`thread_wait` 挂起直到被等待的子项完成。

### 挂起与唤醒（thread_wait）

挂起中的 manager 等待它的子任务（以及子线程）。调用 `thread_wait` 时若不传 `on_tasks` 和 `on_threads`，系统会自动推断所有仍存活且已关联的子项。只要传入其中任一参数，就会切换到显式覆盖模式：系统仅等待参数数组中列出的 ID，未传的另一类按空数组处理。显式 ID 必须指向仍存活且已关联的子项；重复、缺失、无关和已终止的 ID 会被忽略。因此，传入空数组时没有需要等待的子项，线程会继续执行。

每个完成或被阻塞的子项都会作为结果/升级通知投递进 manager 的 `pendingMessages`；当没有剩余等待项时，manager 被重新进入。投递由事件驱动（`task.completed` / `task.blocked`，投递前会对照 `TASKS.yaml` 验证），并有两张安全网：周期性的磁盘对账扫描（每 60 秒一次，可通过 [`config/settings.json`](./configuration.md#configsettingsjson) 中的 `waitingSweepMs` 键配置；旧变量 `CORTEX_WAITING_SWEEP_MS` 仍作为已弃用的回退被读取），逐个核对每个等待中 manager 的磁盘任务状态；以及启动恢复流程，补投服务器停机期间转为终态的结果。未完成的子任务跨重启存续、继续被等待。

任务被阻塞不会级联到依赖它的任务，因此等待集可能进入这样的状态：每个剩余等待项都（直接或传递地）依赖某个被阻塞的任务，永远无法开始。唤醒路径会检测这种停滞，并用一条死锁通知唤醒 manager，通知中列出被卡住的任务及其阻塞源；manager 应当解除阻塞、重新规划分解，或通过 `thread_abort` 升级。每种不同的停滞状态只唤醒 manager 一次——停滞状态不变则不会重复唤醒。

### thread_wait 检查点门禁（DR-0017）

manager 通过 `thread_wait` 挂起之前，必须为它（可能被轮换过的）下一个化身留下一份新鲜的检查点。runner 通过**检查点门禁**强制这一点：

- 调用 `thread_wait` 时，门禁将产物的**当前内容哈希**与**当前步骤开始时**记录的哈希比对。若产物自步骤开始以来**未改变**，`thread_wait` 被**拒绝**；若**已改变**，则允许挂起。
- 比对用的是**内容哈希，而非 mtime**——单纯 `touch` 无法绕过它。
- 基线哈希在线程创建时记录（初始/继承的产物状态），并在每一步结束时再次记录，因此门禁既覆盖第一步，也覆盖每一次重新进入。
- **豁免**：`thread_abort` 和 `thread_split` 豁免——升级永远不能被阻断。门禁只作用于持有 `artifactPath` 的线程，并在没有记录基线时**故障放行（fail open）**。

manager 写入的检查点始终覆盖四个部分：**当前委托及其验收标准**、**已做决策**（追加式日志）、**剩余计划**和**假设**。

当门禁拒绝挂起时，返回：

> `checkpoint gate (DR-0017): your artifact has not been updated during this step. Before suspending, write your checkpoint into the artifact — current delegations & their acceptance criteria, decisions made, remaining plan, assumptions — then call thread_wait again.`

### 执行循环

`runner.ts` 中的主执行循环运行如下：

1. **onStart 钩子**：在第一步之前触发（先模板钩子，然后是调用者的 extraHooks）
2. **循环**：
   a. 解析下一步（哪个智能体、哪个阶段）
   b. 构建步骤配置（提示、会话、配置、执行注册表条目）
   c. 设置流式回调（助手消息聚合、工具追踪）
   d. 执行智能体（生成 LLM 进程，等待结果）
   e. 记录步骤结果（持久化到线程存储、注册会话、完成执行）
   f. 读取控制工具写入的 metadata.pendingControl（中止 / 拆分 / 等待）
   g. 评估转换（第一个匹配的规则胜出，或停止）
   h. **onTransition 钩子**：步骤之间触发（如果正在转换）
3. **onEnd 钩子**：主循环完成后触发
4. 将线程标记为已完成（如果仍在运行）

## 生命周期钩子

钩子是在线程生命周期的特定点执行的 shell 命令。它们通过 stdin 接收 JSON 格式的上下文，并可以通过 stdout 返回 JSON 格式的指令。线程钩子是三个钩子子系统之一——完整的钩子架构（包括智能体级和会话级钩子）参见 [hooks.md](./hooks.md)。

### 钩子点

| 钩子 | 触发时机 | 上下文 |
|------|--------------|---------|
| `onStart` | 第一个智能体步骤之前 | `{ threadId, templateName, phase: "start", steps: [], activeAgent, artifactContent, userMessage, totalCostUsd }` |
| `onTransition` | 每次转换之后，下一个步骤之前 | 同上，加上标识刚完成的智能体的 `previousAgent` |
| `onEnd` | 所有步骤完成后，线程被标记为完成之前 | 同上，包含最终产物内容和已完成的步骤 |

### 钩子配置

```json
{
  "onEnd": {
    "command": "node hooks/post-task-hook.mjs",
    "args": ["--project", "nimbus"],
    "timeout": 30000
  }
}
```

- `command` — 完整的 shell 调用（必须包括解释器：`node ...`、`bash ...` 等）
- `args` — 通过 `sh -c 'cmd "$@"'` 作为 `$1`、`$2`、...传递的位置参数
- `timeout` — 执行超时（毫秒，默认：30000）

### 钩子返回值

钩子通过 stdout 返回 JSON 来控制接下来发生的事情：

**插入临时智能体：**
```json
{
  "insertAgent": true,
  "prompt": "运行任务后清理：验证所有测试通过",
  "profile": "claude-haiku",
  "directive": "你是一个清理智能体"
}
```
这会创建一个新的临时智能体，运行给定的提示，然后线程继续正常进行。

**针对已有智能体的会话：**
```json
{
  "targetAgent": "reviewer",
  "prompt": "根据原始要求再次检查产物中的结果"
}
```
这会将提示发送到 `reviewer` 智能体的持久会话（如果进程仍然存活则通过 stdin，如果已死则通过 `--resume`）。`targetAgent` 优先于 `insertAgent`。

### 钩子执行顺序

模板钩子先触发，然后是调用者的 `extraHooks`（由调度器/分发器注入）在同一阶段。两者使用相同的执行语义。ExtraHooks 不会持久化到 ThreadRecord——它们仅对当前的 `runThread()` 调用有效。

## 工作区和产物

每个线程在文件系统上获得一个隔离的工作区：

```
tmp/threads/thr_a1b2c3d4/
├── artifact.md        # 共享产物——智能体读和写此文件
└── ...                # 智能体创建的任何其他文件
```

产物路径对所有智能体通过 `{{artifactPath}}` 模板变量可用。智能体通过读取之前智能体写入的内容并追加自己的发现来进行通信。

智能体还可以识别之前智能体修改的文件：
- `{{previousOutput}}` — 上一个已完成步骤的完整输出
- `{{modifiedFiles}}` — 上一个智能体编辑的文件列表（从只记录路径的会话活动日志中提取）

### 任务定址的 manager 产物（DR-0017）

大多数线程把产物放在上文所示的**临时线程工作区**（`tmp/threads/{threadId}/artifact.md`），按线程 id 定址，并在线程清理时被删除。**manager 线程**不同：它拥有一个复合任务节点，其产物放在**任务定址**的路径下——按所属任务 id 定址，而非线程 id：

```
context/projects/{project}/manager/{taskId}/artifact.md
```

该产物是**持久的**。它能在线程清理、服务器重启以及 manager 替换/轮换后存活，并随 context 仓库进行 git 版本管理（每次检查点都累积版本历史）——与临时的 `tmp/threads/{threadId}/artifact.md` 工作区形成对比，后者在线程清理时被丢弃。它在派发时即被设定——manager 线程的 `artifactPath` 指向这个任务定址路径——因此 `{{artifactPath}}`、产物读取以及**thread_wait 检查点门禁**（见上文）全都无缝地作用于它，工作区清理永远不会触及它。

它的角色是**再水化（rehydration）记忆**：一个新鲜的 manager 化身（在轮换或崩溃之后）从此文件继承上一个化身的检查点，因此 manager 应当把它写得让一个陌生人仅凭此文件就能继续这个任务。manager 节点概念及其验收台账记录在 [tasks.md](./tasks.md) 中。

## 线程命令

### 启动线程

```
!thread coder-review 为 API 实现用户认证
!thread researcher 调研触觉感知的最新论文
```

`!thread` 后的第一个词是模板名称（或单智能体执行的智能体名称）。其余是传递给第一个智能体的用户消息。

### 添加智能体

```
!thread add reviewer
!thread add critic 请关注安全影响
```

这会向已有线程动态添加一个智能体。线程必须已完成或等待中（不是当前正在运行）。如果线程是 auto-record（没有文件系统工作区），则延迟创建工作区。

### 其他线程命令

| 命令 | 描述 |
|---------|-------------|
| `!thread list` | 列出活跃线程 |
| `!thread status [id]` | 显示线程状态和步骤 |
| `!thread cancel [id]` | 取消运行中的线程 |
| `!thread agents` | 列出可用智能体 |
| `!thread templates` | 列出可用模板 |

## 线程类型

Cortex 内部使用三种类型的线程记录：

| 类型 | templateName | 工作区 | 使用场景 |
|------|-------------|-----------|---------|
| **模板线程** | 实际模板名称 | 是 | `!thread <template>`、任务调度 |
| **默认线程** | `"default"` | 是 | 单智能体消息（正常聊天路径） |
| **自动线程** | `null` | 否（初始） | 从单智能体运行链接的 `!thread add` |

区别很重要，因为运行器对默认线程的处理不同：它们只运行一个步骤（无转换），使用频道的已有会话，并将流式输出直接转发给用户。

## 线程记录

每个线程的完整状态作为 `ThreadRecord` 持久化在 `~/.cortex/data/threads.json` 中：

| 字段 | 描述 |
|-------|-------------|
| `id` | 线程 ID（`thr_<8 位十六进制>`） |
| `status` | 当前生命周期状态 |
| `channel` | Slack 频道 ID |
| `templateName` | 使用的模板（ad-hoc 为 null） |
| `userMessage` | 原始用户消息 |
| `workspacePath` / `artifactPath` | 共享产物的文件路径 |
| `agents` | 智能体槽位映射及其状态（sessionId、status、persistSession） |
| `activeAgent` / `activeStage` | 下一个运行的智能体和阶段 |
| `steps[]` | 每步记录的执行历史（agent、stage、cost、duration、output） |
| `iterationCounts` | 按转换边追踪收敛循环计数 |
| `totalCostUsd` | 所有步骤的累计费用 |
| `metadata` | 调用者提供的上下文：scheduleTaskId、trigger、project、pendingMessages |
| `abortReason` | 智能体自行中止时的原因 |

旧线程在启动时清理：7 天前的线程被移除（无工作区的 auto-records 为 24 小时）。

## 提示变量

智能体提示支持在运行时解析的模板变量：

| 变量 | 描述 |
|----------|-------------|
| `{{input}}` | 用户消息（对于第一步）或前一个智能体的输出 |
| `{{artifactPath}}` | `artifact.md` 的绝对路径 |
| `{{previousOutput}}` | 上一个已完成步骤的完整输出 |
| `{{modifiedFiles}}` | 上一个智能体编辑的文件 |
| `{{currentDateTime}}` | ISO 格式的当前日期和时间 |

## 插件加载

每个智能体定义通过 `pluginDirs` 指定要加载的插件目录。插件相对于 `DATA_DIR`（默认：`~/.cortex/`）解析。例如，`plugins/cortex-coder` 解析为 `~/.cortex/plugins/cortex-coder/`。

插件目录作为 `--plugin-dir` 标志（Claude Code）或 `--skill` 标志（PI）传递给 LLM 后端。后端然后扫描 `SKILL.md` 文件并将其作为可调用技能提供。完整的技能和插件系统参见 [skills-and-plugins.md](./skills-and-plugins.md)。

## Manager 会话轮换与再水化（DR-0017）

manager 线程是长生命周期的：随着子项运行，它跨越多次唤醒累积上下文。为保持上下文清洁，DR-0017 会周期性地**轮换 manager 的 LLM 会话**，依赖持久的**任务定址 manager 产物**（见上文）及其验收台账（见 [tasks.md](./tasks.md)）来跨越边界携带状态。

- **触发**：在恢复的收窄点检查，就在重新进入一个被挂起的 manager 之前。当 `steps.length - rotationBaseStepIndex >= managerRotateSteps`（[`config/settings.json`](./configuration.md#configsettingsjson) 中的 `managerRotateSteps` 键，**默认 10**；旧变量 `CORTEX_MANAGER_ROTATE_STEPS` 仍作为已弃用的回退被读取）时，会话被轮换。只有 **manager（任务产物）模板**会轮换——普通线程从不轮换。
- **轮换动作**：清空每个智能体槽位的 `sessionId`（这样下一步在一个**全新的 LLM 会话**上运行，会自然地重新注入完整的 manager 指令和原始任务契约提示），把 `rotationBaseStepIndex` 重置为当前步骤计数，并为新鲜化身入队一条**再水化通知**。
- **再水化通知**：它指示新鲜化身：(1) **先读自己的产物**——该文件保存着前任的检查点；(2) **对账任务树**（例如 `cortex-task tree --task-id <id>`）；(3) **验证台账中待处理的交付**——仍在等待本 manager 裁决的子项结果，必须逐一按其 `done-when` 核验后才可信任。它还告诉化身**不要**重做已完成的工作或重新争论已记录的决策，而是从剩余计划继续。
- 轮换是一次**刻意的击杀测试**：它与灾难/崩溃恢复同构——新鲜化身纯粹从持久状态再水化。它**故障放行**：轮换失败是非致命的（恢复在旧会话上继续），且非 manager 线程从不轮换。

## 线程清理

当线程完成、失败或被取消时：

- 智能体句柄从 `RunningExecutions` 中移除
- 线程特定会话（按键为 `thr:<threadId>:`）被关闭
- 线程存储刷新到磁盘

在服务器启动时，任何留在 `running` 状态的线程都被标记为 `failed` 以防止陈旧状态。
