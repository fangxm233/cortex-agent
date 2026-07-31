# CLI 参考 {#cli-reference}


Cortex 提供三个可执行文件，在 `agent-server/package.json` 中注册：

| 可执行文件 | 入口点 | 用途 |
|---|---|---|
| `cortex` | `dist/entry/cli.js` | 服务器管理和初始化 |
| `cortex-task` | `dist/domain/tasks/system/task-cli.js` | 任务系统读取和修改 |
| `cortex-run` | `dist/domain/tasks/system/cortex-run.js` | 远程命令分发 |

三个都接受 `--help`（或 `-h`）打印用法。`cortex task` 子命令直接委托给 `cortex-task`。

---

## cortex

```
cortex <command> [options]
```

服务器生命周期和初始化 CLI。

### 命令 {#commands}

**`cortex init [--home <path>] [--gateway-config-dir <path>] [--force]`**

交互式初始化向导。创建 `CORTEX_HOME` 目录结构，提示选择后端（Claude Code / PI）、交互平台（Slack）、网关使用和系统服务注册。生成带平台令牌的 `.env`，复制默认配置，并自动生成 `mcp-config.json` 和 `mode.json`。

选项：
- `--home <path>` — 设置 `CORTEX_HOME`（默认：`$CORTEX_HOME` 或 `~/.cortex/`）
- `--gateway-config-dir <path>` — 网关配置输出目录（默认：`~/.aistatus/`）
- `--force` — 覆盖已有配置（`.env`、`budget.json`、`mode.json` 等）

**`cortex start`**

Fork `dist/entry/app.js` 作为子进程，继承 stdio。这是在前台运行 Cortex 的主要方式。子进程运行 Slack 机器人、webhook 服务器和所有智能体编排。

**`cortex daemon`**

Fork `dist/entry/daemon.js` 作为子进程，继承 stdio。守护进程包装 `app.js`，带文件监视和崩溃时自动重启。触碰 `$STORE_DIR/.restart` 通知守护进程排放并重生 `app.js`。

**`cortex restart`**

通过触碰 `$STORE_DIR/.restart` 的 `.restart` 触发文件，通知运行中的守护进程排放并重生 `app.js`。如果没有守护进程在运行，此操作除了创建文件之外不执行任何操作。

**`cortex task <subcommand> [options]`**

委托给 `cortex-task`。所有子命令参见下方 `cortex-task` 部分。

**`cortex config`**

打印解析后的路径和初始化状态。显示 `INSTALL_ROOT`、所有数据目录，以及 `.env`、`mcp-config.json` 和 `mode.json` 是否存在。

**`cortex setup-gateway [--dry-run] [--output-dir <path>]`**

从本地配置文件自动检测 Claude Code 和 PI 配置，生成 `~/.aistatus/gateway.yaml`（备份已有文件），并写入 `$CORTEX_HOME/config/profiles.json`。在添加新的 API 密钥或更改模型时运行此命令。

选项：
- `--dry-run` — 将生成的 gateway.yaml 打印到 stdout 而不写入
- `--output-dir <path>` — 在 `<path>` 下写入 gateway.yaml 和 profiles.json 而不是默认位置

### 退出码 {#exit-codes}

| 代码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 错误（无效命令、缺少配置、运行时失败） |

---

## cortex-task

```
cortex-task <command> [options]
```

跨项目读取和修改 TASKS.yaml 文件。完整的任务系统生命周期、格式参考和调度模型参见 [tasks.md](./tasks.md)。既可作为独立可执行文件使用，也可通过 `cortex task <command>` 使用。

### 读取命令 {#read-commands}

这些命令不修改任何文件。它们都支持 `--json` 以输出机器可读格式。

**`list [--project <name>] [--status <status>] [--priority <level>] [--text <filter>] [--has-deps] [--no-deps] [--json]`**

显示可操作任务（默认）。按项目、状态、优先级、文本子串或依赖存在性过滤。使用 `--all` 包含已完成任务。

**`all [options]`**

`list --all` 的别名。显示所有任务包括已完成的。

**`query [--project <name>] [--status <status>] [--priority <level>] [--has-deps] [--no-deps] [--json]`**

过滤所有任务（包括已完成的）。与 `list` 相同的过滤选项，但总是扫描完整的任务集。

**`show --task-id <id> [--json]`**

显示单个任务的详细信息：text、why、done-when、plan、status、依赖和依赖它的任务。

**`deps --task-id <id> [--json]`**

显示一个任务的依赖图：它依赖什么以及什么依赖它。

**`lint [--project <name>] [--json]`**

验证任务结构：缺失 ID、悬空依赖、循环和无效模板名称。

**`stats [--json]`**

打印每项目的任务供给统计：按状态和优先级的计数。

### 状态命令 {#state-commands}

这些命令需要 `--project` 和 `--task-id` 或 `--task`。

**`claim --project <name> (--task-id <id> | --task <text>) [--agent <name>]`**

将任务标记为进行中（claimed）。`--agent` 标志记录认领的智能体（默认：`cortex-local`）。

