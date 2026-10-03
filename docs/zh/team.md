# 团队模式 {#team-mode}

团队模式让一个对话就能带一支团队。你只和一个会话对话，即**主会话（lead）**。它把工作交给若干持久的
**worker** 会话，之后可以让它们接着干，替你回答它们的问题，并告诉你结果。你不用为了给某件事一份独立
的上下文去新开会话，也不用操心哪个对话该接着做什么；这些由主会话负责。

团队模式是实验性功能，默认关闭。在 **设置 → 高级 → 团队（实验性）** 中开启，或在 `settings.json`
里设置 `teamEnabled`（`CORTEX_TEAM_ENABLED=1`）。

## 主会话与 worker {#leads-and-workers}

团队模式开启后，每个网页会话都能当主会话。在真正创建 worker 之前，会话本身没有任何变化：没有 worker
的会话看起来、用起来都和普通会话一样，唯一的区别是工具列表里多了一组 `worker_*` 工具。

worker 是隶属于某个主会话的普通会话。它有自己的 transcript、上下文和续跑历史，和其他会话一样可以跑在
Claude 或 PI 上，拥有完整的工具面，包括一次性的 `agent` 工具。它不能再创建自己的 worker，所以团队只有
一层。worker 继承主会话的项目，并运行主会话当前所用的模型，包括在输入框里选的模型、provider 和 thinking 级别。
主会话可以传 `backend` 和 `model`，格式与 `agent` 工具相同（PI 用 `provider/model[:thinking]`，Claude 用
裸模型 id）：同一后端上的 model 只替换它写出的部分；换到另一个后端时从该后端的默认 profile 起步，因此
Claude 主会话可以带 PI worker，反之亦然。PI 模型所属的 provider 若有自己的 profile，就在那个 profile 上运行。创建 worker 不会改变新对话默认打开的模型。

主会话按后续需要来选 worker 还是一次性 `agent`：可能需要后续接续、运行时间长、或可能要来回沟通的工作
交给 worker；有边界的侦察或验证、结果马上就用的，交给 `agent`。

## 工作如何流转 {#how-work-flows}

```
你 ⇄ 主会话 ── worker_spawn / worker_send ───────────▶ worker
       ▲  ◀── 每轮结束时的汇报 ──────────────────────┤
       │  ◀── 提问 / 计划审批通知 ───────────────────┤
       └──── worker_answer ─────────────────────────▶（挂起的请求被解决）
你 ──────────── 直接打开 worker 与它对话 ────────────▶ worker
```

**派活从不阻塞。** `worker_spawn` 和 `worker_send` 立即返回。主会话结束本轮，worker 的汇报稍后会唤醒
它。发给正在运行的 worker 的消息会并入它当前这一轮；发给空闲的 worker 则开启新的一轮。服务器即将重启
时，这两个工具会返回错误而不派活，主会话在重启后再试。

**汇报。** worker 的一轮结束时，它的最终回复会作为一条消息投递给主会话，开头是
`[Worker <名字> · completed|failed|stopped]` 加一行状态。由 worker 自己的后台 agent 或 waitpoint 唤醒
的轮次也会汇报。你自己在 worker 里输入而开启的轮次不汇报；主会话的名单会把这个 worker 标记为你直接
对话过。服务器重启不会丢失汇报：在重启等待期间结束的轮次，会在服务器恢复后送达主会话。

**提问与计划。** worker 调用 `cortex_ask_user`、用 `cortex_plan_exit` 提交计划、或提交委托契约时，请求
会同时以卡片出现在 worker 的会话里，并以通知出现在主会话的对话中。主会话用 `worker_answer` 作答，它可
以自行回答问题、批准计划，拿不准你的意思时会用 `cortex_ask_user` 问你。你也可以直接在 worker 的卡片上
作答；先到的答案就是 worker 收到的答案。

**名单。** 主会话有在岗 worker 时，它的每一轮开头都有一个简短的 `[Team]` 块：几条工作规则，加上每个
worker 一行（状态、职责、上次汇报、上下文用量，以及你是否直接和它对话过）。worker 的第一轮开头有一个
`[Worker]` 块，告诉它主会话是谁、它的回复会怎样被使用。

## 工具 {#tools}

主会话的工具来自 `cortex-workers` MCP bundle（见 [MCP](./mcp.md)）。

| 工具 | 参数 | 作用 |
|---|---|---|
| `worker_spawn` | `name`, `prompt`, `backend?`, `model?` | 用一个短名启动 worker 并交给它第一个任务 |
| `worker_send` | `worker`, `message` | 让 worker 接着干、改变方向或补充信息；会唤回已退役的 worker |
| `worker_list` | `worker?` | 名单；或某个 worker 的详情，含其模型和完整的上一份汇报 |
| `worker_stop` | `worker`, `retire?` | 停止 worker 当前这一轮；`retire` 同时把它移出名单 |
| `worker_answer` | `request_id`, `answers?` 或 `approved?` + `feedback?` | 回答 worker 的问题，或批准、驳回它的计划 |

## 工作台中的呈现 {#in-the-workbench}

- 侧栏把主会话的 worker 嵌套在它下面，用展开箭头和 worker 数量收起。主会话的状态点汇总它的 worker，已
  退役的 worker 排在最后并淡化显示。
- 主会话的聊天页在标题下方显示一行紧凑的 worker 芯片，每个芯片带有 worker 的状态点，点击即可打开该
  worker。
- 在手机端，会话列表不列出 worker，由主会话这一行代为显示它们的状态：任一 worker 运行时显示为运行中，
  任一 worker 有未读时显示为未读。worker 从主会话聊天页的芯片打开。已退役的 worker 不在芯片里，也不计入
  这两种状态。
- worker 的标题前显示主会话的标题，点击可回到主会话。输入框和任何会话一样可用，所以你可以直接和
  worker 对话。
- 等待主会话作答的 worker 显示空心圈和「等待主会话」。琥珀色的点只留给必须由你回答的请求。
- 在 worker 的 transcript 中，来自主会话的消息显示为带「来自主会话」标签的用户消息。在主会话的
  transcript 中，汇报和请求显示为单行的「Worker 汇报」「Worker 请求」，可以展开看全文。

## 限制 {#limits}

- 一个主会话同时最多运行八个 worker。
- 只有网页会话能当主会话。Slack、飞书和定时任务会话不加载 worker 工具。
- 阻塞的提问或计划最多等待 30 分钟，与所有交互相同；服务器重启后，挂起的请求不会保留。
- worker 发送的文件、视图和决策出现在 worker 自己的会话里。worker 会在汇报中写明路径，主会话可以再转
  交给你。
- worker 的存续跟随主会话。会话保留策略会把主会话和它的 worker 一起清理。
- 团队模式关闭时，主会话从下一轮起不再有 worker 工具和名单，汇报和请求转交也会停止；已有的 worker 变回
  普通会话，它们的问题直接交给你。
