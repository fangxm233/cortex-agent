# CLI 参考 {#cli-reference}


Cortex 提供四个可执行文件，在 `agent-server/package.json` 中注册：

| 可执行文件 | 入口点 | 用途 |
|---|---|---|
| `cortex` | `dist/entry/cortex-cli.js` | 服务器管理和初始化 |
| `cortex-evidence-export` | `dist/entry/production-evidence-export-cli.js` | 导出生产 benchmark evidence v2 |
| `cortex-hook` | `dist/entry/hook-cli.js` | 检查 hook 并处理阻塞式用户询问 |
| `cortex-signal` | `dist/entry/signal-cli.js` | 让外部程序解决一个 waitpoint |

四个都接受 `--help`（或 `-h`）打印用法。

---

## cortex

```
cortex <command> [options]
```

服务器生命周期和初始化 CLI。

### 命令 {#commands}

**`cortex init [--home <path>] [--gateway-config-dir <path>] [--force] [--answers <file>] [--json]`**

初始化 `CORTEX_HOME`。交互式向导默认使用内置 PI，不询问后端选择；收集平台（Slack / 飞书）、机器、用量报告与服务设置，写入 `.env`、复制默认配置，并生成 `mcp-config.json` 和 `mode.json`。

写入配置后，向导检测本地 Provider 凭据，提供登录、重新检测、使用已配置的 Provider 继续，或带警告跳过。登录使用与 `cortex auth login` 相同的流程；选择 Claude Code 时复用已有安装，缺失时询问是否允许安装。继续操作会从检测到的端点配置 gateway 路由与 Profile。检测不会发起付费推理请求，也不验证模型是否可调用。

使用 `--answers` 或 `--json` 运行时，不会启动 Provider 登录或等待输入；命令会报告凭据状态，并允许在 Provider 设置未完成时结束。

选项：
- `--home <path>` — 设置 `CORTEX_HOME`（默认：`$CORTEX_HOME` 或 `~/.cortex/`）
- `--gateway-config-dir <path>` — 网关配置输出目录（默认：`~/.aistatus/`）
- `--force` — 覆盖已有配置（`.env`、`budget.json`、`mode.json` 等）
- `--answers <file>` — 从 JSON 文档读取回答，不进行交互提问。省略的字段使用默认值；`{}` 创建使用 PI 的单机安装，若未检测到凭据，仍需登录 Provider。桌面安装器使用此选项。显式 `backends` 数组保留指定的后端选择与安装语义（`claude`、`pi` 或两者）；显式空数组保留回退到 Claude 的行为。
- `--json` — 在 stdout 输出按行分隔的 JSON 进度事件，并将面向人的输出改到 stderr。最后一条事件报告 home 目录、版本、客户端 token 与本地 Web UI 地址。

**`cortex ui enable [--port <n>] [--home <path>] [--json]`**

让本安装可被 Cortex 桌面应用连接。缺失时生成客户端 token，设置 `CORTEX_UI_HTTP=1` 与 `CORTEX_UI_PORT`，并把应用的 origin 合并进 `uiCorsOrigins`。该命令幂等——第二次运行不会改变任何内容。

当它提示配置已改变时需重启 daemon：`.env` 只在进程启动时读取一次。

选项：
- `--port <n>` — 监听端口（默认：3004）
- `--home <path>` — 设置 `CORTEX_HOME`
- `--json` — 以 JSON 打印端点、token、端口以及是否发生变更

**`cortex client remove --device <name> [--keep-remote] [--dry-run] [--home <path>]`**

下线一台远程机器。命令从 `config/machines.json` 删除该机器的条目，经 SSH 连到该机器，停止所有运行其 client bundle 的进程，并从 client 的 `CORTEX_HOME` 中删除 bundle（`client/`）、`config/cortex-client.json` 和 `logs/client-*.log`，最后从 `data/client-pids.json` 与 `data/client-routes.json` 中移除该机器。注册表条目最先删除，因此运行中的服务器在热加载时释放该机器的隧道和重启定时器，不会把正在停止的 client 再拉起来。

