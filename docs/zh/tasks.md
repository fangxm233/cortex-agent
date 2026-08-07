# Cortex 任务系统 {#cortex-task-system}


任务系统是 Cortex 的结构化工作队列。任务存储在 `TASKS.yaml` 文件中——每个项目一个——并通过 `cortex-task` CLI 管理。系统支持将任务分发给队列工作器、追踪远程机器上的执行情况以及归档已完成的工作。

## TASKS.yaml 格式 {#tasksyaml-format}

每个项目的 `TASKS.yaml` 包含一个扁平的任务列表。每个任务有以下字段：

| 字段 | 类型 | 必需 | 描述 |
|-------|------|----------|-------------|
| `id` | string（4 个十六进制字符） | 是 | 项目内唯一任务标识符（如 `f7cf`、`6a07`） |
| `text` | string | 是 | 动词开头的任务描述 |
| `why` | string | 是 | 理由——为什么这个任务重要 |
| `done-when` | string | 是 | 可验证的完成标准 |
| `priority` | `high` \| `medium` \| `low` | 是 | 任务优先级 |
| `status` | `open` \| `done` \| `pending` | 是 | 核心状态（仅存储这 3 种；派生状态是计算得出的） |
| `template` | string | 是 | 分发时使用的线程模板名称（如 `coder-review`） |
| `plan` | string | 否 | 设计文档的路径 |
| `depends-on` | string[] | 否 | 此任务依赖的任务 ID 列表 |
| `gpu` | string \| null | 否 | 目标机器名称（如 `lab2`） |
| `gpu-count` | number | 否 | 所需 GPU 数量（默认：1） |
| `blocked-by` | string \| null | 否 | 外部阻塞原因（自由文本） |
| `claimed-by` | string \| null | 否 | 认领此任务的智能体标识符 |
| `claimed-at` | string \| null | 否 | 认领的 ISO 时间戳 |
| `paused` | boolean | 否 | 任务是否已暂停 |
| `approval-needed` | boolean | 否 | 分发前是否需要审批 |
| `approved-at` | string \| null | 否 | 审批的 ISO 时间戳 |
| `not-before` | string \| null | 否 | 日期门控：在此 ISO 日期之前不分发 |
| `completed-at` | string \| null | 否 | 完成的 ISO 时间戳 |
| `completed-note` | string \| null | 否 | 完成时添加的备注 |
| `pending-at` | string \| null | 否 | 标记为 pending 时的 ISO 时间戳（cortex-run） |

YAML 键使用 kebab-case（`done-when`、`depends-on`、`claimed-by` 等），内部映射为 snake_case 字段。

### 任务示例 {#example-tasks}

```yaml
- id: f7cf
  text: "用统一的 adapter.runWithAdapter 替换后端分发"
  why: "重复的后端分发路径会增加维护负担"
  done-when: "mode-manager.ts 对两个后端使用 runWithAdapter；fixture 回放测试通过"
  priority: high
  status: open
  template: coder-review
  plan: decisions/0002-unified-backend-dispatch.md

- id: 5349
  text: "完整管道集成测试"
  why: "各阶段单独通过但端到端尚未验证"
  done-when: "完整管道运行（prompt → VLA → dataset）完成，生成阶段成功率 >=80%"
  priority: high
  status: open
  template: experiment-runner
  gpu: lab2
  gpu-count: 1
```

### 项目锁 {#project-lock}

`TASKS.yaml` 可以可选地包含一个防止并发修改的 `lock` 部分：

```yaml
lock:
  owner: "exec_local_abc"
  acquired_at: "2026-04-23T12:00:00.000Z"
  expires_at: "2026-04-23T12:20:00.000Z"
  note: "重构任务"
```

锁有固定的 20 分钟 TTL。修改任务列表的命令（`add`、`edit`、`batch-edit`、`decompose`）要求调用者持有锁。当拥有的执行完成时，锁会自动释放。

## 任务生命周期 {#task-lifecycle}

### 核心状态（存储的） {#core-states-stored}

任务有三个存储在 YAML 中的核心状态：

- **`open`** — 可被认领
- **`done`** — 已完成（终止状态）
- **`pending`** — 已分发到远程机器，等待 cortex-run 完成