**`unclaim --project <name> (--task-id <id> | --task <text>)`**

从任务中移除 claimed 状态，将其返回为 open。

**`pause --project <name> (--task-id <id> | --task <text>)`**

暂停一个任务（通常是进行中的）。暂停的任务不会被调度。

**`resume --project <name> (--task-id <id> | --task <text>)`**

恢复一个暂停的任务。

**`pending --project <name> (--task-id <id> | --task <text>)`**

将任务标记为 pending（等待 `cortex-run` 进程完成）。

**`reopen --project <name> (--task-id <id> | --task <text>)`**

将卡住的 `pending` 任务还原为 `open`，使调度器可以重新派发。用于挽救因 `cortex-run`
回调丢失而停留在 `pending` 的任务。对已是 open 的任务幂等，对已完成的任务则拒绝（请改用
`uncomplete`）。

**`complete --project <name> (--task-id <id> | --task <text>) [--note <text>] [--skip-verify] [--skip-verify-reason <text>]`**

将任务标记为完成。需要 `--note` 描述完成了什么。默认情况下，Cortex 验证 `done-when` 条件是否满足。使用 `--skip-verify` 和 `--skip-verify-reason` 绕过验证。

**`uncomplete --project <name> (--task-id <id> | --task <text>)`**

撤销已完成的任务，将其返回到之前的状态。

### 审批命令 {#approval-commands}

**`request-approval --project <name> (--task-id <id> | --task <text>)`**

将任务标记为需要审批。

**`approve --project <name> (--task-id <id> | --task <text>)`**

审批一个等待审批的任务。

**`clear-approval --project <name> (--task-id <id> | --task <text>)`**

清除任务的审批状态。

### 阻塞命令 {#blocking-commands}

**`block --project <name> (--task-id <id> | --task <text>) --reason <text>`**

以某个原因阻塞任务。被阻塞的任务不会被调度。

**`unblock --project <name> (--task-id <id> | --task <text>)`**

解除一个之前被阻塞的任务。

### 验收命令 {#acceptance-commands}

**`verdict --project <name> --task-id <parent id> --child <child id> --verdict accepted|rejected [--note <text>]`**

将 manager 对已交付子任务的验收结论记入父任务节点的验收台账（DR-0017）。必需：`--project`、`--task-id`（父/manager 任务）、`--child`（子任务 id）以及 `--verdict`，其值必须严格为 `accepted` 或 `rejected`（其他任何值都会报错）。`--note` 可选，用于记录原因。`accepted` 的子任务结果**不会再次投递**给未来的 manager 化身；`rejected` 结论会递增该子任务的 `rework_round`，并在其返工后再次完成时**重新打开**以进行下一次验收。该命令写入的是每个节点的台账，**不需要项目锁**。验收台账的数据模型见 [tasks.md](./tasks.md)。

### 修改命令 {#mutation-commands}

这些命令需要项目锁（`cortex-task lock-acquire`）才能运行，以防止对同一 TASKS.yaml 的并发编辑。

**`add --project <name> --text <text> [--why <text>] [--done-when <text>] [--plan <path>] [--priority <level>] [--template <name>] [--depends-on <id...>]`**

添加新任务。必需：`--text`。可选：`--why`（理由）、`--done-when`（成功标准）、`--plan`（设计文档引用）、`--priority`（high/medium/low，默认：medium）、`--template`（线程模板名称）、`--depends-on`（空格分隔的十六进制 ID）。

**`edit --project <name> (--task-id <id> | --task <text>) [--text <text>] [--why <text>] [--done-when <text>] [--plan <path>] [--priority <level>] [--depends-on <id...>] [--add-depends-on <id>] [--remove-depends-on <id>] [--clear-depends-on]`**

编辑任务字段。必须至少指定一个字段。依赖可以设值（替换）、追加（`--add-depends-on`，可重复）、移除（`--remove-depends-on`，可重复）或清除（`--clear-depends-on`）。

**`batch-edit --project <name> --task-ids <ids> [fields...]`**

对多个任务应用相同编辑。`--task-ids` 接受逗号分隔的十六进制 ID 列表。字段选项与 `edit` 相同。

**`decompose --project <name> (--task-id <id> | --task <text>) --subtasks-file <path> [--dry-run]`**

用 JSON 文件中定义的子任务替换一个任务。`-` 表示 stdin。`--dry-run` 预览而不执行。

### 锁命令 {#lock-commands}

项目锁系统防止对 TASKS.yaml 的并发编辑。每个锁有固定的 20 分钟 TTL。

**`lock-acquire --project <name> [--force] [--note <text>] [--json]`**

获取项目锁。通过 `git config user.email` 或 `$USER` 识别所有者。`--force` 从其他所有者那里抢占锁。

**`lock-release --project <name> [--force] [--json]`**

释放项目锁。只有锁的所有者（或 `--force`）可以释放。

**`lock-status [--project <name>] [--json]`**

显示锁状态。不带 `--project` 则列出所有项目。

