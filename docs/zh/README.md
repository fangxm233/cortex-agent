<div align="center">

# Cortex

**面向自主科研、自我改进循环和以天计长任务的智能体工作台。**

给它一个使命：它会规划工作，带着一组智能体在你的多台机器和 GPU 上执行，<br>
把每个结果记在不随会话消失的纯文本文件里，只在真正需要时才来问你。

[![Release](https://img.shields.io/github/v/release/fangxm233/cortex-agent?filter=server-v*&label=release)](https://github.com/fangxm233/cortex-agent/releases)
[![npm](https://img.shields.io/npm/v/@cortex-agent/server?label=npm)](https://www.npmjs.com/package/@cortex-agent/server)
[![Docs](https://img.shields.io/badge/docs-fangxm233.github.io-4f46e5)](https://fangxm233.github.io/cortex-agent/zh/)
[![License](https://img.shields.io/github/license/fangxm233/cortex-agent)](https://github.com/fangxm233/cortex-agent/blob/main/LICENSE)

[下载](#下载) · [文档](https://fangxm233.github.io/cortex-agent/zh/) · [English](https://github.com/fangxm233/cortex-agent/blob/main/README.md)

</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/fangxm233/cortex-agent/main/docs/images/ui/hero-dark.png">
  <img alt="Cortex 工作台：左侧是项目、会话和 worker，中间是正在汇报结果的主会话，右侧是它的实时看板" src="https://raw.githubusercontent.com/fangxm233/cortex-agent/main/docs/images/ui/hero-light.png">
</picture>

## 下载

| 平台 | 安装包 |
|---|---|
| macOS · Apple 芯片 | [Cortex-2026.10.15-2-macOS-aarch64.dmg](https://github.com/fangxm233/cortex-agent/releases/download/server-v2026.10.15-2/Cortex-2026.10.15-2-macOS-aarch64.dmg) |
| macOS · Intel | [Cortex-2026.10.15-2-macOS-x86_64.dmg](https://github.com/fangxm233/cortex-agent/releases/download/server-v2026.10.15-2/Cortex-2026.10.15-2-macOS-x86_64.dmg) |
| Windows · x64 | [Cortex-2026.10.15-2-Windows-x86_64-setup.exe](https://github.com/fangxm233/cortex-agent/releases/download/server-v2026.10.15-2/Cortex-2026.10.15-2-Windows-x86_64-setup.exe) |
| Linux · x86_64 | [AppImage](https://github.com/fangxm233/cortex-agent/releases/download/server-v2026.10.15-2/Cortex-2026.10.15-2-Linux-x86_64.AppImage) · [deb](https://github.com/fangxm233/cortex-agent/releases/download/server-v2026.10.15-2/Cortex-2026.10.15-2-Linux-amd64.deb) · [rpm](https://github.com/fangxm233/cortex-agent/releases/download/server-v2026.10.15-2/Cortex-2026.10.15-2-Linux-x86_64.rpm) |
| Android · arm64 | [Cortex-2026.10.15-2-Android-arm64.apk](https://github.com/fangxm233/cortex-agent/releases/download/server-v2026.10.15-2/Cortex-2026.10.15-2-Android-arm64.apk) |

桌面应用可以一键在本机安装并启动 Cortex 服务端，不需要终端，也不需要自己装 Node.js；也可以连接一台已经在运行的服务器。Android 应用连接服务器使用。没有图形界面的机器用 npm 安装服务端（见[上手](#上手)）。其他版本在 [Releases 页面](https://github.com/fangxm233/cortex-agent/releases)。

## Cortex 是什么

终端里的编程智能体围绕单个会话设计：一个任务、一台机器、一小时内做完。自主科研（Auto Research）和递归自我改进（RSI）需要的不止这些：一项研究要跑好几天，比其中任何一个会话都长；结果要留下来，一轮一轮地对比；工作要拆给多个智能体；实验跑在 GPU 服务器上，而不是智能体启动的那台机器上。

Cortex 就是为这类工作准备的环境。它把编程智能体（Claude Code，或者用你已经付费的 provider 跑 PI）作为长期运行的服务，并在前面放了一个工作台：

- **任务跨会话接着跑。** 项目的使命、状态和决策以纯文件形式保存在磁盘上，而不是存在越积越长、最终失效的聊天记录里，所以新会话能从上一个会话停下的地方接着做。定时任务启动周期性工作，等待点在会话发起的任务结束时把它唤醒。
- **实验结果留得下来。** 每个实验都有自己的记录：跑了什么、得到什么、说明什么。确认的结论和跨实验的模式也在旁边一并积累。
- **多个智能体协作。** 主会话把工作交给持久的 worker 和一次性的子智能体，它们各自从全新的上下文开始；主会话还维护一块实时看板，显示工作进行到哪里。
- **所有机器和 GPU 都用得上。** 一个会话就能在任何运行 `cortex-client` 的机器上读写文件、执行命令，工作台上能看到每块 GPU 的实时负载。
- **这套环境本身也能改进。** 技能、规则、钩子，乃至 Cortex 自己的源码，都是智能体可以修改的文件，边界由你写的安全规则划定。

## 工作台导览

### 计划、工具调用和提问都在一个对话里

<img alt="停在计划上的会话，带“请求修改”和“批准计划”按钮" src="https://raw.githubusercontent.com/fangxm233/cortex-agent/main/docs/images/ui/plan-approval.png">

每个会话都把推理、工具调用、子智能体运行和文件流式输出到同一份记录里。开始不简单的工作之前，智能体会先写计划并等待。你读完后在聊天里的卡片上批准，或者写明要改什么退回去重做。提问和决策也以卡片形式出现，直接在原地回答，桌面和手机都可以。

### 用看板跟踪长任务

<p align="center"><img width="640" alt="看板：实时状态条、阶段卡片、结果表和图" src="https://raw.githubusercontent.com/fangxm233/cortex-agent/main/docs/images/ui/board.png"></p>

当一项任务要持续很多小时或者分给多个 worker 时，智能体会开一块**看板**：停靠在对话旁边的状态页。看板显示工作进行到哪里、接下来做什么、哪些在等你，以及到目前为止做出的每个决策。你可以直接在看板上批准、追问或修改某个决策。主会话和 worker 边做边更新，每次修改后几秒内页面就会刷新。[看板 →](https://fangxm233.github.io/cortex-agent/zh/team/#boards)

### 一组 worker

<img alt="展开团队列表的主会话，显示每个 worker 的状态和最新汇报" src="https://raw.githubusercontent.com/fangxm233/cortex-agent/main/docs/images/ui/team.png">

你只和一个会话对话，也就是**主会话**。工作可以拆开时，主会话把各部分交给持久的 **worker** 会话，之后继续跟进、回答它们的问题，再把结果汇报给你。聊天标题栏上的胶囊显示有几个 worker 在运行，点开可以看到每个 worker 在做什么。搜索、审查、验证这类有边界的一次性工作则交给子智能体。[团队模式 →](https://fangxm233.github.io/cortex-agent/zh/team/)

### 每个实验都有记录

<img alt="记忆视图：项目的使命、状态、实验和知识文件，右侧打开的一条实验记录显示了运行命令和结果" src="https://raw.githubusercontent.com/fangxm233/cortex-agent/main/docs/images/ui/memory.png">

每个实验都作为一份独立的 Markdown 记录写进项目记忆：做了什么、观察到什么、得出什么结论、接下来该改什么。站得住的结论成为知识条目，跨实验的规律也有自己的记录。**记忆**视图在会话旁边浏览这一切。[记忆 →](https://fangxm233.github.io/cortex-agent/zh/memory/)

### 你的所有机器和 GPU

<p align="center"><img width="560" alt="机器菜单：实时 CPU、内存、磁盘和逐 GPU 状态" src="https://raw.githubusercontent.com/fangxm233/cortex-agent/main/docs/images/ui/machines.png"></p>

你的 GPU、数据和工具很少都在一台机器上。在任意 Linux、macOS 或 Windows 机器上运行 `cortex-client`，智能体就能在同一个会话里在那台机器上读写文件、执行命令。**机器**菜单显示每台机器实时的 CPU、内存、磁盘，以及每块 GPU 的负载和进程。训练或评测在有 GPU 的机器上启动后，智能体设一个**等待点**就结束这一轮，任务回报时再带着结果被唤醒，中间不用轮询。在桌面应用里，停靠栏可以打开远程机器上运行的开发服务器，就像它跑在本地一样。[跨机器 →](https://fangxm233.github.io/cortex-agent/zh/cross-machine/) · [等待点 →](https://fangxm233.github.io/cortex-agent/zh/waitpoints/)

### 智能体改进自己用的技能和代码

Cortex 的行为由普通文件决定：`$CORTEX_HOME` 下的技能、规则、钩子、提示词和智能体角色，每一项都可以覆盖对应的内置版本。智能体像改其他文件一样读写它们，你也可以在设置里编辑同样的技能。执行环境决定一个会话加载哪些插件、规则和工具，同一个智能体的不同变体可以并排运行。用 `CORTEX_REPO` 指向一份源码 checkout 后，Cortex 会在代码变化时自动重建、重新安装并重启自己。这些合在一起，让智能体可以改进它们所依赖的技能和代码；哪些改动要等你签字，由你的安全边界决定。[技能与插件 →](https://fangxm233.github.io/cortex-agent/zh/skills-and-plugins/) · [配置 →](https://fangxm233.github.io/cortex-agent/zh/configuration/)

### 在手机上

<img alt="Android 应用：会话列表、带决策和 worker 的主会话，以及等待批准的计划" src="https://raw.githubusercontent.com/fangxm233/cortex-agent/main/docs/images/ui/mobile-strip.png">

Android 应用以手机布局提供同样的会话、看板、审批和记忆。它可以在后台通知你：一轮对话结束了，或者某个会话在等你回答。[桌面与 Android 应用 →](https://fangxm233.github.io/cortex-agent/zh/desktop-app/)

### 接入你的工作流

Cortex 可以接入 Slack 和飞书（Lark），你可以直接在常用的聊天应用里使用它：在那里发起和继续会话，工作完成或需要你处理时也会在那里收到通知。[Slack 设置 →](https://fangxm233.github.io/cortex-agent/zh/slack-setup/) · [快速入门 →](https://fangxm233.github.io/cortex-agent/zh/quickstart/)

### 用你自己的模型

<p align="center"><img width="640" alt="Model providers：已连接的 OpenAI Codex 登录，以及可以用 API key 或 OAuth 添加的 provider 目录" src="https://raw.githubusercontent.com/fangxm233/cortex-agent/main/docs/images/ui/provider-setup.png"></p>

Cortex 驱动编程智能体，而不是自己调用模型 API。PI 随服务端一起提供，可以用 OAuth 或 API key 登录几十个 provider，包括 ChatGPT Plus/Pro 这样的订阅。Claude Code 是可选的，使用你自己的 Claude 登录。用量和花费按会话、按 provider 统计。[后端 →](https://fangxm233.github.io/cortex-agent/zh/backends/)

## 上手

### 桌面应用

[下载](#下载)对应平台的应用，打开后选择 **安装 Cortex**。应用会解压自带的 Node.js 运行时，把服务端安装到 `~/.cortex` 下的私有目录，启动它，然后打开 provider 设置。登录一个 provider、选一个默认模型，就可以进入工作台。如果要用别处运行的服务器，选择 **连接已有服务器**。[桌面与 Android 应用 →](https://fangxm233.github.io/cortex-agent/zh/desktop-app/)

### 在终端安装服务端

需要 Node.js 22.19 或更高版本。

```bash
npm install -g @cortex-agent/server
cortex init        # 引导式设置：聊天平台、机器名、provider 登录
cortex ui enable   # 开启 Web 工作台和应用连接端点
cortex daemon      # 在后台启动服务端
```

在服务器上打开 `http://127.0.0.1:3004`，或者用服务器地址和 client token 连接桌面或 Android 应用。[快速入门 →](https://fangxm233.github.io/cortex-agent/zh/quickstart/)

### 其他入口

所有入口访问的是同一组项目、会话、定时任务和记忆：

| 入口 | 指南 |
|---|---|
| 浏览器工作台，由服务端提供，用 Cloudflare Access 保护 | [浏览器访问](https://fangxm233.github.io/cortex-agent/zh/browser-access/) |
| Slack 或飞书，用于聊天驱动的工作和通知 | [Slack 设置](https://fangxm233.github.io/cortex-agent/zh/slack-setup/) · [快速入门](https://fangxm233.github.io/cortex-agent/zh/quickstart/) |
| `cortex tui`，全屏终端界面 | [CLI 参考](https://fangxm233.github.io/cortex-agent/zh/cli-reference/) |

## 项目如何存储

```
context/projects/optimizer-study/
├── mission.md        # 目标与成功标准
├── roadmap.md        # 里程碑
├── STATUS.md         # 当前状态（覆盖式）
├── ISSUES.md         # 待解决的摩擦点（追加式）
├── boards/           # 长任务的状态页
├── decisions/        # 设计决策记录
├── experiments/      # EXP-NNN.md，每个实验一个文件
├── knowledge/        # K-NNN.md，每条确认的结论一个文件
└── patterns/         # PAT-NNN.md，跨实验的模式
```

这些都是普通的 Markdown 文件，装了 Git 时会放在 git 仓库里。它们在会话结束、重启和模型升级之后依然存在，任何智能体或人都可以直接阅读。

## 安全与审批

Cortex 给智能体的是真实的工具：shell、文件、GPU、其他机器，以及决定它们自身行为的文件。它的护栏建立在对话中的确认上，而不是沙箱：

- **计划审批。** 不简单的工作从一份计划开始，计划会一直等到你批准或退回修改。
- **提问和决策。** 智能体通过卡片向你提问，你在原地回答；它自己做的选择会逐条记录成决策，供你查看。
- **你的规则。** 写在 `$CORTEX_HOME/AGENTS.md` 里的安全边界告诉每个会话：哪些可以自己做、哪些需要你签字（比如改变某个技能的行为、修改 Cortex 自己的代码）、哪些禁止。需要签字的操作在**审批中心**排队。

[安全与审批 →](https://fangxm233.github.io/cortex-agent/zh/safety-and-approvals/)

## 文档

| 指南 | 内容 |
|---|---|
| [快速入门](https://fangxm233.github.io/cortex-agent/zh/quickstart/) | 安装、`cortex init`、Web 工作台和第一条消息 |
| [桌面与 Android 应用](https://fangxm233.github.io/cortex-agent/zh/desktop-app/) | 原生应用安装、本地服务端安装、provider 设置、工作台、通知、更新 |
| [浏览器访问](https://fangxm233.github.io/cortex-agent/zh/browser-access/) | 提供 Web 工作台并用 Cloudflare Access 保护 |
| [Slack 设置](https://fangxm233.github.io/cortex-agent/zh/slack-setup/) | 创建应用、令牌、Socket Mode、权限范围 |
| [团队模式](https://fangxm233.github.io/cortex-agent/zh/team/) | 主会话、worker、汇报和看板 |
| [记忆](https://fangxm233.github.io/cortex-agent/zh/memory/) | 项目日志：实验、知识、模式、决策 |
| [调度](https://fangxm233.github.io/cortex-agent/zh/scheduling/) | 间隔、每日、每周和一次性定时任务 |
| [后端](https://fangxm233.github.io/cortex-agent/zh/backends/) | Claude Code 与 PI、provider、模型选择、花费统计、子智能体 |
| [配置](https://fangxm233.github.io/cortex-agent/zh/configuration/) | `config/.env`、`settings.json`、模型与收藏、执行环境 |
| [CLI 参考](https://fangxm233.github.io/cortex-agent/zh/cli-reference/) | `cortex`、`cortex-browser`、`cortex-signal` 和 `cortex-hook` |
| [技能与插件](https://fangxm233.github.io/cortex-agent/zh/skills-and-plugins/) | 编写、覆盖和打包技能 |
| [安全与审批](https://fangxm233.github.io/cortex-agent/zh/safety-and-approvals/) | 安全边界、审批队列和交互卡片 |
| [钩子](https://fangxm233.github.io/cortex-agent/zh/hooks/) | 钩子生命周期、内置钩子和自定义钩子 |
| [等待点](https://fangxm233.github.io/cortex-agent/zh/waitpoints/) | 不轮询地等待外部任务 |
| [MCP](https://fangxm233.github.io/cortex-agent/zh/mcp/) | Cortex 的 MCP 工具和第三方 MCP 服务器 |
| [跨机器](https://fangxm233.github.io/cortex-agent/zh/cross-machine/) | 部署 `cortex-client` 和使用远程工具 |
| [Agent 浏览器](https://fangxm233.github.io/cortex-agent/zh/agent-browser/) | agent 用 `cortex-browser` 操作的 Chrome、实时观看和接管 |
| [架构](https://fangxm233.github.io/cortex-agent/zh/architecture/) | 服务端分层、协议和事件总线 |

## 开发 Cortex

```bash
git clone https://github.com/fangxm233/cortex-agent.git
cd cortex-agent
pnpm install
pnpm --filter @cortex-agent/ui-contract --filter @cortex-agent/server --filter @cortex-agent/web build
pnpm --filter @cortex-agent/server test
```

| 包 | 目录 | 作用 |
|---|---|---|
| `@cortex-agent/server` | `agent-server/` | 控制面：会话、编排、调度、聊天适配器、Web UI 主机 |
| `@cortex-agent/client` | `client/` | 远程 worker，通过 WebSocket 在另一台机器上执行工具 |
| `@cortex-agent/web` | `web/` | 浏览器、桌面和手机共用的工作台 SPA |
| `@cortex-agent/desktop` | `desktop/` | Linux、macOS、Windows 和 Android 的 Tauri 外壳 |
| `@cortex-agent/ui-contract` | `packages/ui-contract/` | 服务端与工作台之间的类型化契约 |
| `@cortex-agent/deepseek-relay-worker` | `packages/deepseek-relay-worker/` | 用于 DeepSeek API 出站的 Cloudflare Worker 中继 |

`pnpm --dir web dev` 以热重载方式提供工作台，连接 3004 端口上的服务端（在该 shell 里设置 `CORTEX_CLIENT_TOKEN`）；`pnpm --dir desktop dev` 运行原生外壳，需要 Rust 工具链。服务端从核心工具到入口分为六层，详见[架构](https://fangxm233.github.io/cortex-agent/zh/architecture/)。代码改动需要附带测试。

## 许可证

[MIT](https://github.com/fangxm233/cortex-agent/blob/main/LICENSE)