### 派生状态（计算得出的） {#derived-states-computed}

附加状态从布尔标志计算得出：

| 条件 | 派生状态 |
|-----------|---------------|
| `claimed_by` 已设置 | `in-progress` |
| `blocked_by` 已设置 | `blocked` |
| `paused` 为 true | `paused` |
| `approval_needed` 为 true 且 `approved_at` 为 null | `approval-needed` |
| `approved_at` 已设置 | `approved`（可被分发） |

### 状态转换 {#state-transitions}

```
open ──claim──→ in-progress ──complete──→ done
 │                  │
 ├──block──→ blocked ├──unclaim──→ open
 │    │               │
 │    └──unblock──→ open
 │
 ├──pause──→ paused ──resume──→ open（清除认领）
 │
 ├──request-approval──→ approval-needed ──approve──→ open（approved_at 已设置）
 │
 └──pending──→ pending ──(cortex-run 结果)──→ done / open+blocked
                  │
                  └──reopen──→ open
```

**守卫规则：**

- 不能认领已被认领的任务（409 错误）
- 不能认领已阻塞或已完成的任务
- 不能完成已阻塞或已暂停的任务
- 设置 `blocked_by` 自动清除 `claimed_by`、`claimed_at` 和 `pending_at`，并把 `pending` 状态归一回 `open`（这样解阻后任务可重新派发——阻塞期间真正拦截派发的是 `blocked_by` 而非状态）
- 暂停任务清除 `claimed_by` 和 `claimed_at`
- `pending` 清除 `claimed_by` 和 `blocked_by`，设置 `pending_at`
- `unblock` 清除 `blocked_by`，并把遗留的 `pending` 状态还原为 `open`
- `reopen` 把卡住的 `pending` 任务还原为 `open`（cortex-run 回调丢失时的挽救路径）；拒绝 `done` 任务

## Done-When 纪律 {#done-when-discipline}

`done-when` 字段是任务中最重要的字段。它必须描述**可验证的完成标准**，而不是模糊的意图。

**好例子：**

- `"mode-manager.ts:310-311 替换为 runWithAdapter；两个后端通过同一函数路由；fixture 回放测试通过"`
- `"完整管道运行完成，生成阶段成功率 >=80%"`
- `"docs/architecture.md 存在，所有六层已记录并对照实际代码验证"`

**坏例子（太模糊）：**

- `"修复 bug"`
- `"提高性能"`
- `"写文档"`

### 完成验证 {#completion-verification}

当通过 `cortex-task complete` 将任务标记为完成时，系统运行自动验证（`verifyCompletionEvidence`）：

1. **Git 日志检查**：运行 `git log --oneline --grep=<taskId>` 查找引用任务 ID 的提交。必须存在至少一个不是认领/取消认领提交的提交。
2. **产物检查**：如果 git 检查失败，检查 `done-when` 文本中提到的任何文件路径是否存在于数据目录中。

如果两项检查都不通过，命令返回错误：`"no evidence of work: no matching git commit and no Done-when artifact found in repo"`。用户可以通过 `--skip-verify` 绕过（可选地附带 `--skip-verify-reason`）。

## Blocked-By 语义 {#blocked-by-semantics}

`blocked_by` 字段用于**仅外部阻塞**——无法通过编写代码或配置工具来解决的事情。有效阻塞的例子：等待 GPU 分配、等待数据集交付、等待 API 访问审批。

将任务设置为 blocked 会自动取消认领。不能完成被阻塞的任务——必须先解除阻塞。

### 自动阻塞隔离 {#auto-block-quarantine}

任务调度系统有一个自动隔离机制：如果一个已分发的任务连续失败 3 次，任务会自动被阻塞，`blocked_by` 中填入最后的错误消息。这防止调度器重复尝试一个损坏的任务。

## 陈旧认领检测 {#stale-claim-detection}

服务器启动时会对照认领的归属方做一次核对。被 `task-dispatcher` 认领、但其执行没有跨过重启存活下来的任务会被自动取消认领，回到分发队列。有存活归属方的认领会被保留：等待子项的挂起 manager 线程、等待自动恢复的限流暂停线程、以及由 pending 任务追踪器追踪的远程 `cortex-run`，它们都合法地跨重启持有认领。手动认领（`claimed_by` 不是 `task-dispatcher` 的任何值）永远不会被触碰。

