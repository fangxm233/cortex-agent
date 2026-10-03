# Cortex 调度系统 {#cortex-scheduling-system}


调度系统让你设置周期性或一次性的智能体调用。调度持久化到磁盘，在重启后存活，并在外部更改时热重载。每次触发都会新开一个会话来运行调度的提示。Provider 用量采集和记忆索引重建等 daemon 基础设施循环由下文的内置作业控制器运行，不保存为调度记录。

!!! tip "在等某件事结束？别用调度去轮询"
    只为检查任务是否完成而触发的调度，每次都要花掉一整轮 agent，而其中几乎每一轮
    都只会发现「还没完」。改用 [waitpoint](./waitpoints.md)：任务结束时自己回报，
    session 恰好被唤醒一次。调度用于该按时钟发生的事，而不是用来盯着别的东西。

## 调度类型 {#schedule-types}

支持四种触发类型：

| 类型 | 描述 | 关键参数 | 示例 |
|------|-------------|---------------|---------|
| `interval` | 每 N 个时间单位触发 | `interval`（如 `"5m"`、`"1h"`、`"30s"`） | 每 5 分钟运行一次状态检查 |
| `daily` | 每天在特定时间触发 | `time`（`HH:MM` 24 小时格式） | 每天 09:00 运行每日摘要 |
| `weekly` | 在一周的特定日期和时间触发 | `dayOfWeek`（0-6，0=周日）、`time` | 每周一 21:00 运行周回顾 |
| `once` | 延迟后触发一次 | `delay`（持续时间字符串或毫秒） | 2 小时后发送提醒 |

持续时间字符串遵循 `<number><unit>` 格式，其中 unit 是 `s`（秒）、`m`（分钟）、`h`（小时）或 `d`（天）。示例：`"30s"`、`"5m"`、`"2h"`、`"1d"`。

## 调度记录 {#schedule-records}

每个调度作为 JSON 对象存储在 `~/.cortex/data/schedules.json` 中：

```json
{
  "tasks": [
    {
      "id": "d6f1bb1e",
      "type": "interval",
      "message": "检查活跃项目并报告阻塞项",
      "projectId": "general",
      "profile": "claude-haiku",
      "intervalMs": 3600000,
      "createdAt": 1747680000000,
      "nextRun": 1747683600000,
      "lastRun": 1747680000000,
      "target": { "kind": "fresh" }
    }
  ]
}
```

### ScheduleTask 字段 {#scheduletask-fields}

