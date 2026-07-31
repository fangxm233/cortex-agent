# 安全和审批 {#safety-and-approvals}


Cortex 可以编辑文件、生成进程、管理 GPU 训练以及与多台机器通信。安全与审批系统定义了智能体可以自主做什么、什么需要你的签字确认、以及什么永远不允许。它还提供了让你从 Slack 查看和审批挂起操作的机制。审批流程建立在 hook-bridge（参见 [hooks.md](./hooks.md)）和 MCP 工具（参见 [mcp.md](./mcp.md)）之上。

## 三个影响范围等级 {#the-three-blast-radius-classes}

Cortex 将每个智能体操作分类到三个桶中。分类位于根 CORTEX.md 的"安全边界"部分，是单一真相来源。判断标准是**行为影响**，而不是文件类别——修正技能文件中的拼写错误和向其中添加新工作流步骤是不同级别的操作，即使两者都触及 `.claude/skills/`。

### 自助（自主执行） {#self-serve-autonomous}

智能体无需询问即可执行的操作。这些是只读信息收集、本地状态更新和低风险维护。

- 读取文件、检查 GPU 状态、读取日志、小型测试脚本
- 更新上下文文件（STATUS.md、experiments/、knowledge/、OVERVIEW.md、TASKS.yaml）
- 网络搜索、知识扫描
- 在预算内启动训练运行（需要 GPU preflight）
- 运行分析脚本
- 技能维护性更改（修正拼写错误、对齐格式、描述文字润色——不改变行为）
- Agent-server 非行为性修复（语法错误、日志消息、注释更新）

### 需要审批（需要签字） {#needs-approval-requires-sign-off}

更改系统行为、消耗大量资源或难以撤销的操作。这些被排队到 PENDING_APPROVALS.md 并在你批准之前被阻止。

- 修改 CORTEX.md 或 CLAUDE.local.md
- 新建技能或技能行为性更改（新触发条件、新工作流步骤、能力扩展）
- Agent-server 行为性或架构性更改（新功能、协议变更、API 变更）
- 超预算的训练任务、大规模架构修改
- 删除文件或数据
- 修改模型代码或训练配置
- 终止 app.js 或守护进程

### 禁止（永不允许） {#forbidden-never-permitted}

即使你请求审批，智能体也会拒绝的操作。这些是可能使机器不稳定的系统级更改。

- 安装系统级软件包
- 修改系统配置
- `rm -rf`

### 决策表 {#decision-table}

来自安全边界的判断示例，供分类边缘情况时参考：

| 操作 | 等级 | 原因 |
|---|---|---|
| 修正技能 SKILL.md 中的拼写错误 | 自助 | 维护性，不改变行为 |
| 向技能添加新工作流步骤 | 需要审批 | 改变行为逻辑 |
| 修复 agent-server 语法错误 | 自助 | 非行为性修复 |
| 向 agent-server 添加新守卫逻辑 | 需要审批 | 改变行为 |
| 在预算内启动 GPU 训练 | 自助 | 预算内，但需要 GPU preflight |
| 修改 CORTEX.md 规则 | 需要审批 | 系统约定变更 |

## 智能体如何决策：`need-approval` 技能 {#how-the-agent-decides-the-need-approval-skill}

在执行任何非平凡操作之前，智能体运行 `need-approval` 技能（位于 `plugins/cortex-stage-gate/skills/need-approval/`）。该技能执行三步流程：

1. **分类**操作，对照 CORTEX.md 的安全边界规则。该技能有分类表的同步副本，并应用相同的判断启发式。

2. **如果需要审批**，将操作记录到 `~/.cortex/context/PENDING_APPROVALS.md`，附带足够的细节让你无需追问即可决定。条目格式为：

   ```markdown
   ## [timestamp]
   - **操作**：[将要做什么的简洁描述]
   - **原因**：[为什么需要此操作]
   - **影响**：[它影响什么——文件、机器、资源]
   - **命令/动作**：[要执行的具体命令或更改]
   - **状态**：pending
   ```

   然后智能体输出 `Queued for approval: [一行摘要]` 并阻止进一步操作。

3. **如果不需要审批**，智能体输出 `No approval needed — safe to execute.` 并直接继续。

指导原则是：有疑问时，排队。宁可过度询问也不要破坏东西。

## 你如何批准或拒绝 {#how-you-approve-or-reject}

### 通过 Slack（主要路径） {#via-slack-primary-path}

在你的管理私信频道中使用 `/approval` 命令（管理频道如何配置参见 [slack-setup.md](./slack-setup.md)）。`approval` 技能（cortex-system 插件的一部分）读取 PENDING_APPROVALS.md 并展示每个挂起项。回复 `approve 1` 或 `reject 2` 对特定条目进行操作。