client 的 `CORTEX_HOME` 取自 `clientCommand` 中的 bundle 路径，默认是 `~/.cortex`（Windows 上为 `%USERPROFILE%\.cortex`）。若该目录同时含有 `config/machines.json`，说明那里也有一个 Cortex 服务器：此时只停止 client 进程，文件全部保留。无法连通的机器仍会在本地移除，结果中为 `remote.status: "unreachable"`，并在 stderr 给出警告。服务器本机（没有 `ssh` 的条目）会被拒绝。

输出为 JSON，包含 `device`、`removed_at`、被删除的 `machine_entry`、被清掉的 `runtime` pid 与路由，以及 `remote`——`cleaned`（附被结束的 `killed` pid 与 `files: removed | kept-server-home`）、`unreachable` 或 `skipped`。`--dry-run` 把计划打印在 `would_remove` 下，不做任何改动。

选项：
- `--device <name>` — `machines.json` 中的机器名（必填）
- `--keep-remote` — 只在本地注销，不动远端进程与文件
- `--dry-run` — 打印将要删除的内容，不做任何改动
- `--home <path>` — 设置 `CORTEX_HOME`

**`cortex start`**

Fork `dist/entry/app.js` 作为子进程，继承 stdio。这是在前台运行 Cortex 的主要方式。子进程运行 Slack 机器人、webhook 服务器和所有智能体编排。

**`cortex daemon`**

Fork `dist/entry/daemon.js` 作为子进程，继承 stdio。守护进程包装 `app.js`，带文件监视和崩溃时自动重启。触碰 `$STORE_DIR/.restart` 通知守护进程排放并重生 `app.js`。

**`cortex restart`**

通过触碰 `$STORE_DIR/.restart` 的 `.restart` 触发文件，通知运行中的守护进程排放并重生 `app.js`。如果没有守护进程在运行，此操作除了创建文件之外不执行任何操作。

**`cortex config`**

打印解析后的路径和初始化状态。显示 `INSTALL_ROOT`、所有数据目录，以及 `.env`、`mcp-config.json` 和 `mode.json` 是否存在。

**`cortex doctor [--fix] [--json]`**

以只读方式检查整个安装，包括运行时与进程、backend 安装与登录、消息平台和 gateway。
Backend 检查还会对已安装 PI 运行时及其 `login` 导出做烟测，并从不含凭据的认证快照中汇总
使用中但已过期或未登录的 provider。这两项失败只产生 warning，不会让 doctor 整体失败。
API 模式下，如果 gateway 健康但本地没有 key，会显示 gateway 托管的说明信息，不会误报未登录。

每项检查显示 `[OK]`、`[WARN]`、`[FAIL]` 或 `[--]`（跳过）。存在失败项时命令退出码为 1；
只有 warning 或跳过项时退出码仍为 0。

选项：
- `--fix` — 只执行安全且幂等的修复：创建缺失的数据目录、生成缺失的 Cortex 认证 token、重建 `mcp-config.json`
- `--json` — 以 JSON 输出完整报告

**`cortex auth status [--json]`**

读取归一化的 Claude Code 与 PI 认证快照。默认文本输出是简洁状态总览；`--json` 返回完整
`AuthStatusSnapshot`，便于脚本处理。两种输出都不会包含凭据值或其片段。

该子命令只读，报告本地凭据状态，不做在线推理验证。本地登录使用 `cortex auth login`。
远程登录从 Slack/飞书的 `!login` 或 Web UI 的**设置 → 账号**发起；
移动端 drill-in 路径是 `/m/settings/accounts`。

选项：
- `--json` — 以 JSON 输出完整且不含凭据的状态快照
- `--help`、`-h` — 显示 auth 命令帮助

