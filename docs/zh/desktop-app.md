# 桌面与 Android 应用 {#desktop-and-android-apps}

Cortex 提供面向 Linux、macOS、Windows 与 Android 的 Tauri v2 原生壳。桌面端使用三栏工作台，Android 使用针对手机设计、以会话列表和侧滑项目面板为主的界面。两者都通过 Web UI HTTP 传输直连 Cortex 服务器，并与浏览器工作台共享项目、会话、审批、文件和记忆。

原生应用需要可访问的 Web UI 端点和一次性配对码（或服务器的 `CORTEX_CLIENT_TOKEN`）。浏览器访问采用独立的 Cloudflare Access 路径，详见[浏览器访问](browser-access.md)。

桌面应用既可以在自己运行的这台电脑上安装 Cortex 服务端，也可以连接到已有的服务端。首屏会询问选择哪一种，本机安装无需终端：安装软件包、写入配置、启动 daemon 并完成连接。Android 只支持远程连接，因为它没有运行 Node 进程的位置。

## 安装 {#installation}

对于包含原生安装包的 server release，可从 [GitHub Releases 页面](https://github.com/fangxm233/cortex-agent/releases)下载对应平台附件。Release policy 要求原生 UI 与对应 server release 使用完全相同的 CalVer，格式为 `YYYY.M.D[-N]`。应用内嵌版本和附件文件名中的版本必须与 `server-v<version>` tag 一致。

| 平台 | 原生 release 安装包 | 安装方式 |
|---|---|---|
| Linux x86_64 | AppImage、DEB 或 RPM | 对 AppImage 执行 `chmod +x` 后直接运行，或安装对应发行版软件包。 |
| Windows x86_64 | NSIS `setup.exe` | 运行安装程序，然后从开始菜单启动 Cortex。 |
| macOS Apple Silicon | `macOS-aarch64` DMG | 打开 DMG，将 Cortex 拖入“应用程序”。 |
| macOS Intel | `macOS-x86_64` DMG | 打开 DMG，将 Cortex 拖入“应用程序”。 |
| Android arm64 | 已签名 APK | 打开 APK；Android 提示时，允许当前文件来源安装应用。 |

Linux AppImage 运行时需要 WebKitGTK 与 GTK。Ubuntu 和 Debian 用户可安装常见运行库：

```bash
sudo apt-get install libwebkit2gtk-4.1-0 libgtk-3-0
```

Windows 10 和 11 通常已包含 WebView2。如果 Cortex 报告缺少 WebView2，请先安装 Microsoft Evergreen WebView2 runtime。没有 Authenticode 证书的 release installer 也可能触发 Microsoft Defender SmartScreen 警告；选择运行前应核对发布者与 release checksum。

没有 Developer ID 证书的 macOS 安装包使用 ad-hoc 签名，但未经过 notarization。Gatekeeper 可能阻止首次普通双击启动。可在 Finder 中对 Cortex 使用一次**打开**操作，或在**系统设置 → 隐私与安全性**中批准。Ad-hoc 签名可校验 bundle 结构，但不提供受信任的发布者身份。

Android APK 面向 arm64 设备，并通过 Play Store 之外的方式分发。因此，Android 会要求允许用于打开 APK 的浏览器或文件管理器安装未知来源应用。

## 从应用内安装服务端 {#installing-a-server-from-the-app}

在首屏选择**安装 Cortex**并等待完成。安装无需终端、Homebrew、Command Line Tools 或管理员权限。界面仅显示简短进度，**查看运行日志**是折叠的排查入口。安装失败时，按提示处理并选择**重试**。安装期间的**取消**只停止当前安装步骤，不停止已有服务端，也不会撤销已经安装的文件。

每个桌面安装包都自带本机服务端所需的运行环境：对应平台的官方 Node.js 24，Windows 安装包另含带 Git Bash 的 Git for Windows（PortableGit）。安装时将它们解压到 `~/.cortex/runtime` 下按版本命名的目录，再用其中的 npm 把 Cortex 服务端包安装到私有 prefix `~/.cortex/runtime/prefix`。只有服务端包，以及你选择安装的 Claude Code，从 npm registry 获取；npm 沿用你 `.npmrc` 中的 registry、代理和凭据设置。安装不修改全局 npm 设置，也不使用、不改动电脑上已有的 Node.js、npm、Git 或 `cortex`。服务端会自行让新开的终端窗口可以使用 `cortex` 命令，详见[在终端中使用 cortex](#using-cortex-in-a-terminal)。

本机服务端始终运行在自带的运行环境上。运行环境目录缺失或损坏时，应用会在安装过程中，或在启动时拉起 daemon 之前重新解压。已保存的服务端安装无法运行或低于应用要求的版本时，会重新安装到私有 prefix。如果启动时 daemon 未响应且服务端安装已不存在，应用会打开安装界面，重新安装服务端并连接到已有配置。Windows 上 Cortex 用自带的 Git Bash 执行 shell 命令。macOS 与 Linux 上 Git 为可选项，安装流程不会安装它；Git 版本历史与 Git 来源的扩展需要 Git。

自带的 Node.js 决定了本机安装支持的系统：macOS 13.5 及以上、glibc 2.28 及以上的 x86_64 Linux，以及 x86_64 的 Windows 10 或 11。其他系统仍可连接已有服务器。

安装后会自动继续初始化、启动服务端并连接。全新安装使用本机 hostname、端口 3004，不安装登录自启服务，并添加 `cortex` 终端命令；正常流程没有机器设置页，也无需点击**启动 Cortex**确认。界面始终以一行安装进度展示，技术细节收在**查看运行日志**中。全新安装随后进入 `/setup/providers` 的 Provider 设置页，登录并选择默认模型 后再进入工作台。Cortex 已内置 PI，安装时不询问后端选择。

初始化、启动或连接失败时，**重试**复用原设置；**修改设置**打开修复表单，从此表单再次启动时可重启本地服务端，以应用明确选择的端口。自动设置会保留正在响应的服务端。安装失败只提供重试，不显示机器设置。

本机安装属于原生应用及其内置的设置页；更新 Web 前端或替换 `web/dist` 不会改变它。

本地开发时，可将 `CORTEX_SETUP_SERVER_PACKAGE` 设置为本地打包 `.tgz` 的绝对路径，再启动原生应用。安装器通过 npm 安装该包，并检查其报告的版本是否达到最低要求；这一操作不会发布软件包。全新安装测试应使用独立的 home、npm prefix、凭据存储和网络。

安装步骤不询问 Slack 或飞书：应用本身就是交互界面，没有消息平台的服务端使用内置 gateway 运行。Provider 登录和默认模型 在服务端连接成功后配置。

已有 Cortex 配置的机器会保留机器身份和服务设置。自动设置会开启本地连接端点，不覆盖已配置的端口，也不重复初始化；即使已有安装可用，也会检查已保存的安装，使后续启动使用同一运行环境。已有安装及连接直接打开工作台，除非全新本机安装仍有未完成的 Provider 设置。

应用启动时若发现本机服务端未响应，就会启动 daemon。**登录系统时自动启动**会在你登录系统时同样启动它，使定时任务在应用关闭时也能触发。全新安装默认关闭；可在安装后的 Provider 设置页、**设置 → 高级**或修复表单中开启。Linux 上应用注册 systemd user unit，macOS 上注册 launchd agent，均在下次登录时生效，不会替换当前运行的 daemon。Windows 上应用在启动应用中添加一项 **Cortex**：登录时以无窗口方式打开应用、启动服务端后退出；任务管理器的**启动应用**中也会列出它，可在那里关闭。各平台都不需要管理员权限。应用每次启动都会让自启注册指向当前使用的运行时和程序，更新换了内置 Node.js 或应用位置后，从下次登录起生效。关闭开关只撤销注册，不影响正在运行的服务端。通过命令行 `cortex init` 设置的登录服务显示为只读，仍由命令行修改。自动设置不会创建或修改登录自启服务，已有服务设置保持不变。

若不使用向导，在已有安装上开启端点只需一条命令：

```bash
cortex ui enable
```

它会在需要时生成客户端 token，设置 `CORTEX_UI_HTTP` 与 `CORTEX_UI_PORT`，并把应用的 origin 合并进 `uiCorsOrigins`。当它提示配置已改变时，重启 daemon 生效。随后 `cortex ui pair` 会为第一个应用打印一次性配对码（见[首次连接](#first-connection)）。[服务器配置](#server-configuration)一节说明如何手工完成同样的设置。

### 在终端中使用 cortex {#using-cortex-in-a-terminal}

从应用运行环境启动的服务端，每次启动都会检查终端启动器。启动器缺失时，它会自行执行 `cortex path install`。全新安装由此获得该命令，已有安装在服务端更新后也会获得。该命令在 `~/.cortex/runtime/bin` 中写入 `cortex`、`cortex-signal`、`cortex-hook` 和 `cortex-evidence-export` 的启动器。每个启动器都用自带的 Node.js 运行已安装的服务端，因此终端本身不需要装 Node.js。之后新开的终端，`PATH` 中都会包含该目录：

- **Linux 和 macOS：** 以 `# >>> cortex >>>` 标记的块位于 `~/.profile` 末尾，正在使用的 shell 对应的 `~/.bash_profile` 和 `~/.zshenv` 末尾也有。同样的块位于 `~/.bashrc` 开头，因此 `ssh host cortex …` 也能用。不配置 fish，请用 `fish_add_path ~/.cortex/runtime/bin` 自行添加。
- **Windows：** 该目录在用户 `Path` 中，命令提示符、PowerShell 和 Git Bash 都会读取。

服务端用另一个版本的自带 Node.js 启动时（例如应用更新后），会相应改写启动器。`cortex path status` 显示启动器及其登记位置。`cortex path remove` 删除启动器，并把该目录从 `PATH` 中撤下。这次移除会记录在 `~/.cortex/runtime/terminal-cli.json` 中，在再次执行 `cortex path install` 之前，服务端不会重新添加该命令。修复表单中的**在终端中使用 cortex 命令**开关会执行这两条命令之一。

agent 会话不依赖这些设置。服务端会把自己的 `node`、`cortex` 和 `cortex-signal` 放进它启动的每个会话的 `PATH`，所以即使关闭终端命令，skill 和 waitpoint 命令照常可用。添加失败时，服务端会记录错误，并在下次启动时重试。修复表单中的开关打开时，安装界面也会给出提示。

## Provider 设置 {#provider-setup}

![Model providers：已连接的 OpenAI Codex 登录，以及可添加的 provider 目录](../images/ui/provider-setup.png){ width="640" }

Provider 设置页**接入 Provider**自上而下依次是：**Claude Code** 卡片、**模型 provider** 卡片、**默认模型**，以及可选的排行榜卡片。**模型 provider** 把已检测到凭据的 provider 列在**已连接**下，其余列在**添加 provider**下：搜索框下面是两列网格，先是**常用**分组，再是**更多 provider**。选择 Provider 及其支持的 OAuth 或 API key 认证方式，即可打开与**设置 → 账号**共用的登录弹窗。PI 无需单独安装。OAuth 可能打开浏览器并要求授权或 MFA，登录不保证全程留在应用内。

**Claude Code** 是可选项，与 PI 中的 Anthropic Provider 相互独立。在本机桌面初始化中，点击**安装并登录**即授权在这台电脑上安装 Claude Code，成功后打开登录流程。这是初始化过程中唯一提供 Claude Code 安装的步骤；已有 Claude Code 安装会被直接复用。

凭据检测不等于在线推理测试：设置过程不会发起付费推理请求，也不保证模型调用一定成功。即使运行时已安装，凭据缺失、过期或状态未知仍需处理。

登录后，页面刷新凭据并同步网关与模型配置。重新扫描也可读取在其他位置配置的凭据。尚未设置默认模型时，同步会使用推荐模型；每个新接通的 backend/provider 组合若还没有收藏，会加入一个推荐模型。已有默认值与收藏保留。首次设置需要从匹配已配置账号的收藏中选择默认模型，才能进入工作台；仅完成登录还不够。

可选的**公开用量排行榜**卡片会把你的 token 用量放到 [aistatus.cc 公开排行榜](https://aistatus.cc/leaderboard)上，排行榜显示你的名称、组织和 token 数。除非你已经加入，否则卡片处于关闭状态。开启后填写名称和邮箱（组织可选），再点击**保存**；邮箱只用于识别身份，不会公开显示。这张卡片不影响**进入工作台**或**稍后配置**，同一卡片也保留在**设置 → 用量**中。

其下的**登录系统时自动启动**与**设置 → 高级**中的是同一个开关，只在服务端由本应用安装时出现。**帮助我们改进 Cortex** 开关就是服务端的匿名遥测设置，与**设置 → 隐私**中的是同一个。发送哪些内容见[遥测](telemetry.md)。

配置就绪后选择**进入工作台**，或选择**稍后配置**跳过。跳过警告会说明：在完成**设置 → 账号**与**设置 → 模型**前，Agent 可能暂不可用。

全新本机安装连接成功后，若在此页退出应用，再次打开会继续 Provider 设置，即使尚未登录。仅完成登录不会结束设置。**进入工作台**或主动选择**稍后配置**都会先保存选择，再离开页面；之后启动将打开工作台。若保存失败，请留在此页重试。未记录待完成设置的旧安装与远程连接保持原有启动行为。

## 服务器配置 {#server-configuration}

原生壳连接服务器上主动启用的 Web UI 端点。端点本身属于启动拓扑，仍留在服务器的 `$CORTEX_HOME/config/.env` 中：

```bash
CORTEX_UI_HTTP=1
CORTEX_UI_PORT=3004
```

允许的 CORS origin 是运行时设置。在 `$CORTEX_HOME/config/settings.json` 中添加或确认 `uiCorsOrigins` 键（见 [configuration.md](./configuration.md#configsettingsjson)）：

```json
{
  "uiCorsOrigins": [
    "cortexui://localhost",
    "http://cortexui.localhost",
    "tauri://localhost",
    "http://tauri.localhost"
  ]
}
```

`.env` 中逗号分隔的旧变量 `CORTEX_UI_CORS_ORIGINS` 仍作为已弃用的回退被读取。

`cortex init` 会在 `.env` 中生成 `CORTEX_CLIENT_TOKEN`。不用配对码、直接用客户端 token 连接的应用使用这个值；`CORTEX_TOKEN` 不是服务器端客户端 token 的配置名。可用以下命令读取已配置的 token：

```bash
grep CORTEX_CLIENT_TOKEN "${CORTEX_HOME:-$HOME/.cortex}/config/.env"
```

在 `.env` 中更改端点后需重启 daemon。改动 `uiCorsOrigins` 则无需重启——它在每个请求时解析。原生应用连接能够到达该端点的 HTTP 或 HTTPS URL。通过隧道暴露端点时，应使用可直接接受 Cortex token 的 hostname，而不是要求交互式浏览器 SSO 的地址。

当前构建通过 `cortexui` custom protocol 提供原生壳；根据 WebView 平台，origin 表现为 `cortexui://localhost` 或 `http://cortexui.localhost`。两个 `tauri` origin 用于保持旧版原生应用可连接。服务器只为 `uiCorsOrigins` 中明确列出的 origin 返回 CORS header。

## 首次连接 {#first-connection}

在首屏选择**连接已有服务器**，然后输入包含 `https://` 或 `http://` 的服务器 URL，并在**配对码或客户端令牌**中填入配对码。配对码可在任一已登录设备的**设置 → 机器 →「已连接的 App」→「连接新设备」**中获取，或在服务器上运行 `cortex ui pair`（也可以在聊天里让 Cortex 运行）——第一个设备通常这样接入。配对码 10 分钟内有效、只能用一次；把配对链接（`https://<server>/#pair=<CODE>`）粘贴到地址栏会同时填好两个字段。连接时，应用用配对码换取自己的设备 token 并保存。同一字段也接受完整的 `CORTEX_CLIENT_TOKEN`。用配对码点**测试连接**只检查服务器是否可达，不会用掉配对码；用客户端 token 时，测试会区分端点不可访问和 token 未授权。连接成功后，应用打开工作台并保存凭据，供后续启动使用。

用配对码连接的应用会出现在每个已登录设备的**设置 → 机器 →「已连接的 App」**中，并显示配对时间和最近使用时间。**撤销**会让应用立即断开，它需要新的配对码才能重新连接。详见[配对码与已连接的 App](browser-access.md#pairing-codes-and-connected-apps)。由向导安装的服务端会跳过此界面——它使用自己生成的凭据直接连接。

应用把连接保存为自身数据目录中的 `connection.json`：macOS 为 `~/Library/Application Support/dev.cortex.desktop`，Linux 为 `~/.local/share/dev.cortex.desktop`，Windows 为 `%APPDATA%\dev.cortex.desktop`，Android 为应用私有存储。macOS 和 Linux 上该文件仅当前用户可读。执行 Disconnect 会删除该文件并返回连接界面。

## 桌面工作台 {#desktop-workbench}

![桌面工作台：项目栏、带决策卡和结果图的聊天，以及停靠栏中的看板](../images/ui/hero-light.png)

桌面应用与浏览器使用同一个工作台。左侧导航栏列出项目和项目范围内的会话，并提供当前项目的 Overview 入口。中间区域包含对话、流式智能体输出、工具活动、附件、问题卡片与计划审批。对话左侧有一条细导航条，为会话中的每条提问标出一个刻度。指针沿导航条移动时，附近的刻度会随距离伸长，指针所在的那条弹出预览卡显示当时问了什么，点击即可把转录滚回该处。当前视野内的每个 turn 刻度都保持高亮，无论屏幕上显示的是它的开头、结尾还是全部。

智能体的每个回合由三部分组成：工作过程、答案和这个回合的产出。工具调用、思考、简短的中间播报和子智能体收成答案上方的一行，例如「处理了 3分20秒 · 49 次工具调用 · 1 个子代理」，点击后按顺序展开。回合进行中，这一行显示**正在处理**并保持展开；正在生成的文字已经位于答案的位置，若其后又调用了工具，它就是中间播报，会并入工作过程。需要读者看到或处理的内容始终可见：计划和提问卡片（处理后收成一行）、通知、智能体发送的文件和决策、打开的看板、启动的 worker、设置的等待点，以及明显写给读者的长段说明（含标题、表格或多段文字）。回合进行中，工作开始之后出现的这些内容留在展开的工作过程里、它们发生的位置，工作过程按时间顺序排列，只有正在生成的文字在它下方；回合结束、工作过程折叠后，它们显示在折叠行下方。新回合从你的消息、lead 发给 worker 的消息，以及唤醒智能体的系统回合开始——等待点的信号、worker 的汇报或提问，或在回合结束后才返回的后台智能体结果；限流后的恢复、或在回合进行中并入的后台结果，属于同一段工作。**设置 → 外观 → 对话中的工作过程**可以让每个回合的工作过程始终展开。回合已结束但会话尚未完成时，对话末尾会说明原因：后台任务仍在运行（完成后智能体自动继续），或正在等待某个等待点；回合中的等待点那一行在信号以新回合的形式到达前显示「等待中」。

模型返回的思考与回答分开显示，默认折叠。独立的**思考**行预览首行，点击可阅读全文；紧邻工具调用的思考留在同一个折叠组内，收起时计为「思考」，展开后按原顺序排列。流式生成时，**思考中…** 显示最新一行，完整内容到达后由保存的行替换。桌面、浏览器和手机聊天使用同样的展示方式。Claude 提供思考摘要，PI 提供 provider 公开返回的文本；空内容、脱敏内容和子智能体思考不显示。Slack、飞书与终端不显示思考。服务器设置 [`showThinking`](configuration.md#keys) 控制采集；已保存的思考在刷新后保留，过去未采集的内容不补回。

对话标题栏显示会话标题；主会话在这里还有团队胶囊，绑定了看板的会话还有看板胶囊（[团队模式](team.md#in-the-workbench)、[看板](team.md#boards)）。Notes 按钮（⌘⇧N）会在标题栏下方展开私人笔记卡片，不会挡住底部输入框。输入框正上方的一排胶囊显示会话正在做什么：智能体的任务清单（进度环加当前项），以及它在 Cortex 之外等待的事。任务清单还有未完成项时胶囊一直在；清单全部完成、这一轮结束后胶囊就消失。每个胶囊点开后以弹出卡片显示详情，输入框位置不变。手机端这一排还包括主会话的团队和绑定的看板；每个胶囊都用文字写明自己是什么（「任务 3/7」「2 个 worker」「看板」），点开是底部弹层。手机聊天页的标题栏用平实的话说明会话在做什么，例如「运行中 · 1分12秒 · 2 个 worker」或「计划等你批准」，上下文用量以一个像饼图一样填充的小表盘显示在发送键旁。点击输入框下方的状态行会打开**会话统计**：运行次数、agent 轮数、活跃时长、总花费，以及其中子智能体花费的部分。

输入框的引擎选择器在根层按 backend/provider 分组列出收藏模型及其记住的思考档位。完整模型列表每行的星标可收藏或取消收藏，思考档位包含使用后端默认值的选项。**设置 → 模型** 管理默认模型和收藏；定时任务编辑器选择模型与思考档位。选择规则见[后端](./backends.md#per-session-model-thinking-level-and-route)。

在输入框中输入 `/` 会打开斜杠面板：`/new`、`/cancel`、`/compact`、`/model`、`/settings` 和 `/usage`，后面是当前会话可加载的技能。用方向键移动，按 Enter 或 Tab 选中。输入框的 **+** 菜单可以添加附件、列出同样的命令，并为新会话设置**浏览器**控制：agent 会获得操控 Chrome 的工具，Chrome 可以运行在服务器上（**本机**），也可以运行在某台已连接的设备上，此时窗口出现在那台机器的屏幕上，并带有该浏览器配置里已有的登录状态。浏览器控制要在会话发出第一条消息之前选定，因为 agent 的工具在启动时就已固定；选定后，设备名以标签形式显示在输入框中。

顶栏的机器按钮显示已注册机器中有多少在线，例如 `2/3`；旁边服务器图标上的圆点在全部在线时为绿色，部分离线时为琥珀色，全部离线时为红色。点击它，或选择**视图 → 机器**，会打开**机器**菜单：顶部写明几台在线，下面每台机器一行——状态圆点（在线为绿点，离线为空心圆环）、名称和上次心跳，再一行写 GPU、操作系统和已连接时长。展开一行会在菜单打开期间实时探测这台机器：先以对齐的细条显示 CPU 负载、内存和剩余磁盘，再为每块 GPU 显示一行利用率和温度，下面写显存、功耗和进程数；点这一行可展开占用最多的进程。这一行最后是运行时长。离线机器显示「离线 — 无实时数据」。**管理 ›** 打开**设置 → 机器**。Android 上，**机器**是一个 drill-in 页面，每台机器一张卡片，主机指标与桌面相同，并有 GPU 表格。

![Machines 菜单中展开的一张机器卡片：CPU、内存、磁盘和逐 GPU 网格](../images/ui/machines.png){ width="480" }

右侧停靠面板（**视图 → 停靠面板**，`⌘J` 或 `Ctrl+J`）以标签页的形式在对话旁边放置停靠的文件预览、看板、网页和 agent 浏览器。每个会话有自己的一套标签页，停靠面板的开关也各自记住：选中另一个会话时，停靠面板换成那个会话的标签页，切回来时一切如旧。右键标签页选择**固定标签页**，它就会出现在所有会话里：固定的标签页排在标签栏最前，关闭按钮换成图钉，点图钉取消固定，同一个右键菜单也可以关闭它。从看板打开某个会话时，看板也会在那个会话的停靠面板里打开。**Agent 浏览器**标签页实时显示某个会话的 agent 正在操作的页面，并且可以接管，详见 [Agent 浏览器](agent-browser.md)。网页标签页接受端口号或 URL。它的**端口**列表显示服务器或已连接设备上正在监听的端口；桌面应用会通过需要 token 认证的 `/forward` 隧道转发所选端口，于是远程机器上的开发服务器可以像本地一样打开。浏览器无法转发，会把这些端口当作普通的 `localhost` 地址打开。

连续的工具调用折叠成一行，说明它们做了什么——例如「运行了 6 条命令 · 编辑 parser.ts · 调用 send_decision」——展开后每次调用一行，显示其命令或路径。调用之间的思考属于同一行，紧跟在调用之后、仍在生成的思考也是如此。这一行就是智能体当前正在做的事时，行末显示正在进行的步骤——「正在运行 pnpm test」「正在读取 parser.ts」「正在思考」——每换一步，文字滚动切换。结果中带回图片的调用——对图片文件的 `Read`、PI 的 `read`、`remote_read`，或任何返回图片的 MCP 工具——单独成行，显示为「读取了 N 张图片」：相邻的读图调用合为一行，各行按调用发生的顺序排列，读图与其他工具交替调用时也交替显示。展开后逐条列出这些调用，图片显示在各自调用下方，高度不超过 120 px；点击图片会在媒体查看器中打开。读取类调用的图片以所读文件命名。这一行只展示模型实际收到的内容：不支持图片输入的 PI 模型不会收到工具返回的图片，这类调用留在普通工具行中。移动端对话和子智能体块显示同样的行。图片保存在 `$CORTEX_HOME/tmp/tool-images/<session id>/` 下。

桌面和手机聊天页顶部的 **⋯** 菜单提供**添加星标／取消星标**、**重命名**和**会话 ID**。**会话 ID** 显示会话的稳定 ID 和后端自己的 UUID，各带一个复制按钮；**编辑 → 复制会话 ID** 可直接复制前者。桌面会话列表中，鼠标悬停某一行时，其时间会换成 **⋯** 菜单，可直接操作该会话而不切换当前对话；键盘聚焦也可显示此入口。每个项目的会话列表内有可折叠的**星标**栏；添加星标会把会话移入该栏，取消后回到原分组，没有星标时隐藏空栏。名称与星标保存在服务端。重命名只修改显示标题，不改变会话 ID；标题不能为空，最多 60 个字符。

项目 Overview 中的执行条目会打开带实时日志和取消控制的 drawer。在 macOS 上按 `⌘K`，或在 Linux 与 Windows 上按 `Ctrl+K`，可打开命令面板，用来搜索命令、页面、会话、看板和正在运行的 agent 浏览器。**帮助**菜单包含**文档**、**反馈问题**（打开 GitHub issue 页面）、**守护进程状态**、**检查更新**、**开发者工具**和**关于 Cortex**。

对话中的代码块在指针悬停时显示复制按钮；触屏设备上该按钮常驻显示。在 Windows 上，通过 `Ctrl+C`、右键菜单或复制按钮在应用内复制的内容，会像其他应用的复制一样出现在剪贴板历史（`Win+V`）中。WebView2 从自己的浏览器进程写入这些内容，Windows 不会把它们记入历史，因此应用壳会以自身窗口重新写入同一份数据。写入方标记为不记入历史的内容仍保持排除（`desktop/src-tauri/src/clipboard_history.rs`）。

### 插件设置 {#plugin-settings}

**设置 → 插件**列出当前连接的 Cortex 服务器上的全部插件，包括内置插件和你自己的插件，并可直接编辑。插件和技能带有**内置**、**本机**或**已修改**标记。插件的**概览**页显示它的 portable 或 legacy 格式、manifest 元数据、位置、校验问题，以及使用它的执行环境。**技能**页可打开并编辑每个技能的 `SKILL.md`，并提供**新建技能**、**移动或重命名**和**删除**。保存内置技能时，你的版本会替代内置版本，**还原为内置版本**可恢复随安装附带的那一份；内置技能不能移动或删除，内置插件不能删除，但可以按执行环境关闭。**MCP** 页编辑 portable 插件根目录 `mcp.json` 中的 server（**添加 server**、传输方式、命令或 URL、环境变量和 headers）；已保存的密钥保持隐藏，除非点击**替换**，否则保留原值。**新建插件**、**删除插件**和**转换为可移植格式**用于管理整个插件。桌面壳与浏览器渲染同一个由服务器提供数据的 SPA，因此不另外维护本地插件目录（`web/src/features/settings/panels/PluginsPanel.tsx`）。

**设置 → 环境**编辑[执行环境](./configuration.md#execution-environments)，分为四个标签页：**内容**、**校验**、**插件**和**系统提示词**。插件页为该环境分配插件。加入至少含一个有效、已盘点 `mcp.json` server 的 portable 插件时，必须先确认才能保存；分配改动尚未保存时，切换页面和关闭设置窗口都会被阻止。如果编辑期间服务器数据发生变化，页面会保留草稿并标记为过期，重置后才能继续保存。系统提示词页会替换该环境的完整系统提示词，对新会话生效；它会写明提示词保存在哪个文件中，在其他环境也使用同一文件时给出提醒，并提供**恢复默认**。包格式、运行时行为与可信代码边界见[技能与插件](./skills-and-plugins.md)。

如需切换服务器，打开 daemon 或连接状态，选择 **Disconnect**，然后在连接界面输入新的端点和 token。

## 桌面与浏览器通知 {#desktop-and-browser-notifications}

**设置 → 通知 → 系统通知 · 本设备**控制本设备的通知，默认开启。浏览器权限独立管理：点击**允许通知**申请授权。浏览器需要 HTTPS 或 localhost，以及受支持的 Notifications API；拒绝后需在浏览器的网站设置中放行。

桌面应用或浏览器页面运行且保持连接时，回复完成、会话开始等待你回答或审批，以及系统消息，会在窗口隐藏或失去焦点时使用操作系统通知。前台保留站内提示，正在查看的会话不额外提醒。团队 worker 两种提醒都不发，由其主会话的回复提醒（[团队模式](team.md)）。关闭系统通知、缺少权限或发送失败时，仍保留站内提示。

点击会话通知会恢复并聚焦应用或浏览器页面，打开对应会话；不带会话的系统消息只聚焦窗口。桌面点击跳转需要安装包内的原生通知桥，单独更新前端不能给旧壳增加此能力。切换服务器会使旧连接的待处理桌面通知目标失效。

桌面和浏览器通知要求应用或页面保持运行，关闭后停止投递；多个浏览器标签各自接收事件。系统通知设置、勿扰模式，以及 Linux 的通知服务和窗口管理器可能限制通知展示、点击动作或窗口聚焦。部分手机浏览器不支持页面创建通知，继续使用站内提示。Android 使用下文所述的独立后台服务。

## Android 界面 {#android-interface}

![Android 应用：会话列表、带决策和 worker 的主会话，以及等待批准的计划](../images/ui/mobile-strip.png)

Android 首页是当前项目的会话列表，分为**需要你**（有提问或计划在等你）、**进行中**（运行中、后台任务未结束或在等信号）和**最近**三段，星标会话单独一段放在最上面。每行用状态点表示状态，依次显示标题、正在做什么和最近运行时间；右下角是**新会话**按钮。在列表任意位置向右滑动，项目面板会从左侧滑出，里面有当前项目的预算、审批、问题、笔记和记忆，可以切换到其他项目，还有用量和设置按钮。面板跟随手指移动，松手时按滑动的距离或速度决定展开还是收起；以竖直方向为主的滑动则照常滚动列表。向左滑、点击变暗的列表或按返回键都会关闭面板。左上角的 Cortex 标志也能打开面板，有待你处理的审批时，标志旁会显示琥珀色的数量。会话聊天、计划阅读、审批、问题、笔记、记忆文件、机器、设置、hooks 与 daemon 状态以 drill-in 页面打开；从面板打开的页面返回时，会回到展开的面板。Android 返回操作会先关闭 overlay，再沿应用导航栈返回。

授予通知权限后，**设置 → 通知 → 本设备后台通知**可启用 Android 原生后台连接，页面切到后台后仍继续监听。一条静默常驻通知显示跨项目运行中的 direct session 数量，包含后台延续任务；数量为零时显示后台通知已连接，断线重连时明确显示状态暂不可用，不保留假实时数字。关闭这个本设备开关或断开服务器连接会停止服务并清理相关通知（`desktop/tauri-plugin-cortex-notifications/android/src/main/java/dev/cortex/notifications/NotificationService.kt`；`Reconciler.kt`）。

待回答问题和待审批计划各自发出通知。会话通知点击后打开对应对话，冷启动也可恢复目标；审批中心条目则打开审批页面并选中条目。原生端保存点击目标，直到页面处理完成，并在重连及定期刷新时核对待处理请求。锁屏通知隐藏私密内容。后台连接要求 HTTPS，仍受 Android Doze、厂商省电策略、网络及用户强制停止影响，不能保证强制停止后继续送达。待交互详情目前要求会话使用 Web channel（`NotificationsPlugin.kt`；`Protocol.kt`）。

后台服务同样负责 turn 完成提醒。当一个 direct session 的运行在服务器上进入完成终态，且该会话不再运行、不在等待回答、也没有后台任务占用时，通知显示会话标签（未设置时显示会话 ID 前 8 位）和一句提示，邀请你打开查看，不获取任何 transcript 文本。被取消、失败以及仍在等待的运行保持静默，团队 worker 的运行同样如此，正在屏幕上查看的会话也不会弹出提醒。首次连接某台服务器只记录已有运行而不提醒，因此启用功能不会重放旧对话。后台服务负责这类提醒期间，页面不再重复发送；关闭本设备开关，或使用早于该能力的应用壳与缓存页面时，仍由页面实时消息流生成（`Completions.kt`；`Reconciler.kt`；`web/src/mobile/screens/MNotificationMount.tsx`）。

Cortex 下载的文件会交给 Android `DownloadManager`，写入公共 Downloads collection，并显示系统完成通知。

## 文件与下载 {#files-and-downloads}

| 界面 | 下载行为 |
|---|---|
| 浏览器 | 使用浏览器自带的下载管理器。 |
| Linux、macOS、Windows | 优先使用操作系统 Downloads 目录，不可用时回退到应用本地 downloads，并在完成后提供 **Open file** 与 **Open folder** 操作。 |
| Android | 使用系统 DownloadManager 与公共 Downloads collection。 |

工作台可直接预览图片与视频、分页查看 PDF，并显示文本文件，无需先用其他程序打开。桌面用户还可以将预览固定在聊天旁边，继续对话。

## 版本与前端更新 {#versions-and-frontend-updates}

带 tag 的原生 release 与 `@cortex-agent/server` 使用同一版本。这个共享 CalVer 标识 server release，以及从该 tag commit 构建的全部原生安装包。

## 更新 {#updates}

**帮助 → 检查更新**（Android 中为**设置 → 检查更新**）先向所连接的服务器查询最新发布，再检查前端工作台与原生应用壳。重复点击共享正在进行的检查。结果区分可更新、已是最新、已跳过与检查失败；禁用检查、开发运行和跳过的版本不会被报告为已是最新。

提示顺序是服务器、原生应用、前端工作台。`serverAutoUpdate` 开启时（默认），更新的服务器版本在没有任务运行时直接安装，不弹提示，装完重启；只有安装失败才弹出对话框。关闭时，检查本身不授权安装或重启，在服务器提示中选择**更新**才会授权，且同样等没有任务运行时才安装与重启；**稍后**隐藏提示，下次手动检查可重新打开；**跳过此版本**保留版本跳过策略。服务器检查遵守 `serverUpdateDisable` 与开发模式限制。

服务器重新连接后，应用只复查前端与原生通道。每次重启或安装仍保留相应确认和平台权限要求：这是有序流程，不是所有组件的一次性原子安装。浏览器使用[页面刷新确认](browser-access.md#updates)，不调用原生安装程序。

### 前端工作台 {#frontend-workbench}

启动后，原生壳会比较本地 SPA 与服务器提供的 content-addressed frontend bundle。发现新 bundle 后，应用在后台下载、校验 SHA-256 digest、完成 staging，并在可通过重启应用时提示。这条通道更新 Web 工作台，不会替换原生 executable 或 APK。安装包含不同内置前端的 Android APK 时，会同步刷新一次本地页面；之后的启动仍保留兼容的前端 OTA 更新。若服务器缓存的旧页面缺少原生通知桥，会回退到 APK 内置页面，避免通知点击再次失效（`desktop/src-tauri/src/seed.rs`）。未连接服务器时，原生壳提供应用内置的前端而非已下载的前端，因此连接与安装界面始终与已安装的应用版本一致，不受设备上留存的任何服务器前端影响（`desktop/src-tauri/src/frontend.rs`）。

### 原生应用壳 {#native-app-shell}

Server release 也可以在 GitHub Release 中携带原生安装包。服务器只会通告不高于自身版本的最新可安装 release。原生壳按操作系统、架构与 package kind 选择附件，直接从 GitHub 下载且不会转发 Cortex token，并在提供安装选项前校验 GitHub 提供的 SHA-256 digest。更新对话框支持立即安装、跳过该版本或稍后处理。

| 平台 | 原生更新行为 |
|---|---|
| Linux AppImage | 原地替换当前 AppImage，保留一份 `.old` 备份，重新启动后退出旧进程。 |
| Linux DEB 或 RPM | 将已校验的软件包复制到 Downloads，并打开系统 package installer。 |
| Windows | 启动已校验的 NSIS installer，然后退出，以便安装程序替换应用。 |
| macOS | 将已校验的 DMG 复制到 Downloads 并打开；将 Cortex 拖入 Applications 后完成安装。 |
| Android | 对已校验的 APK 打开系统 package installer；Android 会在需要时请求 install-source 权限。 |

会话在服务器上运行，因此重启或重新安装客户端不会停止它们。设置了 `CORTEX_FRONTEND_DIR` 的开发运行、未携带 CalVer release version 的应用，或设置 `CORTEX_APP_UPDATE_DISABLE=1` 时，都不会检查原生壳更新。

## 卸载 {#uninstalling}

**设置 → 高级 → 卸载 Cortex** 会打开卸载程序：一个独立窗口，询问要移除哪些内容，执行移除，并列出每一步的结果。在 Windows 上，从**设置 → 应用**卸载 Cortex 时，会先打开同一个窗口，再删除程序文件。

窗口提供两项选择：

- **移除范围**在应用曾于本机安装服务器时出现。默认的**应用和本机服务器**会取消开机自启，停止 daemon 及其启动的本机 client，把 `cortex` 终端命令从 `PATH` 中移除，并删除 `~/.cortex/runtime`。**仅应用**保留服务器继续运行，仍可从浏览器或其他设备访问；Windows 上的登录自启项会打开应用，因此随应用一并移除。连接远程服务器的应用不显示这一项，也不会触碰那台服务器。
- **同时删除数据**默认关闭。与服务器一起选择时，它删除整个 Cortex home（`~/.cortex` 或 `CORTEX_HOME`）：配置与 token、对话、项目上下文、插件和日志；同时删除应用自身名为 `dev.cortex.desktop` 的数据目录，其中包括保存的连接。选择**仅应用**时，只删除应用自身的数据和保存的连接。确认前窗口会列出所有将删除的路径；删除无法恢复。

保留数据时，重新安装 Cortex 即可接着使用：安装流程会重新解压运行时、重新安装服务器包，并连接到原有的配置和会话。

应用本体按安装方式移除。Windows 卸载程序在窗口关闭后删除程序文件；macOS 把 `Cortex.app` 移到废纸篓；AppImage 删除其文件；DEB 或 RPM 安装在系统授权提示后由包管理器移除；不属于任何软件包的副本会显示所在文件夹，由你手动删除。停止服务器或删除其文件失败时，应用保持安装状态，窗口提供**重试**。不是由应用写入的登录服务（例如在命令行运行 `cortex init` 生成的 `cortex.service`）会在结果中注明并保持原样。

Windows 应用更新、在已安装应用上运行安装程序，以及静默卸载（`/S`、`/P`、`/UPDATE`）都不会打开该窗口，只替换或删除程序文件。

用其他方式移除应用，例如把 `Cortex.app` 拖进废纸篓、运行 `apt remove` 或删除 AppImage，服务器和数据会保留。之后要移除服务器，依次取消其登录服务、停止服务器并删除运行时：

```bash
# Linux
systemctl --user disable --now cortex.service && rm ~/.config/systemd/user/cortex.service
# macOS
launchctl bootout gui/$(id -u)/cc.cortex.agent-server && rm ~/Library/LaunchAgents/cc.cortex.agent-server.plist
# 两者都需要
cortex daemon stop
cortex path remove
rm -rf ~/.cortex/runtime
```

再删除 `~/.cortex` 的其余部分即同时删除数据。

## 故障排查 {#troubleshooting}

### Unauthorized

用配对码连接的应用，在「设置 → 机器 → 已连接的 App」中被撤销设备 token 后会断开；使用 Disconnect，再用新的配对码重新连接。用客户端 token 连接的应用，应填写 `CORTEX_CLIENT_TOKEN`，而不是 webhook token 或旧变量；如果服务器 token 已改变，先使用 Disconnect，再重新输入。配对码被拒绝表示它错误或已过期——生成一个新的即可。

### Network error

确认 daemon 正在运行、`CORTEX_UI_HTTP=1` 已加载、URL 能访问配置端口，且隧道正在工作。页面可加载但 API 全部失败时，通常是 token 或 CORS 问题。确认 `config/settings.json` 中的 `uiCorsOrigins` 设置包含当前的 `cortexui` origins；如果还有旧版应用连接服务器，请保留 `tauri` origins。

### 本地安装未能完成 {#the-wizard-cannot-find-nodejs}

先选择**重试**：安装会重新解压缺失的运行环境文件，并重新安装无法运行的服务端。服务端包无法下载时，请检查网络连接以及 `.npmrc` 中的 registry 与代理设置。应用提示安装包不完整时，请重新下载对应平台的安装包并重新安装。不受支持的系统可改为连接其他电脑上的服务器。需要诊断详情时再展开**查看运行日志**。

### 向导启动后服务端没有响应 {#the-server-does-not-answer-after-the-wizard-starts-it}

冷启动需要加载整个 agent 运行时，在较慢的机器上可能超过向导的等待时间。实时日志会显示 daemon 的输出。也可在新开的终端中检查状态：

```bash
cortex daemon status
cortex doctor
```

安装完成前打开的终端还找不到该命令。关闭了终端命令时，可直接调用启动器，例如 `~/.cortex/runtime/bin/cortex doctor`。没有启动器时，请用 `~/.cortex/runtime/selection.json` 中记录的 `node` 绝对路径执行 CLI：
`"<node 路径>" ~/.cortex/runtime/prefix/bin/cortex doctor`（或 `daemon status`）。

Windows 上没有启动器时，可在 PowerShell 中使用保存的运行环境：

```powershell
$runtime = Get-Content "$env:USERPROFILE\.cortex\runtime\selection.json" -Raw | ConvertFrom-Json
& $runtime.node "$env:USERPROFILE\.cortex\runtime\prefix\node_modules\@cortex-agent\server\dist\entry\cortex-cli.js" daemon status
& $runtime.node "$env:USERPROFILE\.cortex\runtime\prefix\node_modules\@cortex-agent\server\dist\entry\cortex-cli.js" doctor
```

如果设置了 `CORTEX_HOME`，请将以上路径中的 `~/.cortex` 或 `$env:USERPROFILE\.cortex` 替换为该目录。

应用在每次启动时也会拉起本机服务端，重新打开应用即可重试。

### 凭据无法持久化 {#credentials-do-not-persist}

应用把连接保存在自身数据目录中（见[首次连接](#first-connection)）。该目录不可写时，首次本地安装无法完成，普通连接只在当前进程内有效。请让该目录可写，或启动应用时显式指定已运行的服务端连接：

```bash
CORTEX_SERVER_URL=http://localhost:3004 CORTEX_TOKEN='<client-token>' ./Cortex.AppImage
```

将 `$CORTEX_HOME/config/.env`（默认为 `~/.cortex/config/.env`）中的 `CORTEX_CLIENT_TOKEN` 值填入 `<client-token>`。`CORTEX_TOKEN` 是原生壳的 fallback 变量，不替代服务器设置。此方式连接已运行的服务端，不会自动启动它。

### Wayland 下应用窗口不显示 {#app-window-does-not-open-on-wayland}

Tauri 支持 Wayland，但具体系统的 WebKitGTK 问题可能需要使用 X11 compatibility：

```bash
GDK_BACKEND=x11 ./Cortex.AppImage
```