3 天规则：如果一个任务被智能体 `claimed_by` 超过 3 天而没有完成，它被视为陈旧/孤立认领，应进行调查。这个手动约定覆盖自动核对刻意保留的那些认领（例如手动认领）。

另外，pending 任务追踪器对远程机器上已分发的任务有 4 小时超时——如果已分发的任务在 4 小时内没有回报，其追踪状态被清除。

## 任务分发 {#task-dispatch}

分发管道是任务如何自动执行的机制。

### 触发 {#trigger}

内置任务派发器会周期性检查任务队列（默认每 30 秒）。该循环由 `config/settings.json` 中的 `taskDispatchEnabled` 和 `taskDispatchIntervalMs` 控制。

### 分发流程 {#dispatch-flow}

1. **预演选择**：找到一个可以分发的任务（尚未认领）
2. **速率限制检查**：确保系统未被限速
3. **选择并认领**：`selectAndClaimTask()` 选择最高优先级的可操作任务
4. **GPU 检查**：如果任务需要 GPU，验证目标机器在线且有空闲 GPU
5. **去重**：如果类似任务已在运行则跳过（通过执行注册表检查）
6. **线程创建**：从任务的模板创建线程，带项目上下文运行（线程执行模型参见 [threads.md](./threads.md)）
7. **任务完成**：线程成功时自动完成任务。失败时递增失败计数器（3 次连续失败 → 自动阻塞）

### 选择优先级 {#selection-priority}

任务按以下顺序选择：

1. 高优先级项目的任务优先
2. 有 `done-when` 字段的任务优先于没有的
3. 更高 `priority` 值的任务优先（`high` > `medium` > `low`）

### Pending 任务 {#pending-tasks}

当任务被分发到远程机器进行长时间运行（通过 `cortex-run`）时，它被标记为 `pending`。远程机器的 `cortex-run-watcher` 追踪进程并通过 WebSocket `task-callback` 消息回报成功/失败。服务器随后相应地完成或阻塞任务。

## Cortex-Run 看门狗（DR-0011） {#cortex-run-watchdog-dr-0011}

`cortex-run` 系统处理远程机器上的长时间运行任务执行。完整的 `cortex-run` CLI 参考参见 [cli-reference.md](./cli-reference.md)，内置任务派发器的配置见 [scheduling.md](./scheduling.md)。

- **服务器端**：`cortex-run` CLI 通过 `sendCommand` 转发到远程客户端
- **客户端端**：`cortex-run-watcher.ts` 将用户命令作为分离的子进程生成，用两层停滞检测（输出字节停滞和进度行停滞）监控它，通过 `nvidia-smi` 自动选择 GPU，写入状态/输出/结果文件，并在完成时发送 `task-callback` WebSocket 消息
- **客户端端**：`cortex-run-launch.ts` 处理启动/取消/刷新周期，带僵尸进程的孤立检测

三层进程模型：

```
cortex-client（到服务器的 WebSocket 连接）
  └── cortex-run-watcher（分离的，unref'd）
        └── 用户命令（如 python train.py）
```

## 任务归档 {#task-archive}

已完成的任务在 3 天后自动归档（`ARCHIVE_AGE_DAYS = 3`）。内置归档器默认每 6 小时运行一次，由 `config/settings.json` 中的 `taskArchiveEnabled` 和 `taskArchiveIntervalMs` 控制。

**归档流程：**

1. 扫描 `context/projects/` 中的所有项目
2. 找到 `status: done` 且 `completed-at` 超过 3 天的任务
3. 从 `TASKS.yaml` 中移除它们
4. 以 markdown 清单格式追加到 `tasks-archive.md`，包含 text、id、why、done-when、priority、完成日期和备注
5. 自动提交，消息为：`auto-archive: completed tasks (<project>: <N> tasks)`

没有 `completed-at` 日期的任务永远不会被归档。

## Cortex-Task CLI

`cortex-task` CLI 提供完整的任务生命周期管理。完整的 CLI 参考（包括每个子命令和标志）参见 [cli-reference.md](./cli-reference.md)。所有命令操作当前工作目录中的项目，或接受 `--project` 标志。