| 字段 | 描述 |
|-------|-------------|
| `id` | 8 字符十六进制标识符（自动生成） |
| `type` | `interval`、`daily`、`weekly` 或 `once` |
| `message` | 调度触发时发送的提示（触发时自动添加 `[Scheduled Task]` 前缀） |
| `projectId` | 调度所属的项目；每次触发的会话都在这个项目中打开 |
| `profile` | 智能体配置名称（默认为活动配置） |
| `intervalMs` | 对于 `interval` 类型：触发之间的毫秒数 |
| `time` | 对于 `daily`/`weekly` 类型：`HH:MM` 24 小时时间 |
| `dayOfWeek` | 对于 `weekly` 类型：0-6（0=周日） |
| `runAt` | 对于 `once` 类型：触发时的纪元毫秒数 |
| `nextRun` | 下一次调度触发的计算纪元毫秒数 |
| `createdAt` | 调度创建时的纪元毫秒数 |
| `lastRun` | 上次成功触发的纪元毫秒数 |
| `lastSkipped` | 上次跳过触发的纪元毫秒数（preCheck 失败） |
| `isPaused` | 调度当前是否暂停 |
| `pausedAt` | 暂停时的纪元毫秒数 |
| `pausedBy` | `"user"` 或 `"rate-limit"`——谁暂停了它 |
| `dispatchType` | 保留的内部处理器键；普通用户调度不填写 |
| `preCheck` | 可选的 shell 命令；非零退出 → 跳过此次触发 |
| `target` | 调度的项目是如何选定的（见[触发后到哪里运行](#where-a-fire-lands)） |

## 内置周期作业 {#built-in-periodic-jobs}

Provider 用量采集和记忆索引重建是 daemon 内置作业。它们不会出现在 `schedules.json`、`!schedule list`、调度 CLI 或 Web 调度列表中。开关与间隔可在 **设置 → 高级 → 内置任务** 中配置，也可使用 `config/settings.json` 中的两组键：`providerUsageCollectionEnabled` / `providerUsageCollectionIntervalMs`、`memoryIndexRegenEnabled` / `memoryIndexRegenIntervalMs`。

启用的作业会在 daemon 启动时执行一次。设置热更新生效：禁用会清除下一次计时器，启用会立即执行，修改间隔会重排下一次空闲运行。默认值和取值范围见 [configuration.md](./configuration.md#configsettingsjson)。

## 触发后到哪里运行 {#where-a-fire-lands}

每次触发都会新开一个普通会话——与你在 Web UI 或桌面端新建的会话相同——并把调度的消息加上
`[Scheduled Task]` 前缀作为它的第一轮发送。这个会话被记为该调度的一次运行，并以消息开头作为
标题；打开它即可查看结果，也可以像其他对话一样回复。触发从不复用之前运行的会话，因此周期性
调度的每次运行各有独立的记录。

`target` 字段只决定调度属于哪个项目，并在创建调度时确定：

| 目标 | 行为 |
|------|------|
| `fresh` | 默认。项目取自 `projectId`，否则取创建所在频道登记的项目，再否则为 `general` |
| `current-project` | 简写，在创建时解析为创建该调度的对话所在的项目 |

存储形式总是显式对象：

```json
{ "kind": "fresh" }
{ "kind": "project", "projectId": "my-project" }
```

其他种类的已存储目标一律按 `fresh` 读取。

## PreCheck

`preCheck` 字段是一个可选的 shell 命令，作为门控：如果命令以非零状态退出，该周期的调度触发被**跳过**。调度被重新安排为其正常的下一个间隔——没有快速重试。

命令通过 `execSync` 运行，15 秒超时。它接收 `PRECHECK_LAST_RUN` 环境变量（任务 `lastRun` 字段的纪元毫秒数）。工作目录是 `DATA_DIR`（`~/.cortex/`）。

**preCheck 的使用场景：**

- 运行前检查必需文件是否存在：`test -f ~/.cortex/data/schedules.json`
- 检查进程是否在运行：`pgrep -f "python train.py"`
- 检查系统负载：`[ $(cat /proc/loadavg | cut -d' ' -f1 | cut -d. -f1) -lt 8 ]`

## 热重载 {#hot-reload}

调度器通过 `fs.watch` 监视 `schedules.json` 的外部更改。当检测到更改时（300ms 去抖后），它：

1. 使内存缓存失效
2. 从磁盘读取新文件
3. 将文件任务 ID 与内存定时器 ID 对比
4. **移除**不再在文件中的任务的定时器
5. **添加**新任务的定时器
6. **更新**调度配置更改的任务的定时器（通过配置哈希比较检测）
7. 向 Slack 发送管理通知：`:arrows_counterclockwise: schedules.json hot-reloaded: +N -M ~P task(s)`

**自写入守卫：** 当调度器自身写入 `schedules.json`（通过 `add`、`remove`、`pause` 等）时，它设置一个 `_selfWriting` 标志持续 100ms。文件监视器在这段时间内忽略更改以避免冗余的热重载。

### 用于变更检测的配置哈希 {#config-hash-for-change-detection}

每个任务的调度相关字段被哈希：`type`、类型特定键（intervalMs/time/dayOfWeek）、message、channel、profile、dispatchType、preCheck。如果文件中任务的哈希与内存哈希不同，定时器被重新武装。这意味着对任何调度字段的编辑都会触发自动重新安排。

## 进行中保护 {#in-flight-protection}

如果调度触发时它的上一次运行仍在进行，这次触发会被跳过。这防止了同一调度的运行相互重叠。

## 暂停和恢复 {#pause-and-resume}

### 暂停 {#pausing}

类型为 `interval`、`daily` 和 `weekly` 的调度可以被暂停。Once 类型的调度不能被暂停（它们要么触发要么被丢弃）。

暂停时：
- `isPaused` 设置为 `true`，`pausedAt` 记录时间戳，`pausedBy` 记录 `"user"` 或 `"rate-limit"`
- `nextRun` 设置为 `null`
- 内存定时器被清除且不重新武装

`pausedBy` 字段区分用户发起的暂停和自动速率限制暂停。速率限制自动恢复路径仅考虑 `pausedBy: "rate-limit"` 的任务。

### 恢复 {#resuming}

恢复时：
- `isPaused` 设置为 `false`，`pausedAt` 和 `pausedBy` 被清除
- `nextRun` 基于调度类型重新计算（对于 `interval`：`now + intervalMs`；对于 `daily`/`weekly`：下一个出现时间）
- 定时器重新武装

### 移除 {#removing}

调度可以按 ID 删除（幂等——移除不存在的调度返回 `{ removed: false }`）。定时器被清除，条目从 `schedules.json` 中移除。

## 启动行为 {#startup-behavior}

服务器启动时，调度器：

1. 丢弃逾期超过 1 分钟的 `once` 任务（超过其 `runAt`）
2. 安排所有剩余任务及其计算的 `nextRun` 时间
3. 启动用于热重载的文件监视器
4. 记录总任务数

## MCP 工具 {#mcp-tools}

调度可以通过 MCP 工具管理（由智能体在 Slack 对话中使用）：

| 工具 | 描述 |
|------|-------------|
| `cortex_schedule_add` | 创建新调度。接受 `type`、`message`、`interval`/`time`/`dayOfWeek`/`delay`、`target`、`profile`、`preCheck`、`channel`、`projectId` |
| `cortex_schedule_list` | 列出所有调度（默认：50） |
| `cortex_schedule_get` | 按 ID 获取调度 |
| `cortex_schedule_remove` | 按 ID 删除调度（幂等） |
| `cortex_schedule_pause` | 暂停周期性调度 |
| `cortex_schedule_resume` | 恢复暂停的调度 |

`cortex_context` MCP 工具返回当前执行上下文（sessionId、sessionName、profile、project、backend）；`cortex_schedule_add` 按同一上下文解析 `current-project`。

### 通过 MCP 创建调度 {#creating-a-schedule-via-mcp}

```json
{
  "type": "interval",
  "message": "检查 GPU 状态并报告",
  "interval": "10m",
  "target": "current-project"
}
```

```json
{
  "type": "daily",
  "message": "运行早晨的研究扫描",
  "time": "08:00",
  "profile": "claude-sonnet"
}
```

## Slack 命令 {#slack-commands}

`!schedule` Slack 命令提供交互式调度管理。底层 CLI 工具参见 [cli-reference.md](./cli-reference.md)。

| 命令 | 描述 |
|---------|-------------|
| `!schedule list` | 列出所有调度及其状态、下次运行时间和类型 |
| `!schedule add <type> <message>` | 交互式添加新调度 |
| `!schedule remove <id>` | 移除调度 |
| `!schedule pause <id>` | 暂停调度 |
| `!schedule resume <id>` | 恢复暂停的调度 |

## 执行路由 {#execution-routing}

普通调度记录使用 `scheduled-task` runner：每次触发新开一个会话，并发送带有 `[Scheduled Task]` 前缀的消息。少量随产品提供的调度可使用保留的内部处理器键；未注册的 `dispatchType` 会被跳过，不会被解释成 agent prompt。daemon 周期基础设施由 `builtin-jobs.ts` 运行，不经过调度持久化。

## 速率限制集成 {#rate-limit-integration}

调度器与 Cortex 的速率限制节流集成：

- `beforeRunGuard` 回调可以在系统被限速时阻止触发
- 调度可以被速率限制系统自动暂停（`pausedBy: "rate-limit"`）
- 节流状态（`resetsAt`、`activatedAt`、受影响的模式）与任务一起存储在 `schedules.json` 中
- 启动时，之前被速率限制暂停的任务被评估以自动恢复
