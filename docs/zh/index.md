# Cortex {#cortex}

Cortex 是一个面向长期项目的自主智能体系统。你给它一个带有成功标准的使命，它会规划工作、把聚焦的部分交给子智能体、在你的仓库中保留结构化的进度日志，并对照你们约定的内容检查结果——跨越数天或数周的无人值守工作。

![Cortex 工作台：项目与会话列表、汇报结果的主会话，以及停靠栏中的看板](../images/ui/hero-light.png)

## 为什么选择 Cortex？ {#why-cortex}

Cortex 围绕长智能体运行的三种失败模式而设计：

- **上下文腐化** —— 持久的项目状态以纯文件形式存在于你的仓库中，而非积累和衰减的聊天记录。
- **执行漂移** —— 不简单的工作从你批准的计划开始，长任务有一块实时看板展示状态、计划和决策，每一项完成声明都指向它的证据。
- **上下文窗口限制** —— 有边界的工作交给子智能体，它们以全新的上下文开始，只带回结果。

## 特性 {#features}

- **子智能体与团队模式** —— 有边界的工作交给上下文干净的子智能体；开启团队模式后，一个会话可以带领持久的 worker 会话（[团队模式](team.md)）。
- **用看板跟踪长任务** —— 长任务在对话旁边有一个实时状态页，展示状态、计划、需要你处理的事和已做出的决策（[看板](team.md#boards)）。
- **结构化项目日志** —— 每个项目以纯文件形式保留使命、路线图、状态、实验、知识、模式和决策。
- **定时与间隔调度** —— 安排 Cortex 定期扫描、摘编或巡查。
- **可编辑的技能与插件** —— 技能就是普通的 `SKILL.md` 文件，Cortex 和你都可以编写、覆盖或还原它们，直接改文件或在**设置 → 插件**中操作（[技能与插件](skills-and-plugins.md)）。
- **跨机器统一代理** —— 通过 `cortex-client` 连接任意 Mac、Windows 或 Linux 机器。
- **由 agent 操作的浏览器** —— agent 在服务器或你自己机器上的 Chrome 里打开、阅读和操作网页；你可以实时观看，遇到登录时接管（[Agent 浏览器](agent-browser.md)）。
- **Web、原生应用、聊天平台与终端访问** —— 浏览器工作台、Linux/macOS/Windows 桌面应用、Android 应用、Slack、飞书和 TUI 共用同一服务器。工作台把会话、worker、看板、审批、机器和项目记忆并排呈现。

## Cortex 使用方式 {#ways-to-use-cortex}

| 界面 | 适用场景 | 指南 |
|---|---|---|
| 浏览器工作台 | 无需安装客户端，从现有浏览器访问 | [浏览器访问](browser-access.md) |
| 桌面应用 | Linux、macOS 或 Windows 原生工作台 | [桌面与 Android 应用](desktop-app.md) |
| Android 应用 | 移动端会话、项目与审批 | [桌面与 Android 应用](desktop-app.md) |
| Slack 或飞书 | 对话式操作与通知 | [快速入门](quickstart.md) |
| TUI | 全屏终端操作 | [CLI 参考](cli-reference.md) |

## 快速开始 {#quickstart}

[桌面应用](desktop-app.md#installing-a-server-from-the-app)可以在 macOS、Linux 或 Windows 上无需终端地安装并启动 Cortex 服务器。使用终端时：

```bash
npm install -g @cortex-agent/server
cortex init
cortex ui enable
cortex daemon
```

服务器与聊天平台的详细设置见[快速入门](quickstart.md)。服务器启动后，可在服务器上打开 `http://127.0.0.1:3004` 进入工作台，按[浏览器访问](browser-access.md)从其他地方访问，或按[桌面与 Android 应用](desktop-app.md)连接原生客户端。
