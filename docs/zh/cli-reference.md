# CLI 参考 {#cli-reference}

Cortex 提供五个可执行文件，在 `agent-server/package.json` 中注册：

| 可执行文件 | 入口点 | 用途 |
|---|---|---|
| `cortex` | `dist/entry/cortex-cli.js` | 服务器管理和初始化 |
| `cortex-browser` | `dist/entry/browser-cli.js` | 操作当前会话的 agent 浏览器 |
| `cortex-evidence-export` | `dist/entry/production-evidence-export-cli.js` | 导出生产 benchmark evidence v2 |
| `cortex-hook` | `dist/entry/hook-cli.js` | 检查、切换、试运行 hook，以及阻塞式用户询问 |
| `cortex-signal` | `dist/entry/signal-cli.js` | 让外部程序解决一个 waitpoint |

五个都接受 `--help`（或 `-h`）打印用法。

---

## cortex {#cortex}

```
cortex <command> [options]
```

服务器生命周期和初始化 CLI。`cortex --help` 列出所有命令。

### 命令 {#commands}

**`cortex init [--home <path>] [--gateway-config-dir <path>] [--force] [--answers <file>] [--json]`**

初始化 `CORTEX_HOME`。交互式向导默认使用内置 PI，不询问后端选择；收集平台（Slack / 飞书）、机器、用量报告与服务设置，写入 `.env`、复制默认配置，并生成 `mcp-config*.json` 文件、`machines.json`、`preferences.json` 和 `agent-state.json`。它还会初始化 `schedules.json`，在 `git` 可用时在 `CORTEX_HOME` 中创建 git 仓库，并可按回答启用本地 Web UI、安装系统服务。

写入配置后，向导检测本地 Provider 凭据，提供登录、重新检测、使用已配置的 Provider 继续，或带警告跳过。登录使用与 `cortex auth login` 相同的流程；选择 Claude Code 时复用已有安装，缺失时询问是否允许安装。继续操作会从检测到的端点配置 gateway 路由，并询问默认模型与收藏。默认项预选推荐模型，并包含在收藏中。检测不会发起付费推理请求，也不验证模型是否可调用。

使用 `--answers` 或 `--json` 运行时，不会启动 Provider 登录或等待输入；命令会报告凭据状态，并允许在 Provider 设置未完成时结束。

选项：
- `--home <path>` — 设置 `CORTEX_HOME`（默认：`$CORTEX_HOME` 或 `~/.cortex/`）
- `--gateway-config-dir <path>` — 网关配置输出目录（默认：`~/.aistatus/`）
- `--force` — 覆盖已有配置（`.env`、`budget.json`、`agent-state.json` 等）
- `--answers <file>` — 从 JSON 文档读取回答，不进行交互提问。省略的字段使用默认值；`{}` 创建使用 PI 的单机安装，若未检测到凭据，仍需登录 Provider。桌面安装器使用此选项。显式 `backends` 数组保留指定的后端选择与安装语义（`claude`、`pi` 或两者）；显式空数组保留回退到 Claude 的行为。
- `--json` — 在 stdout 输出按行分隔的进度事件，并将面向人的输出改到 stderr。最后一条事件报告 home 目录、版本、客户端 token 与本地 Web UI 地址。

模型答案采用以下结构（所选组合须属于检测到的模型）：

```json
{
  "defaultChoice": { "mode": "openai-codex", "model": "gpt-6.1-sol" },
  "favorites": [{ "mode": "openai-codex", "model": "gpt-6.1-sol" }]
}
```

显式 `defaultChoice` 会替换保存的默认值，否则保留它。收藏合并并包含所选默认模型。按位置读取的 stdin 协议以两行模型选择结束：默认模型的 `mode:model`，以及逗号分隔的收藏 `mode:model`。

**`cortex ui enable [--port <n>] [--home <path>] [--json]`**

让本安装可被 Cortex 桌面应用连接。缺失时生成客户端 token，设置 `CORTEX_UI_HTTP=1` 与 `CORTEX_UI_PORT`，并把应用的 origin 加入 `uiCorsOrigins`。该命令幂等——第二次运行不会改变任何内容。其输出末尾会提示 `cortex ui pair`。

当它提示配置已改变时需重启 daemon：`.env` 只在进程启动时读取一次。

选项：
- `--port <n>` — 监听端口。不传时保留 `.env` 中已有的 `CORTEX_UI_PORT`，没有则使用 `3004`；端口无效时退出码为 1
- `--home <path>` — 设置 `CORTEX_HOME`（默认：`$CORTEX_HOME` 或 `~/.cortex`）
- `--json` — 打印 `{ ok, home, url, token, port, changed }`