对于 ExitPlanMode 工作流，Cortex 呈现一个带有 **Approve** 和 **Provide Feedback** 按钮的交互式 Slack 消息。点击 Approve 通知智能体继续执行计划。点击 Provide Feedback 打开一个模态框，你可以在其中输入拒绝原因——智能体接收该文本并可以修改计划。

### 之后发生什么 {#what-happens-after}

- **已批准**：智能体执行排队的操作。PENDING_APPROVALS.md 条目更新为 `状态：已批准`，带时间戳。
- **已拒绝**：操作不被执行。条目更新为 `状态：已拒绝`。智能体可能提出替代方案。
- **超时**：hook-bridge 中的挂起请求在 30 分钟后过期。如果你在该窗口内未在 Slack 中响应，智能体的钩子超时并将再次提示。

## Slack 审批流程详解 {#slack-approval-flow-in-detail}

有两种不同的审批路径，取决于触发用户交互的原因。

### 计划审批（ExitPlanMode） {#plan-approval-exitplanmode}

当智能体调用 ExitPlanMode（通常在执行线程期间），流程为：

1. 智能体的 PreToolUse 钩子触发，向 `agent-server:3001/hook/exit-plan-mode` 发送 HTTP POST，包含计划内容。
2. hook-bridge（`agent-server/src/orchestration/routing/hook-bridge.ts`）在内存 `pendingRequests` 映射中注册请求（30 分钟 TTL），并在事件总线上发布 `plan.submitted` 事件。
3. hook-bridge 订阅者（`agent-server/src/orchestration/routing/hook-bridge-subscribers.ts`）接收事件，在 `PlanApprovals` 单例中注册计划，并发布带有 Approve 和 Provide Feedback 按钮的交互式 Slack 消息。
4. 当你点击按钮时，Slack 交互处理程序（`agent-server/src/orchestration/interactions/interaction-handlers.ts`）解析或拒绝计划：
   - **批准** → 在事件总线上发布 `plan.approved`，解析挂起的 HTTP 请求，智能体的钩子脚本返回成功，允许智能体继续。
   - **拒绝** → 挂起的 HTTP 请求以 `approved: false` 和你的反馈文本解析，智能体接收并可据此修改。

### 用户问题（AskUserQuestion） {#user-questions-askuserquestion}

当智能体调用 AskUserQuestion（例如，澄清设计选择），流程结构相同但使用不同的事件：

1. HTTP POST 到 `agent-server:3001/hook/ask-user-question`，带问题定义。
2. hook-bridge 在事件总线上发布 `ask-user.requested`。
3. 订阅者发布带有 **Answer** 按钮的 Slack 消息。
4. 点击 Answer 打开一个模态表单（每问题单选、多选或文本输入）。
5. 模态框提交时，处理程序发布 `ask-user.answered` 并以用户的答案解析 HTTP 请求。

### PI 后端的差异 {#pi-backend-difference}

PI 编程智能体后端使用不同的解析机制。PI 的计划和问题响应不通过解析 HTTP 请求，而是通过 `sendExtensionUiResponse()`——一个 PI 原生的扩展 UI 回调。hook-bridge 为此路径提供非阻塞发布辅助函数（`publishPlanSubmitted`、`publishAskUserRequested`）。

## 为什么不给智能体 root 权限 {#why-the-agent-isnt-given-root}

Cortex 以启动它的用户相同的权限运行。没有 `sudo`、没有 Docker socket、没有权限提升路径。禁止桶（安装系统软件包、修改系统配置、`rm -rf`）的存在是为了防止智能体即使拥有 Unix 权限也不能使机器不稳定。

在远程机器上，`cortex-client` 进程也以启动它的用户身份运行——没有权限提升。服务器和客户端之间的 WebSocket 协议没有认证令牌（它信任网络边界），因此客户端只应在 localhost 或 Tailscale/VPN 边界内暴露。

## 审计追踪 {#audit-trail}

审批记录在三个地方：

1. **PENDING_APPROVALS.md** — 每个排队的操作在此附加，包含完整细节和最终状态（approved/rejected）。这是人类可读的审计追踪。
2. **事件总线 JSONL** — `plan.submitted` 和 `plan.approved` 事件由事件记录器持久化到 `~/.cortex/data/` 中按日滚动的 `events-YYYYMMDD.jsonl` 文件。
3. **Slack 对话** — 每次审批交互在 Slack 中留下可见的消息，带有 Approve/Provide Feedback 按钮或问题模态框。对话历史是运行记录。

## 配置 {#configuration}

安全边界分类位于 `~/.cortex/CORTEX.md` 的根 CORTEX.md 中"安全边界"部分。`need-approval` 技能维护一个同步副本。如果你修改安全边界规则，更新两个位置。

PENDING_APPROVALS.md 文件位于 `~/.cortex/context/PENDING_APPROVALS.md`。首次使用时自动创建。

无需额外配置——审批系统内置于智能体的核心推理中，并在智能体考虑高权限操作时自动触发。