**`lock-force-release --project <name> [--json]`**

强制释放项目锁，无论所有者是谁。

### 维护命令 {#maintenance-commands}

**`assign-ids [--project <name>]`**

自动为缺少 ID 的任务分配 4 字符十六进制 ID。需要项目锁。

**`validate`**

验证所有项目的所有任务 ID。检查重复 ID 和格式错误的条目。不修改文件。

**`stop --task-id <id> [--dry-run]`**

终止一个已分发的任务进程。`--task-id` 可以是分发 ID（如 `dispatch_abc123`）或任务哈希。`--dry-run` 显示将被终止的内容而不执行。终止命令通过守护进程 webhook 转发到远程客户端。

### 通用选项 {#common-options}

| 标志 | 描述 |
|---|---|
| `--project <name>` | 项目名称（大多数写入命令必需） |
| `--task-id <id>` | 任务哈希 ID（4 字符十六进制） |
| `--task <text>` | 按任务文本查找（`--task-id` 的模糊替代） |
| `--base-dir <path>` | Cortex 根目录（默认：`~/Cortex`） |
| `--json` | 以 JSON 输出（读取命令和锁操作） |
| `--help` | 显示命令帮助 |

### 任务生命周期状态 {#task-lifecycle-states}

```
open → claimed → done
  ↓        ↓
paused   pending → open (reopen)
  ↓
blocked → open (unblock)

approval states: request-approval → approve → clear-approval
```

`block`/`unblock` 与 `reopen` 都会把任务状态归一回 `open`，因此在 `cortex-run` 中途失败
（停留在 `pending`）的任务会回到可派发状态，而不会对调度器永久隐形。

### 退出码 {#exit-codes_1}

| 代码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 错误（无效参数、锁被他人持有、任务未找到） |

---

## cortex-run

```
cortex-run [options] -- COMMAND [ARGS...]
```

通过 Cortex 守护进程在远程设备上分发命令。所有执行通过 `sendCommand` 转发到 cortex-client；本地不生成任何进程。守护进程必须正在运行（它在 `127.0.0.1:3001` 上提供 webhook 服务）。定时重复运行参见 [scheduling.md](./scheduling.md)。基于线程的执行参见 [threads.md](./threads.md)。

### 启动模式 {#launch-mode}

```
cortex-run [--device <name>] --name <name> [--stall 10m] [--gpu auto]
           [--task-project P --task-id ABCD] [--force]
           [--env-passthrough VAR1,VAR2,...]
           [--log-tail-bytes 5000]
           -- COMMAND [ARGS...]
```

选项：
- `--name <name>` — 必需，唯一的运行名称（也用作结果目录）
- `--device <name>` — 目标设备（默认：来自 `machines.json` 的本地机器名称）
- `--stall <duration>` — 停滞超时，如 `10m`、`1h`（默认：`10m`）
- `--gpu <slot>` — GPU 槽位：`auto`、`none` 或数字索引（默认：`auto`）
- `--force` — 即使存在同名运行状态目录也允许启动
- `--task-project <name>` — 将此运行链接到项目以进行任务生命周期追踪
- `--task-id <hash>` — 4 字符十六进制任务 ID（与 `--task-project` 一起使用）；无效 ID 在分发前导致非零退出
- `--env-passthrough <list>` — 逗号分隔的要转发到远程的环境变量名
- `--log-tail-bytes <n>` — 回调中返回的日志尾部字节数（默认：5000）

`--` 分隔符是必需的。其后的所有内容都是要在远程设备上运行的命令。

当提供 `--task-project` 和 `--task-id` 时，`cortex-run` 在分发前将任务标记为 pending，并将完成/阻塞推迟到客户端回调处理器。成功时任务自动完成；失败时自动阻塞，附带日志尾部上下文。

### 取消模式 {#cancel-mode}

```
cortex-run --cancel <name> [--device <name>] [--signal SIGTERM]
```

选项：
- `--cancel <name>` — 要取消的运行名称
- `--device <name>` — 目标设备（默认：本地机器名称）
- `--signal <sig>` — 要发送的信号（默认：`SIGTERM`）

### 退出码 {#exit-codes_2}

| 代码 | 含义 |
|---|---|
| 0 | 成功（已启动或已取消） |
| 1 | 致命错误（无效 task-id、设备离线、启动/取消失败） |
| 2 | 用法错误（缺少必需标志、`--` 后无命令） |

### 示例 {#examples}

```bash
# 在本地机器上启动训练脚本
cortex-run --name train-v2 --gpu auto -- python train.py --epochs 100

# 带任务链接的启动（成功时自动完成任务）
cortex-run --name eval-run --task-project my-project --task-id a1b2 -- python eval.py

# 在远程设备上启动，带环境变量透传
cortex-run --device lab --name remote-train --env-passthrough WANDB_API_KEY,HF_TOKEN -- python train.py

# 取消运行中的作业
cortex-run --cancel train-v2

# 用特定信号取消
cortex-run --cancel train-v2 --signal SIGKILL
```