**`cortex ui pair [--home <path>] [--json]`**

为新的应用或浏览器打印一次性配对码（`XXXX-XXXX`）。配对码 10 分钟内有效、只能用一次；在桌面或 Android 应用中连同服务器地址一起填入，或在浏览器登录页输入。配对码写入 `$CORTEX_HOME/data/ui-pairing.json`，运行中的服务器会读取它，无需重启。已登录的设备也可在**设置 → 机器 →「已连接的 App」**中生成同样的配对码（见[浏览器访问](browser-access.md#pairing-codes-and-connected-apps)）。

选项：
- `--home <path>` — 设置 `CORTEX_HOME`（默认：`$CORTEX_HOME` 或 `~/.cortex`）
- `--json` — 打印 `{ ok, code, expiresAt }`

**`cortex client remove --device <name> [--keep-remote] [--dry-run] [--home <path>]`**

下线一台远程机器。命令从 `config/machines.json` 删除该机器的条目，经 SSH 连到该机器，停止所有运行其 client bundle 的进程，并从 client 的 `CORTEX_HOME` 中删除 bundle（`client/`）、`config/cortex-client.json` 和 `logs/client-*.log` 文件，随后从 `data/client-pids.json` 与 `data/client-routes.json` 中移除该机器。注册表条目最先删除，因此运行中的服务器在热加载时释放该机器的隧道和重启定时器，不会把正在停止的 client 再拉起来。

client 的 `CORTEX_HOME` 取自 `clientCommand` 中的 bundle 路径，默认是 `~/.cortex`（Windows 上为 `%USERPROFILE%\.cortex`）。若该目录同时含有 `config/machines.json`，说明它属于一个 Cortex 服务器：此时只停止 client 进程，文件全部保留。无法连通的机器仍会在本地移除，结果中为 `remote.status: "unreachable"`，并在 stderr 给出警告。服务器本机（没有 `ssh` 的条目）会被拒绝。

输出为 JSON，包含 `device`、`removed_at`、被删除的 `machine_entry`、被清掉的 `runtime` pid 与路由，以及 `remote`——`cleaned`（附被结束的 `killed` pid 与 `files: removed | kept-server-home`）、`unreachable` 或 `skipped`。`--dry-run` 把计划打印在 `would_remove` 下，不做任何改动。

选项：
- `--device <name>` — `machines.json` 中的机器名（必填）
- `--keep-remote` — 只在本地注销，不动远端进程与文件
- `--dry-run` — 打印将要删除的内容，不做任何改动
- `--home <path>` — 设置 `CORTEX_HOME`

**`cortex path <install|remove|status> [--home <path>] [--dry-run] [--json]`**

让新开的终端可以直接使用本安装的命令。`install` 为上表中的每个二进制在 `$CORTEX_HOME/runtime/bin` 写入一个启动器：启动器用执行本命令的那个 Node.js 运行本安装的入口文件，因此终端的 `PATH` 中不需要有 Node.js。随后把该目录登记到 `PATH`：Linux 和 macOS 上写入以 `# >>> cortex >>>` 标记的块，放在 `~/.profile` 末尾，以及正在使用的 shell 对应的 `~/.bash_profile` 和 `~/.zshenv`（设置了 `$ZDOTDIR` 时位于其下）末尾；`~/.bashrc` 中的块放在文件开头，让非交互的 SSH 命令也能读到。Windows 上把该目录加到用户 `Path` 的最前面，保留其注册表类型，并通知新进程环境已变化。重复执行 `install` 只改写有差异的部分。即使 `PATH` 上还有别的 `cortex`，新终端也会使用本安装；结果的 `shadowed` 列出这些被覆盖的命令。不配置 fish。

服务端启动时，若自己的 Node.js 或入口路径与已有启动器不一致，会改写这些启动器。由桌面应用安装在 `$CORTEX_HOME/runtime/prefix` 中的服务端，在没有启动器时还会自行执行 `install`，除非最近一次选择是 `remove`。`install` 和 `remove` 把这一选择记录在 `$CORTEX_HOME/runtime/terminal-cli.json`。`remove` 只删除本命令写入的文件，并把该目录从 `PATH` 中撤下，profile 文件和用户 `Path` 恢复为 `install` 之前的样子。`status` 报告启动器是否存在、哪些已过期，以及该目录登记在哪里。

选项：
- `--home <path>` — 设置 `CORTEX_HOME`，它同时成为启动器默认使用的 `CORTEX_HOME`（默认：`$CORTEX_HOME` 或 `~/.cortex`）
- `--dry-run` — 用于 `install` 和 `remove`：报告将做的改动，不写入任何内容
- `--json` — 打印 `{ ok, action, dry_run, dir, … }`：`install` 附 `written` 和 `shadowed`，`remove` 附 `removed`，`path_targets` 列出每个 profile 文件或 `HKCU\Environment\Path` 以及它是否被改动

**`cortex start`**

在前台运行服务器：以继承的 stdio、以 `$CORTEX_HOME` 为工作目录 fork `dist/entry/app.js`，并以它的退出码退出。该进程运行平台适配器、Web UI 宿主、webhook 服务器和所有智能体编排，没有 supervisor 负责重启它。

**`cortex daemon`**

在后台启动 supervisor 并立即返回。命令以脱离终端、不带 stdio 的方式 fork `dist/entry/daemon.js`（守护进程自行把日志写到 `logs/` 下），然后以 0 退出。守护进程把 `app.js` 作为子进程运行，崩溃后按指数退避重启它；触碰 `$STORE_DIR/.restart` 时会排空并重新拉起它。`cortex daemon --version` 打印版本。

**`cortex daemon stop`**

向守护进程发送 SIGTERM，最多等待 10 秒让它退出；超时仍存活的守护进程会被 SIGKILL 结束，命令以 1 退出。守护进程会和它在本机启动的 client（本机 client）一起停止，因此不会留下仍在运行或占用运行时文件的 Cortex 进程；本机 client 未能结束时同样以 1 退出。SSH 机器和自定义命令机器上的 client 继续运行，下次执行 `cortex daemon` 时会重新启动本机 client。守护进程未运行时（包括残留的 PID 文件，会被清理）以 0 退出。

**`cortex daemon status`**

打印守护进程的 PID 和运行时长，以及其 `app.js` 子进程的状态（PID 和运行时长、`starting...` 或 `none`）。

**`cortex daemon restart [--hard | --force]`**

不带标志时触碰重启触发文件，让守护进程排空并重新拉起 `app.js`。`--hard` 直接向 `app.js` 发送 SIGTERM，`--force` 发送 SIGKILL；两种方式下守护进程都会启动新的子进程。没有守护进程在运行时，三种形式都以 1 退出；没有存活的 `app.js` 子进程时，带标志的形式也以 1 退出。

**`cortex daemon restart-self`**

按 `cortex daemon stop` 的方式停止守护进程，再启动一个新的脱离终端的守护进程。

**`cortex restart`**

触碰 `$STORE_DIR/.restart` 处的重启触发文件并打印其路径。运行中的守护进程会排空并重新拉起 `app.js`；没有守护进程在运行时，命令只创建该文件。文件无法写入时以 1 退出。

**`cortex tui [--resume] [--project <id>] [--port <n>]`**

打开连接到运行中服务器的终端聊天客户端。命令检查 TUI 网关是否在 `127.0.0.1:<port>` 上监听，未监听时以 1 退出并提示启动守护进程；否则在终端中运行客户端，并以它的退出码退出。

选项：
- `--resume` — 连接后打开恢复会话的选择器
- `--project <id>` — 在该项目中开启新会话
- `--port <n>` — 网关端口（默认：`$CORTEX_TUI_PORT`，否则为 `3003`）

**`cortex install latest`**

从 npm 更新服务器。命令向 npm 查询 `@cortex-agent/server` 的最新版本；当前安装已是最新时打印 `Already on the latest version`，否则对该版本执行 `npm install -g`，安装到 `CORTEX_NPM_PREFIX`，未设置时安装到当前安装自身的 prefix。之后用 `cortex daemon restart` 重启守护进程。查询或安装失败时以 1 退出。

**`cortex config`**

打印解析后的路径和初始化状态。显示 `INSTALL_ROOT`、所有数据目录，以及 `.env`、`mcp-config.json` 和 `agent-state.json` 是否存在。

**`cortex doctor [--fix] [--json]`**

一次性对整个安装做健康检查并报告问题。默认运行是只读的，任何时候运行都安全。它检查四个方面：

- 运行时与进程——Node 版本、PATH 上的 `git`（Windows 上缺失为失败，其他平台为警告）、PATH 上的 `claude` 可执行文件（缺失为警告；PI 始终通过，因为它在进程内由内置 SDK 运行），以及守护进程是否在运行。
- 后端安装 / 登录——数据目录存在且可写、`.env` 存在、客户端与 webhook token 已设置、`ANTHROPIC_API_KEY` 状态，以及 `agent-state.json`、`models.json` 和 `mcp-config.json` 存在且有效。缺少 `models.json` 为警告；JSON 无效、默认引擎选择无效、收藏数组缺失或无效为失败。它还会对已安装的 PI 运行时及其 `login` 导出做烟测，再从不含凭据的后端认证快照中汇总使用中但已过期或未登录的 provider。这两项检查只产生警告，不会失败。API 模式下，若 gateway 健康但本地没有 key，会报告为由 gateway 托管的说明信息，而不是误报未登录警告。
- 消息平台——解析 `CORTEX_PLATFORM`，并校验每个已启用平台的凭据（Slack `xoxb-`/signing/`xapp-`，飞书 app id/secret）。
- 网关——`~/.aistatus/gateway.yaml` 是否存在，以及对 `http://127.0.0.1:9880/status` 的健康探测。只有在网关实际被使用时，探测才会报告为失败；否则跳过。

每项检查打印 `[OK]`、`[WARN]`、`[FAIL]` 或 `[--]`（跳过），附简短说明，有问题时附修复提示。任一检查失败时命令以 `1` 退出，否则以 `0` 退出；警告不会让运行失败。

选项：
- `--fix` — 只执行安全且幂等的修复：创建缺失的数据目录、创建缺失的 `.env`、生成缺失的认证 token，以及重建 `mcp-config.json`。JSON 报告把它们列在 `fixes` 下。
  它从不删除配置，也不覆盖已有凭据。修复后会重新运行诊断，使摘要反映修复后的状态。
- `--json` — 以 JSON 输出完整报告（各部分、检查项、计数），便于脚本处理。

**`cortex auth status [--json]`**

读取归一化的 Claude Code 与 PI 认证快照。默认文本输出是简洁状态总览；`--json` 返回完整的 `AuthStatusSnapshot`，便于脚本处理。两种输出都不包含凭据值或其片段。

该子命令只读，报告本地凭据状态，不做在线推理验证。本地登录使用 `cortex auth login`。远程登录从 Slack 或飞书中的 `!login` 发起，或在 Web UI 的 **设置 → 账号** 中发起；移动端用户进入 `/m/settings/accounts`。

选项：
- `--json` — 以 JSON 输出完整且不含凭据的状态快照
- `--help`、`-h` — 显示 auth 命令帮助

登录命令、provider 能力规则和过期处理参见 [后端：远程登录](./backends.md#remote-login)。

**`cortex auth login [--backend pi|claude] [--provider ID] [--auth-type oauth|api_key]`**

从交互式终端登录 Provider，无需运行 daemon。省略的选项通过交互方式从该后端支持的 Provider 与认证方式中选择。PI 已内置。Claude Code 已安装时直接复用；缺失时必须确认后，Cortex 才会安装并开始登录。

即使已提供全部选择参数，登录仍要求 stdin 和 stderr 都是 TTY。API key 与授权响应通过隐藏输入提示收集；此命令不接受密钥、token 或授权码参数。浏览器链接与设备授权指引显示在 stderr。非 TTY 登录会立即失败，不启动认证流程；帮助信息无需 TTY。

结果以 JSON 写入 stdout，面向人的提示与错误写入 stderr；不需要也不接受 `--json` 参数。结果不含秘密值。登录成功后同步 gateway/模型配置，并报告同步结果与 `inferenceVerified: false`：凭据已配置，但未经推理测试，也不会发送付费模型请求。

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

**`cortex auth provider <list|add|remove> [options]`**

管理自定义 PI provider——自建或代理的端点，它们没有自己的登录流程。`add` 是 upsert，因此用改过的 URL 或模型列表重新运行，就会原地编辑已保存的定义。

选项：
- `--name <name>` — provider 名称，仅限字母、数字、`-` 和 `_`
- `--api <api>` — 请求协议：`anthropic-messages`、`openai-completions`、`openai-responses` 或 `google-generative-ai`
- `--url <url>` — 上游端点，保存在网关路由中
- `--key <key|->` — 上游 API key；`-` 表示从 stdin 读取，这样它不会出现在 shell 历史中
- `--model <id>` — 该端点提供的模型 id；多个时重复使用
- `--dry-run` — 用于 `remove`：报告将删除的内容，但不删除
- `--json` — 以 JSON 输出结果
- `--help`、`-h` — 显示 provider 命令帮助

```bash
# define a local endpoint that speaks the Anthropic protocol
cortex auth provider add --name my-vllm --api anthropic-messages \
  --url http://127.0.0.1:8100 --model Model-27B

# take the key from a secret store instead of the command line
pass show my-endpoint | cortex auth provider add --name my-proxy \
  --api openai-completions --url https://proxy.example.com/v1 --model small --key -

cortex auth provider list --json
cortex auth provider remove --name my-vllm --dry-run
```

两处写入的内容以及一条定义如何到达 agent，参见 [后端：自定义 provider](./backends.md#custom-providers)。

**`cortex setup-gateway [--dry-run] [--output-dir <path>]`**

从本地配置文件自动检测 Claude Code 和 PI 配置，生成 `~/.aistatus/gateway.yaml`（备份已有文件），并写入 `$CORTEX_HOME/config/models.json`。每当你添加新的 API key 或更换模型时运行此命令。

选项：
- `--dry-run` — 将生成的 gateway.yaml 打印到 stdout 而不写入
- `--output-dir <path>` — 在 `<path>` 下写入 gateway.yaml 和 models.json，而不是默认位置

设置保留已有默认选择并合并收藏，摘要显示默认模型与收藏；修改默认值可用**设置 → 模型**。登录后的同步也保留已有选择，补齐缺失的默认值，并为尚无收藏的新接通 backend/provider 组合添加一个推荐收藏。同步结果包含 `defaultSet` 和 `favorites`。

**`cortex schedule <list|get|add|edit|pause|resume|remove> [<id>] [options]`**

管理定时任务——与 `!schedule` 和 Web UI 管理的是同一批记录。每次触发都会在调度所属项目中新开一个会话并发送消息，见 [调度](./scheduling.md)。变更写入 `schedules.json`，运行中的 daemon 会在一秒内应用。

智能体通过 `schedule` skill 使用此 CLI。对于针对会话所在项目的请求，从会话上下文或 `cortex_context` 解析项目，并显式传入 `--project`；若请求的当前项目缺失，先询问使用哪个项目。CLI 不会从 Bash 环境变量推断会话范围。每日/每周时间使用 daemon 的本地时区（包括 `TZ` 覆盖）；应显式换算用户的时区和星期，并以用户时区报告下次运行时间。调度不支持独立时区，也不会自动做跨时区的夏令时调整。

每个命令都输出带 `ok: true` 的 JSON 和调度本身（`schedule`；`list` 输出 `schedules` 和 `count`），时间戳为 ISO 8601。输入无效时以 1 退出，并在 stderr 列出有效取值。

- `list [--project <id>]` — 列出全部调度，或某个项目的调度
- `get <id>` — 查看一个调度；id 不存在时以 1 退出
- `add --type <type> …` — 创建调度；`--idempotency-key` 命中已有调度时输出 `created: false` 和那个调度。不属于该类型的时间标志会被拒绝
- `edit <id> …` — 修改消息、项目、模型选择、pre-check，或该调度类型对应的时间字段；类型本身固定不变
- `pause <id>` / `resume <id>` — 暂停或恢复周期性调度；重复执行不会改变任何内容
- `remove <id> [--dry-run]` — 删除调度（不存在时输出 `removed: false`）；`--dry-run` 输出 `would_remove`，不删除任何内容

选项：
- `--type interval|daily|weekly|once` — 调度类型（仅 `add`）
- `--interval <duration>` — `interval`：重复周期，如 `30m`、`2h`、`1d`
- `--time <HH:MM>` — `daily`/`weekly`：24 小时制，服务器本地时间
- `--day <day>` — `weekly`：`sun`..`sat` 或 `0`-`6`
- `--delay <duration>` — `once`：从现在起多久后触发；用于 `edit` 时移动触发时间
- `--message <text|->` — 触发会话收到的提示；`-` 从 stdin 读取
- `--project <id>` — 触发会话所属的项目（默认：`general`）
- `--model <[provider/]model>` — 运行所用的模型；PI 可显式使用 `provider/model`。创建时不传模型相关标志则保存配置的默认选择，它可能与当前会话不同
- `--thinking <level>` — 后端原生思考档位。不传模型标志时，创建操作以配置默认选择的副本为基础，编辑操作以调度保存的选择为基础；换模型时省略则使用该模型记住的档位
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

**`cortex memory <regen|consolidate> [--project <name>]... [--text]`**

维护 `$CORTEX_HOME/context/projects/*/` 下的项目记忆（其 `experiments/`、`knowledge/` 和 `patterns/` 目录；见 [记忆](./memory.md)）。`--project` 把运行限制在一个项目，可重复使用；不传时处理所有带记忆目录的项目，未知项目以 1 退出并列出有效名称。

- `regen` — 根据条目 frontmatter 和访问日志重建生成的 `index.md` 文件，从不改动 `EXP`/`K`/`PAT` 条目本身。打印
  `{ ok: true, projects: [{ project, indexes }] }`。
- `consolidate` — 以 `{ ok: true, reports }` 报告矛盾、过期条目、反模式信号和合并候选；`--text` 改为打印可读摘要。

**`cortex feishu <login|status|logout> [--scope <scopes>] [--manual] [--redirect-uri <url>]`**

管理飞书文档工具所代表的飞书用户身份。

- `login` — 用 OAuth 设备流程授权一个飞书账号：命令打印一个 URL 和一个代码，可在任意浏览器中打开。需要 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`。成功后保存用户 token，并向 `.env` 写入 `FEISHU_AUTH_MODE=user`；重启 daemon 后生效。
- `status` — 显示认证模式（`user` 或 `bot`）以及已保存 token 的有效性和过期时间。
- `logout` — 删除已保存的用户 token。

选项：
- `--scope <scopes>` — 要申请的 scope（默认：`$FEISHU_USER_SCOPE`，否则为一组无需应用审核的文档、表格、多维表格和知识库 scope；始终会加上 `offline_access`）
- `--manual` — 使用授权 URL 加粘贴代码的流程，而不是设备流程
- `--redirect-uri <url>` — `--manual` 使用的重定向 URI（默认：`$FEISHU_REDIRECT_URI`）

### 退出码 {#exit-codes}

| 代码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 错误（无效命令、缺少配置、运行时失败） |
| 130 | `init` 或 `auth login` 被取消，或拒绝安装 Claude Code |

`cortex start` 和 `cortex tui` 以它们所运行进程的退出码退出。

---

## cortex-browser {#cortex-browser}

```
cortex-browser [--device <name>] <agent-browser command> [args...]
```

操作调用方会话在 [agent 浏览器](./agent-browser.md)里的那个 tab。Agent 在自己的 shell 里运行它；除 `--device` 外的所有参数都原样交给随 Cortex 固定版本的 [agent-browser](https://agent-browser.dev)，并连到该会话自己的 tab 上。输出和退出码都来自 agent-browser。`cortex-browser skills get core` 打印与所带版本匹配的 agent-browser 命令指南，加 `--full` 列出全部命令和选项。

选项：
- `--device <name>` — 用谁的 Chrome：`server` 或一台已连接的设备。选定后对该会话一直生效（默认：该会话上次用的设备，没有则为 `server`）
- `--help`、`-h` — 显示用法；`cortex-browser <command> --help` 显示单个 agent-browser 命令的用法

每次调用都通过回环 webhook（`http://127.0.0.1:$WEBHOOK_PORT/webhook/browser`，用 `CORTEX_WEBHOOK_TOKEN` 认证）向守护进程要该会话的浏览器。会话取自 `CORTEX_SESSION_ID`（或 `CORTEX_EXECUTION_ID`）。Agent 的 shell 里这三个变量都已设好，因此在那里无需任何配置。`skills`、`help` 和 `--version` 不需要浏览器即可运行。

文件类命令（`screenshot`、`pdf`、`download`、`upload`、`record`、`trace`、`har`、`state` 等）的相对路径，以及 `--screenshot-dir`、`--download-path`、`--baseline` 的相对路径，都按调用方的工作目录解析。

`--cdp`、`--session` 和 tab 绑定由 `cortex-browser` 自己设置；会让调用离开本会话 tab 的参数会被拒绝：`--cdp`、`--session`、`--no-pin-tab`、`--auto-connect`、`--provider`/`-p`、`--namespace`、`--engine` 和 `--executable-path`。`connect`、`install`、`upgrade`、`dashboard`、`mcp` 和 `close --all` 也会被拒绝，并说明原因和替代做法。

如果该会话的 tab 已经不在了（空闲 10 分钟后被关闭，或 Chrome 重启过），这次调用会新开一个空白 tab，在 stderr 上打印一条说明，然后在新 tab 里执行命令。

### 退出码 {#cortex-browser-exit-codes}

| 退出码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | agent-browser 命令失败，或浏览器无法使用：设备未知或离线、Chrome 启动失败、用户正在操作浏览器、守护进程不可达或拒绝了 token。原因和提示写在 stderr |
| 2 | 用法错误（被拒绝的参数或命令、`--device` 缺少设备名），或环境里没有会话 |

连上浏览器之后，退出码就是 agent-browser 自己的。

### 示例 {#cortex-browser-examples}

```bash
# 打开页面并列出可点击的元素
cortex-browser open http://127.0.0.1:5173 && cortex-browser snapshot -i

# 点击快照里的一个 ref，再截图看结果
cortex-browser click @e2 && cortex-browser screenshot ./after-click.png

# 使用用户机器上的 Chrome（它的 localhost、它的登录状态）
cortex-browser --device my-pc open https://example.com

# 查看与版本匹配的命令参考
cortex-browser skills get core --full
```

---

## cortex-evidence-export {#cortex-evidence-export}

```
cortex-evidence-export --input-file <path|->
```

从 `CORTEX_HOME` 下的生产 store 发布不可变的 terminal/composite benchmark evidence v2。命令初始化生产 attempt identity 与 journal store，加载 `data/executions.json`，读取归因后的 cost，再把验证和原子发布委托给 `exportProductionBenchmarkEvidence`。Cortex benchmark arm 始终通过生产服务器运行，每个 trial 是一个 direct session；此命令记录该运行时的 store，不定义第二条编排路径。

Evidence 按 session 与 execution 建键：trial 的 session 打开的每次 run 是一个 attempt，由其 `session_id` 和 `execution_id` 标识；该 session 之后的每次 run 是前一次 run 的 spawn 子节点。

`--input-file` 包含一个 JSON 编码的 `ProductionEvidenceExportInput`；传 `-` 表示从 stdin 读取。参数必须恰好是 `--input-file <value>`，其他形式均为用法错误。所有字段都由 launcher 负责：`outputDirectory`、`trialId`、`rootRunId`、`armName`、`armCanonicalSha256`、`bundleManifestHash`、`proxyExport`，以及可选的 `evaluatedChecks`。发布前会验证 hash、proxy trial identity 和 predicate 结果。输入缺失或格式错误、持久记录不完整，或输出目录已存在时，命令以退出码 `1` fail closed。

```bash
cortex-evidence-export --input-file production-evidence.json
cat production-evidence.json | cortex-evidence-export --input-file -
```

成功时向 stdout 写入一个 JSON 对象：

```json
{"ok":true,"directory":"/evidence/run-1","composite_path":"/evidence/run-1/composite-manifest.json","composite_sha256":"<sha256>","terminal_paths":["/evidence/run-1/execution-root.terminal.json"]}
```

失败时向 stderr 写入 `{"ok":false,"error":"..."}`，且不会发布不完整的目录。只有所有 terminal 和 composite 字节都在隐藏的 staging 目录中完成写入、fsync 和校验后，公开输出路径才会出现。

---

## cortex-hook {#cortex-hook}

```
cortex-hook <list|show|enable|disable|test|ask> [options]
```

检查和操作从内置注册表及 `$CORTEX_HOME/config/hooks/` 挂载的 hook。每个命令都把 JSON 输出到 stdout，错误输出到 stderr。这些命令所作用的注册表见 [Hooks：cortex-hook CLI](./hooks.md#the-cortex-hook-cli)。

- `list` — 所有已挂载的 hook：`id`、`event`、`enabled`、`source`（`builtin` 或 `user`），以及是否有用户文件覆盖内置 hook
- `show --id <id>` — 一条完整声明；id 未知时以 1 退出并列出有效 id
- `enable --id <id> [--dry-run]` / `disable --id <id> [--dry-run]` — 幂等地切换 hook；结果说明是否有内容 `changed`，`--dry-run` 报告 `would_set` 而不写入
- `test --id <id> --payload <file|->` — 以 stdin 传入 payload 运行该 hook 一次，打印其 `exit_code`、`stdout` 和 `stderr`；命令以 hook 自身的退出码退出
- `ask (--question <text> | --payload <file|->)` — 发出一张询问用户的卡片并阻塞到有人回答，然后打印 `{ ok: true, answers }`。`--header`、`--options "a|b|c"`、`--multi` 和 `--level info|warn|warning|error` 用于构造单个问题；`--payload` 接收问题对象组成的 JSON 数组。卡片发到 `--channel`（默认：`$CORTEX_HOOK_CHANNEL`）或 `--session-id`（默认：`$CORTEX_HOOK_SESSION_ID`）所在的频道，hook 的环境中已经带有这两个变量。`--dry-run` 以合成方式完成解析，不发出卡片。见 [从 hook 询问用户](./hooks.md#asking-the-user-from-a-hook)

### 退出码 {#exit-codes_1}

| 代码 | 含义 |
|---|---|
| 0 | 成功，或 `ask` 已得到回答 |
| 1 | 用法或运行时错误 |
| 2 | `ask` 超时且无人回答 |

`test` 以其所运行 hook 的退出码退出。

---

## cortex-signal {#cortex-signal}

```
cortex-signal [--id wp_…] [--secret …] [--status ok|fail|progress] [--message TEXT] [--exit-code N]
```

告诉 Cortex：它在等的那件事结束了。不带参数运行时打印用法。Agent 先用 `wait_create` MCP 工具登记一个 waitpoint 并结束自己那一轮，这个命令解决该 waitpoint 并唤醒对应 session。完整说明见 [waitpoints.md](./waitpoints.md)。

`--id` 和 `--secret` 默认取 `$CORTEX_SIGNAL_ID` 和 `$CORTEX_SIGNAL_SECRET`，所以通常的接入就是两行：先 export 一次，再追加一条命令。

选项：
- `--id <wp_…>` — waitpoint id（默认：`$CORTEX_SIGNAL_ID`）
- `--secret <hex>` — 随该 waitpoint 一起签发的能力凭证（默认：`$CORTEX_SIGNAL_SECRET`）
- `--status <s>` — `ok`、`fail` 或 `progress`（默认：`ok`）。`ok`/`fail` 是终态：计入 quorum 并唤醒会话。`progress` 只记录心跳，不结算任何东西，**也不唤醒任何人**——两者的区别完全在于“这件事值不值一个 turn”
- `--exit-code <n>` — 由命令退出码推导状态（0 为 `ok`，其余为 `fail`），消息默认为 `exit=<n>`
- `--message <text>` — 一行摘要，显示在唤醒消息里
- `--member <name>` — 多任务 waitpoint 中这条信号属于哪个成员
- `--data <@file|-|text>` — 来自文件、stdin 或字面文本的附加载荷；它以数据身份到达 agent，绝不作为指令
- `--url <url>` — 守护进程 signal 端点（默认：`http://127.0.0.1:$WEBHOOK_PORT/webhook/signal`）
- `--no-spool` — 守护进程不可达时直接失败，不落盘
- `--help`、`-h` — 显示用法

该端点只监听回环，并且**不**接受 `CORTEX_WEBHOOK_TOKEN`：每个 waitpoint 的 secret 是唯一凭证，而它除了解决自己那一个 waitpoint 之外什么都做不了。要从别的机器发信号，就在那台机器的 `~/.cortex/tmp/signals/` 里放一个 JSON 文件——见 [waitpoints.md](./waitpoints.md#on-another-machine)。

### 落盘缓冲 {#spooling}

守护进程不可达时，信号会写到 `$CORTEX_HOME/tmp/signals/<name>.json`（先写 `.tmp` 再重命名，因此半截文件永远不会被读取），命令仍然以 0 退出。守护进程会在下一次 sweep 时收走该目录中的信号，因此重启期间发出的信号只是延迟，不会丢失。`--no-spool` 关闭这一行为，改为以 1 退出。

### 退出码 {#exit-codes_2}

| 代码 | 含义 |
|---|---|
| 0 | 已接受、已落盘，或该 waitpoint 早已被解决 |
| 1 | 被拒绝（secret 错误、id 未知、被限流），或带 `--no-spool` 且不可达 |
| 2 | 用法错误（缺少 id/secret、未知标志、缺少取值、`--status` 或 `--exit-code` 非法、`--data` 文件无法读取） |

早已被解决的 waitpoint 故意以 0 退出：重试的脚本不应把“别人已经报过了”当成失败。

### 示例 {#examples}

```bash
# Report the exit code of the command that just ran
export CORTEX_SIGNAL_ID=wp_1a2b3c4d5e6f CORTEX_SIGNAL_SECRET=…
python train.py; cortex-signal --exit-code $?

# Report one arm of a multi-job waitpoint
cortex-signal --member arm2 --status ok --message "33,120 steps"

# Attach the tail of a log as data
python train.py; s=$?; tail -c 2000 train.log | cortex-signal --exit-code $s --data -

# Heartbeat without waking anyone
cortex-signal --status progress --message "epoch 12/40"

# Signal when a process that is already running exits
(while kill -0 12345 2>/dev/null; do sleep 5; done; cortex-signal --status ok) &
```
