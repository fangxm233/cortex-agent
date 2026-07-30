# Cortex — 自主项目负责人

[English documentation](../../README.md) | [文档](https://fangxm233.github.io/cortex-agent/)

Cortex 是一个面向长期项目的自主智能体系统。你给它一个带有成功标准的使命，它会规划工作、调度智能体管道来执行、在你的仓库中保留结构化的进度日志，并在每次提交前自我审查——跨越数天或数周的无人值守工作。

Cortex 围绕长智能体运行的四种失败模式而设计。
**上下文腐化** —— 持久的项目状态以纯文件形式存在于你的仓库中，而非积累和衰减的聊天记录。
**执行漂移** —— 每个任务带有可验证的成功标准，在完成时检查。
**上下文窗口限制** —— 工作被划分到智能体管道中，每个管道具有受限的范围和全新的上下文。
**单一视角偏差** —— 对抗性审查是内置的管道阶段，而不是一个礼貌的建议。

## 特性

- **使命驱动的任务系统** —— 交出一个目标；Cortex 将其分解为带优先级、依赖关系和可验证完成条件的追踪任务，自主完成它们，仅在受阻时停下来询问。你不再需要维护待办列表。
  参见 [tasks.md](./tasks.md)。

- **多智能体线程管道** —— 长时间作业以聚焦智能体的接力方式运行，而非一个过载的会话。每一步以上干净的上下文和狭窄的范围开始，因此模型不会在中途丢失主线。交接仅携带下一阶段所需的内容。
  参见 [threads.md](./threads.md)。

- **结构化的项目日志** —— 每个项目将 mission、roadmap、status、experiments、knowledge、patterns 和 decisions 作为纯文件保存在你的仓库中。一个全新的智能体（或数周后全新的你）可以从上一个中断的地方继续——无需滚动聊天记录，无需查询向量存储。
  参见 [memory.md](./memory.md)。

- **Cron 和间隔调度** —— 调度 Cortex 每天早上扫描一个领域、发送每周摘要或每隔几分钟清理收件箱。调度在重启后持久化，并可在无停机的情况下热重载。
  参见 [scheduling.md](./scheduling.md)。

- **自我进化的技能** —— 当 Cortex 发现自己第三次做同一件事时，它会起草一个新技能，你批准后，未来的运行会自动使用它。Cortex 运行得越久，你的模式越会成为一等公民行为。
  参见 [skills-and-plugins.md](./skills-and-plugins.md)。

- **一个智能体横跨你的机器** —— 你的计算、文档、代码和工具很少在同一台机器上。通过 `cortex-client` 将任何 Mac、Windows 或 Linux 机器连接为远程主机，Cortex 可以从单一控制面跨所有机器读取、写入和执行。
  参见 [cross-machine.md](./cross-machine.md)。

- **后端无关** —— 当前运行在 Claude Code 或 PI 上，具有适配器抽象以支持额外的编程智能体。使用你已经付费的 LLM 订阅——无需额外的 API 密钥，无需第二份账单。

- **通过 Web、原生应用、聊天平台或终端使用 Cortex** —— 打开浏览器工作台，安装 Linux/macOS/Windows 桌面应用或 Android 应用，通过 Slack 或飞书发送消息，或使用 TUI。所有界面访问同一组项目、会话、任务和记忆。参见[浏览器访问](./browser-access.md)和[桌面与 Android 应用](./desktop-app.md)。

## 快速入门

要求：Node 20+ 和已安装的编程智能体后端（Claude Code 或 PI）。

```bash
# 安装
npm install -g @cortex-agent/server

# 初始化（引导式设置）
cortex init

# 启动
cortex daemon
```

服务启动后，可以使用 Slack 或飞书、打开浏览器工作台，或连接原生应用。所有界面通过同一服务器读取项目上下文并调度工作。浏览器部署见[浏览器访问](./browser-access.md)，原生应用安装见[桌面与 Android 应用](./desktop-app.md)。

详细的分步指南（涵盖设置向导提示、创建的文件说明以及如何发送第一条消息）见
[quickstart.md](./quickstart.md)。

## 项目结构

每个项目位于 `.cortex/context/projects/<name>/` 下，具有可预测的布局：

```
projects/my-project/
├── mission.md           # 目标和成功标准
├── roadmap.md           # 里程碑和时间线
├── STATUS.md            # 当前状态（覆盖式）
├── ISSUES.md            # 开放摩擦点（追加式）
├── TASKS.yaml           # 机器可读的任务队列
├── decisions/           # DR-NNNN.md 设计决策（追加式）
├── experiments/         # EXP-NNN.md 原子实验记录
├── knowledge/           # K-NNN.md 原子知识条目
├── patterns/            # PAT-NNN.md 跨实验模式
└── tasks-archive.md     # 已完成的任务（自动归档）
```

这就是项目日志。它在会话、重启和模型升级后依然存在。一个全新的智能体可以从这里恢复工作，无需之前的对话。

## 安全边界

Cortex 按影响范围分类操作。系统在工具调用层强制执行这一分类。

| 等级             | 示例                                                          |
|-------------------|--------------------------------------------------------------|
| 自主执行          | 读取文件、运行小型脚本、编辑上下文文件、网络搜索、预算内计算    |
| 需要审批          | 修改 CLAUDE.md 规则、添加新技能、更改 agent-server 行为、超预算计算、删除数据 |
| 禁止              | 系统级软件包安装、系统配置更改、`rm -rf`                     |

审批队列位于 `.cortex/context/PENDING_APPROVALS.md`。在 `.claude/settings.json` 中配置额外规则。

## 配置

所有配置位于 `$CORTEX_HOME/config/` 下。仅需要 `CORTEX_PLATFORM` 和平台凭据（Slack 令牌）。运行 `cortex init` 进行引导式设置。完整的环境变量参考、文件布局和优先级规则见 [configuration.md](./configuration.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [Quickstart](./quickstart.md) | 安装、初始化、5 分钟内发送第一条 Slack 消息 |
| [桌面与 Android 应用](./desktop-app.md) | 原生应用安装、连接、下载与更新 |
| [浏览器访问](./browser-access.md) | Web 工作台认证与部署 |
| [Slack Setup](./slack-setup.md) | 应用创建、令牌收集、Socket Mode、作用域 |
| [Configuration](./configuration.md) | 完整 `.env` 参考、`profiles.json`、文件布局、热重载 |
| [CLI Reference](./cli-reference.md) | `cortex`、`cortex-task`、`cortex-run` — 每个子命令和标志 |
| [Backends](./backends.md) | Claude Code vs PI，功能矩阵，回退，费用报告 |
| [Architecture](./architecture.md) | 服务器层、WS 协议、事件总线 |
| [Threads](./threads.md) | 多智能体管道、模板、转换、钩子 |
| [Tasks](./tasks.md) | TASKS.yaml 格式、生命周期、分发、cortex-run 看门狗 |
| [Memory](./memory.md) | EXP/K/PAT 原子化知识、项目日志治理 |
| [Skills & Plugins](./skills-and-plugins.md) | 技能编写、插件布局、第三方插件 |
| [Scheduling](./scheduling.md) | Interval/daily/weekly/once 调度、preCheck、回退 |
| [Safety & Approvals](./safety-and-approvals.md) | 影响范围等级、审批工作流、审计追踪 |
| [Hooks](./hooks.md) | 钩子生命周期、hook-bridge、settings.json 中的自定义钩子 |
| [MCP](./mcp.md) | Cortex 按权限拆分的 MCP 服务器、第三方 MCP |
| [Cross-machine](./cross-machine.md) | cortex-client 部署、远程工具、网络拓扑 |

## 开发 Cortex

```bash
# 克隆并安装依赖
git clone https://github.com/<your-org>/cortex
cd cortex/agent-server && npm install

# 构建
npm run build

# 运行测试
npm test

# 在开发模式下启动（通过 .restart watcher 热重载）
npm run build && npm start
```

### 架构

Cortex 的核心 workspace 与 plugin 包如下：

| 包 | 目录 | 角色 |
|---------|------|------|
| `@cortex-agent/server` | `agent-server/` | 控制面、聊天适配器、任务分发、调度与线程编排 |
| `@cortex-agent/client` | `client/` | 通过客户端 WebSocket 执行工具的远程工作器 |
| `@cortex-agent/web` | `web/` | 浏览器、桌面与移动端共用的工作台 SPA |
| `@cortex-agent/desktop` | `desktop/` | 面向 Linux、macOS、Windows 与 Android 的 Tauri 壳 |
| `@cortex-agent/ui-contract` | `packages/ui-contract/` | 服务器与工作台之间的共享类型契约 |
| `@cortex-agent/deepseek-relay-worker` | `packages/deepseek-relay-worker/` | 用于 DeepSeek API 出站访问的鉴权 Cloudflare Worker |
| Plugins | `plugins/` | 由线程智能体在运行时加载的角色限定技能 |

服务器在六层（`src/`）中组织：core utilities → persistence → event bus → domain logic → orchestration → entry points。所有代码更改必须有测试覆盖。完整架构见 [architecture.md](./architecture.md)。

## License

MIT