### 读取命令 {#read-commands}

| 命令 | 描述 |
|---------|-------------|
| `list` | 显示可操作任务（默认）。使用 `--all` 查看所有任务包括 done/blocked/paused |
| `query` | 按状态、优先级、文本模式或任务 ID 过滤任务 |
| `show --task-id <id>` | 显示一个任务的详细信息 |
| `deps --task-id <id>` | 显示任务的依赖图 |
| `lint` | 验证任务结构（缺失 ID、悬空依赖、循环） |
| `stats` | 每项目任务供给统计（按状态和优先级计数） |

### 状态命令 {#state-commands}

| 命令 | 描述 |
|---------|-------------|
| `claim --task-id <id>` | 将任务标记为进行中（`--agent` 默认为 `cortex-local`） |
| `unclaim --task-id <id>` | 移除进行中状态 |
| `pause --task-id <id>` | 暂停任务（清除认领） |
| `resume --task-id <id>` | 恢复暂停的任务 |
| `pending --task-id <id>` | 标记为 pending（等待 cortex-run 结果） |
| `reopen --task-id <id>` | 把卡住的 `pending` 任务还原为 `open`（挽救丢失的 cortex-run 回调） |
| `complete --task-id <id>` | 标记完成（`--note`、`--skip-verify` 绕过验证） |
| `uncomplete --task-id <id>` | 撤销已完成的任务回到 open |
| `verdict --task-id <parent> --child <id> --verdict accepted\|rejected` | 将 manager 对已交付子任务的验收裁决记录到父任务的验收账本（见 [Manager 任务与验收账本](#manager-tasks-and-the-acceptance-ledger-dr-0017)；完整语法见 [cli-reference.md](./cli-reference.md)） |

### 审批命令 {#approval-commands}

| 命令 | 描述 |
|---------|-------------|
| `request-approval --task-id <id>` | 设置 approval-needed 标志 |
| `approve --task-id <id>` | 审批（设置 approved_at，清除 approval-needed） |
| `clear-approval --task-id <id>` | 清除审批状态 |

### 阻塞命令 {#blocking-commands}

| 命令 | 描述 |
|---------|-------------|
| `block --task-id <id> --reason "..."` | 以某个原因阻塞任务 |
| `unblock --task-id <id>` | 解除阻塞任务 |

### 修改命令 {#mutation-commands}

| 命令 | 描述 |
|---------|-------------|
| `add` | 添加新任务（`--text`、`--why`、`--done-when`、`--template`、`--priority` 等） |
| `edit --task-id <id>` | 编辑任务字段 |
| `batch-edit --task-ids <id1,id2>` | 对多个任务应用相同编辑 |
| `decompose --task-id <id> --subtasks-file <path>` | 用子任务替换一个任务 |

### 锁命令 {#lock-commands}

| 命令 | 描述 |
|---------|-------------|
| `lock-acquire` | 获取项目锁（20 分钟 TTL） |
| `lock-release` | 释放项目锁 |
| `lock-status` | 显示所有或一个项目的锁状态 |
| `lock-force-release` | 强制释放项目锁 |

### 维护命令 {#maintenance-commands}

| 命令 | 描述 |
|---------|-------------|
| `assign-ids` | 自动为缺少 ID 的任务分配 4 位十六进制 ID |
| `validate` | 验证所有项目的所有任务 ID（检查重复、缺失引用） |
| `stop --task-id <id>` | 终止已分发的任务进程 |

修改命令（`add`、`edit`、`batch-edit`、`decompose`）要求调用者持有项目锁。

## 一个标准，一个任务（DR-0006） {#one-criterion-one-task-dr-0006}

每个任务应只有一个可验证的完成标准。具有多个独立标准的任务应使用 `decompose` 命令分解为子任务。这确保了清晰的分发、明确的所有权和无歧义的完成验证。

## Manager 任务与验收账本（DR-0017） {#manager-tasks-and-the-acceptance-ledger-dr-0017}

简单工作是分发给单个工作线程的叶子任务。**复合工作**——一个会分解为多个独立可验证单元、且需要协调、验收与返工的目标——则改用 **manager 任务**建模。

### Manager 任务节点 {#manager-task-node}

`template` 为 `manager` 的任务是一个**复合任务节点**，由一个常驻的 **manager 线程**拥有。manager 本身不做具体工作，它的生命周期是：

1. **分解（Decompose）**——将任务拆分为子任务（通常用 `decompose --keep-parent`，让父任务作为依赖其子任务的汇合/验收节点保留下来）。
2. **挂起（Suspend）**——调用 `thread_wait` 并在子任务运行期间休眠。
3. **验证（Verify）**——子任务完成后，对照每个子任务自己的 `done-when` 验证其交付物（先验收再信任：读文件、跑测试——绝不把子任务的自我汇报当作证据）。
4. **记录裁决（Record a verdict）**——对每个已交付的子任务给出接受或拒绝（见下方验收账本）。
5. **整合并完成（Integrate and complete）**——当每个子任务都被接受后，整合结果并完成父任务。

manager 线程的完整生命周期——其持久的按任务寻址的 artifact、`thread_wait` 检查点门、以及会话轮换/再水化——记录在 [threads.md](./threads.md)。

### 验收账本 {#acceptance-ledger}

验收账本是一份持久的、机器可读的记录，记载 manager 已收到并已裁决了哪些子任务结果。它位于：

```
context/projects/{project}/manager/{taskId}/ledger.json
```

与 manager 的按任务寻址 artifact 放在一起，以 JSON 形式同步原子写入。

**为什么存在：** 对*任务型*子任务的结果交付做**跨化身（cross-incarnation）去重**。每线程的交付记录只能在单个 manager 化身内去重；账本则跨化身（会话轮换、服务器重启、manager 替换）去重，因此当 manager 的 LLM 会话被替换时，已交付的结果既不会丢失也不会被重复交付。

**结构：** `{ parent, project, children: { <childId>: LedgerEntry } }`，其中每个 `LedgerEntry` 有以下字段：

| 字段 | 含义 |
|-------|---------|
| `child` | 子任务 id |
| `kind` | 子任务如何终止：`completed` 或 `blocked` |
| `delivered_at` | 结果交付给 manager 的 ISO 时间戳 |
| `verdict` | `pending` \| `accepted` \| `rejected` |
| `verdict_at` | 裁决的 ISO 时间戳（记录前为 null） |
| `verdict_note` | manager 对该裁决的备注 |
| `rework_round` | 该子任务被拒绝并退回的次数 |

**交付语义**（在裁决记录之前，每个化身内交付至少一次）：

- **`accepted`** → 该子任务结果**永不再交付**给未来的 manager 化身。
- **`pending`**（已交付但尚未裁决——包括化身在裁决前死亡的情况）→ **重新交付**给新的化身。这个偏向是刻意的：宁可重复交付也不丢失。
- **`rejected`** → 重新打开为 `pending`，并在子任务返工后再次完成时重新交付，**并保留 `rework_round`**。

**Fail-open（失败即放行）：** 缺失或损坏的账本降级为空账本——最坏情况是结果被重复交付，绝不会丢失结果。

### 验收循环中的 `verdict` 命令 {#the-verdict-command-in-the-acceptance-loop}

manager 通过 `cortex-task verdict` 命令把裁决写入账本——它是账本的写入路径。在 manager 的验证阶段，对每个已交付的子任务：

- **通过** → `verdict --verdict accepted`。该子任务结果不再重新交付。
- **不通过** → `verdict --verdict rejected --note "<gap>"`。这会递增该子任务的 `rework_round`；子任务随后被返工（例如 `uncomplete` + 编辑，或新增一个修订子任务）并重新交付，此时它重新打开等待再次裁决。

`--verdict` 必须恰好是 `accepted` 或 `rejected`，且 `--child` 为必填。命令的确切签名与标志见 [cli-reference.md](./cli-reference.md)。

## 任务分发并发 {#task-dispatch-concurrency}

任务派发器会在每次派发尝试前检查容量。`taskDispatchMaxConcurrent` 可设置显式上限；默认值 `null` 使用 `max(4, os.cpus().length - 2)`。从任务选择到 execution 注册之间由 reservation 占位，因此快速计时器触发也不会超过上限。