登录命令、provider 能力判据和过期处理参见[后端：远程登录](./backends.md#remote-login)。

**`cortex auth login [--backend pi|claude] [--provider ID] [--auth-type oauth|api_key]`**

从交互式终端登录 Provider，无需运行 daemon。省略的选项通过交互选择，Provider 与认证方式以所选后端支持的能力为准。PI 已内置。Claude Code 已安装时直接复用；缺失时必须确认后，Cortex 才会安装并开始登录。

即使已提供全部选择参数，登录仍要求 stdin 和 stderr 都是 TTY。API key 与授权响应通过隐藏输入提示收集；此命令不接受密钥、token 或授权码参数。浏览器链接与设备授权指引显示在 stderr。非 TTY 登录会立即失败，不启动认证流程；帮助信息无需 TTY。

结果以 JSON 写入 stdout，面向人的提示与错误写入 stderr；不需要也不接受 `--json` 参数。结果不含秘密值。登录成功后同步 gateway/Profile 配置，并报告同步结果与 `inferenceVerified: false`：凭据已配置，但未经推理测试，也不会发送付费模型请求。

选项：
- `--backend pi|claude` — 选择后端；省略时交互选择
- `--provider ID` — 选择该后端运行时支持的 Provider
- `--auth-type oauth|api_key` — 选择支持的认证方式
- `--help`、`-h` — 显示登录帮助，不启动登录

```bash
cortex auth login
cortex auth login --backend pi --provider anthropic --auth-type api_key
cortex auth login --backend claude --provider anthropic --auth-type oauth
cortex auth login --help
```

**`cortex auth provider <list|add|remove> [选项]`**

管理自定义 PI provider——自建或代理的推理端点，它们没有自己的登录流程。`add` 即 upsert：
用改过的地址或模型列表重跑一次，就是原地编辑这条定义。

选项：
- `--name <名称>` — provider 名称，仅限字母、数字、`-` 和 `_`
- `--api <协议>` — 请求协议：`anthropic-messages`、`openai-completions`、`openai-responses` 或 `google-generative-ai`
- `--url <地址>` — 上游端点地址，保存在网关路由里
- `--key <密钥|->` — 上游 API key；填 `-` 表示从标准输入读取，这样密钥不会进入 shell 历史
- `--model <id>` — 端点提供的模型 id，可重复
- `--dry-run` — 用于 `remove`：只显示会删掉什么，不真的删
- `--json` — 以 JSON 输出结果
- `--help`、`-h` — 显示 provider 命令帮助

```bash
# 定义一个使用 Anthropic 协议的本地端点
cortex auth provider add --name my-vllm --api anthropic-messages \
  --url http://127.0.0.1:8100 --model Model-27B

# 从密钥库取 key，不出现在命令行里
pass show my-endpoint | cortex auth provider add --name my-proxy \
  --api openai-completions --url https://proxy.example.com/v1 --model small --key -

cortex auth provider list --json
cortex auth provider remove --name my-vllm --dry-run
```

两份写入的内容以及一条定义如何抵达 agent，参见[后端：自定义 provider](./backends.md#custom-providers)。

**`cortex setup-gateway [--dry-run] [--output-dir <path>]`**

从本地配置文件自动检测 Claude Code 和 PI 配置，生成 `~/.aistatus/gateway.yaml`（备份已有文件），并写入 `$CORTEX_HOME/config/profiles.json`。在添加新的 API 密钥或更改模型时运行此命令。

选项：
- `--dry-run` — 将生成的 gateway.yaml 打印到 stdout 而不写入
- `--output-dir <path>` — 在 `<path>` 下写入 gateway.yaml 和 profiles.json 而不是默认位置

**`cortex schedule <list|get|add|edit|pause|resume|remove> [<id>] [options]`**

管理定时任务——与 MCP 调度工具、`!schedule` 和 Web UI 管理的是同一批记录。每次触发都会在调度所属项目中新开一个会话并发送消息，见[调度](./scheduling.md)。变更写入 `schedules.json`，正在运行的 daemon 会在一秒内应用。

每个命令都输出带 `ok: true` 的 JSON 和调度本身（`schedule`；`list` 输出 `schedules` 和 `count`），时间戳为 ISO 8601。输入无效时以退出码 1 结束，并在 stderr 列出有效取值。

- `list [--project <id>]` — 列出全部调度，或某个项目的调度
- `get <id>` — 查看一个调度；id 不存在时退出码为 1
- `add --type <type> …` — 创建调度；`--idempotency-key` 命中已有调度时输出 `created: false` 和那个调度
- `edit <id> …` — 修改消息、项目、profile、pre-check，或该调度类型对应的时间字段；类型本身不能改
- `pause <id>` / `resume <id>` — 暂停或恢复周期性调度；重复执行不会改变任何东西
- `remove <id> [--dry-run]` — 删除调度（不存在时输出 `removed: false`）；`--dry-run` 输出 `would_remove`，不删除

选项：
- `--type interval|daily|weekly|once` — 调度类型（仅 `add`）
- `--interval <duration>` — `interval`：重复周期，如 `30m`、`2h`、`1d`
- `--time <HH:MM>` — `daily`/`weekly`：24 小时制，服务器本地时间
- `--day <day>` — `weekly`：`sun`..`sat` 或 `0`-`6`
- `--delay <duration>` — `once`：从现在起多久后触发；用于 `edit` 时改到新的触发时间
- `--message <text|->` — 触发会话收到的提示；`-` 从 stdin 读取
- `--project <id>` — 触发会话所属的项目（默认 `general`）
- `--profile <name>` — 运行所用的 agent profile（默认为默认 profile）
- `--pre-check <cmd>` — 每次触发前运行的 shell 门控；非零退出则跳过这次触发
- `--idempotency-key <key>` — `add`：用同一个 key 重试会返回第一次创建的调度
- `--help`、`-h` — 显示 schedule 帮助

```bash
cortex schedule add --type interval --interval 30m --project nimbus \
  --message "Check GPU usage on lab2 and report a one-line summary"
cortex schedule add --type weekly --day mon --time 21:00 --message "Weekly review"
echo "Check training run r42 on lab2" | cortex schedule add --type once --delay 2h --message -
cortex schedule list --project nimbus
cortex schedule edit a1b2c3d4 --time 10:30
cortex schedule remove a1b2c3d4 --dry-run
```

### 退出码 {#exit-codes}

| 代码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 错误（无效命令、缺少配置、运行时失败） |

---

## cortex-evidence-export

```
cortex-evidence-export --input-file <路径|->
```

从 `CORTEX_HOME` 下的生产 store 发布不可变的 terminal/composite benchmark evidence v2。
命令初始化生产 attempt identity 与 journal store，加载 `data/executions.json`，读取归因后的
cost，再把验证和原子发布委托给 `exportProductionBenchmarkEvidence`。Cortex benchmark arm
始终运行真实 production server，每个 trial 是一个 direct session；此命令只记录该 runtime 的
store，不定义第二条 orchestration path。

Evidence 按 session 与 execution 建键：trial 的 session 打开的每次 run 是一个 attempt，
由 `session_id` 和 `execution_id` 标识；session 中每个后续 run 是前一个 run 的 spawn 子节点。

`--input-file` 接收 JSON 编码的 `ProductionEvidenceExportInput`；传 `-` 表示从 stdin 读取。
所有字段都由 launcher 持有：`outputDirectory`、`trialId`、`rootRunId`、`armName`、
`armCanonicalSha256`、`bundleManifestHash`、`proxyExport`，以及可选的 `evaluatedChecks`。
发布前会验证 hash、proxy trial identity 和 predicate 结果。输入缺失或格式错误、持久记录
不完整、或输出目录已存在时，命令以退出码 `1` fail closed。

```bash
cortex-evidence-export --input-file production-evidence.json
cat production-evidence.json | cortex-evidence-export --input-file -
```

成功时向 stdout 写入一个 JSON 对象：

```json
{"ok":true,"directory":"/evidence/run-1","composite_path":"/evidence/run-1/composite-manifest.json","composite_sha256":"<sha256>","terminal_paths":["/evidence/run-1/execution-root.terminal.json"]}
```

失败时向 stderr 写入 `{"ok":false,"error":"..."}`，且不会发布部分目录。只有所有 terminal
和 composite 字节都在隐藏 staging 目录内完成写入、fsync 和校验后，公开输出路径才会出现。

---

## cortex-signal

```
cortex-signal [--id wp_…] [--secret …] [--status ok|fail|progress] [--message TEXT] [--exit-code N]
```

告诉 Cortex：它在等的那件事结束了。Agent 先用 `wait_create` MCP 工具登记一个 waitpoint 并结束自己那一轮，
这个命令解决该 waitpoint 并唤醒对应 session。完整说明见 [waitpoints.md](./waitpoints.md)。

`--id` 和 `--secret` 默认取 `$CORTEX_SIGNAL_ID` 和 `$CORTEX_SIGNAL_SECRET`，所以通常的接入就是两行：
先 export 一次，再在命令后面追加一行。

选项：
- `--id <wp_…>` — waitpoint id（默认：`$CORTEX_SIGNAL_ID`）
- `--secret <hex>` — 随该 waitpoint 一起签发的能力凭证（默认：`$CORTEX_SIGNAL_SECRET`）
- `--status <s>` — `ok`、`fail` 或 `progress`（默认：`ok`）。`ok`/`fail` 是终态：计入 quorum 并唤醒会话；`progress` 只记录心跳，不结算、**也不唤醒任何人** —— 两者的区别完全在于「这件事值不值一个 turn」
- `--exit-code <n>` — 由命令退出码推导状态（0 为 `ok`，其余为 `fail`），消息默认为 `exit=<n>`
- `--message <text>` — 一行摘要，显示在唤醒消息里
- `--member <name>` — 多任务 waitpoint 中这条信号属于哪个成员
- `--data <@file|->` — 来自文件或 stdin 的附加载荷；它以**数据**身份到达 agent，绝不作为指令
- `--url <url>` — 守护进程 signal 端点（默认：`http://127.0.0.1:$WEBHOOK_PORT/webhook/signal`）
- `--no-spool` — 守护进程不可达时直接失败，不落盘
- `--help`、`-h` — 显示用法

该端点只监听回环，并且**不**接受 `CORTEX_WEBHOOK_TOKEN`：每个 waitpoint 的 secret 是唯一凭证，
而它除了解决自己那一个 waitpoint 之外什么都做不了。要从别的机器发信号，就在那台机器的
`~/.cortex/tmp/signals/` 里落一个 JSON 文件——见
[waitpoints.md](./waitpoints.md#on-another-machine)。

### 落盘缓冲 {#spooling}

守护进程不可达时，信号会写到 `$CORTEX_HOME/tmp/signals/<name>.json`（先写 `.tmp` 再 rename，
所以永远不会有人读到半截文件），命令仍然退出 0。守护进程会在下一个 sweep 周期收走它，
因此重启期间发出的信号只是延迟，不会丢失。`--no-spool` 关掉这个行为，改为退出 1。

### 退出码 {#exit-codes_1}

| 代码 | 含义 |
|---|---|
| 0 | 已接受、已落盘，或该 waitpoint 早已被解决 |
| 1 | 被拒绝（secret 错误、id 不存在、被限流），或带 `--no-spool` 且不可达 |
| 2 | 用法错误（缺少 id/secret、未知标志、`--status` 非法） |

「早已被解决」故意退出 0：重试的脚本不该把「别人已经报过了」当成失败。

### 示例 {#examples}

```bash
# 报告刚跑完那条命令的退出码
export CORTEX_SIGNAL_ID=wp_1a2b3c4d5e6f CORTEX_SIGNAL_SECRET=…
python train.py; cortex-signal --exit-code $?

# 报告多任务 waitpoint 的其中一个成员
cortex-signal --member arm2 --status ok --message "33,120 steps"

# 把日志尾巴作为数据附上
python train.py; s=$?; tail -c 2000 train.log | cortex-signal --exit-code $s --data -

# 只报进度，不吵醒任何人
cortex-signal --status progress --message "epoch 12/40"

# 给一个已经在跑的进程补一个信号
(while kill -0 12345 2>/dev/null; do sleep 5; done; cortex-signal --status ok) &
```
