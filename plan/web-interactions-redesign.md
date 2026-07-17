# Web/Mobile 交互卡片(ask-user / plan-approval)根本性重设计

Status: implemented (2026-07-16, commit b2c37324 — Step 2 完整落地;等待 server 重启 + 客户端更新生效)
Supersedes: web-persist-interactions.md, web-persist-interactions-v2.md, web-ask-user-fixes.md

## 症状 → 根因对照

用户报告的三个问题:

1. **卡片不持久化**:切 session / 刷新 / 重启客户端后卡片消失或取不到内容。
2. **plan 审批后出现两个 approved 卡片**,刷新后才恢复为一个。
3. **web 和 mobile 同时在线时,一边操作另一边不自动刷新**(卡片仍可点,点了报错)。

排查结论(文件行号以 2026-07-16 代码为准):

### 根因 1:pending 状态只存在于内存 Map,且 plan 内容根本没存

- pending 状态分散在三个内存 Map:
  - `orchestration/routing/hook-bridge.ts:20` `pendingRequests`(阻塞 resolver,TTL 30min)
  - `orchestration/interactions/ask-user-question.ts:16-18`(question group)
  - `orchestration/interactions/plan-approvals.ts:22,107`(plan approval)
- `PendingPlan`(plan-approvals.ts:8-19)**不存 planContent**。rehydrate 路径
  `entry/app.ts:421-425` 返回 `{requestId, planContent:'', planFilePath:null}`——
  刷新/切 session 后 `sessions.pendingInteraction` 只能拿到空内容的 plan 卡。
  完整内容只在一次性的 `session.planApproval` SSE 事件里出现过。
- server 重启 → 三个 Map 全丢 + 被阻塞的 MCP webhook 断掉,pending 交互双向湮灭,
  UI 无从恢复也无从得知。

### 根因 2:一次审批,三种形状,三处发射

`entry/app.ts:454-480` approve 时同时做:
1. `planApprovals.resolve` → `plan.approved` 事件
2. `conversationHistory.appendInteraction`(持久化 `type:'interaction'` subtype `plan-approved`)
3. `publishSessionMessage({role:'tool', toolName:'plan-approved'})`(live `session.message`)

前端 `transcript-vm.ts:124-126` 按 `type|ts|text|toolName` 去重——(2) 物化为
`interaction` 行、(3) live tail 映射为 `tool` 行(transcript-vm.ts:46-57),形状不同
去重不掉 → 双卡。刷新后 live tail buffer 清空,只剩持久化行,"恢复正常"。
另外操作端还本地乐观 append 一条 `AnsweredRow`(useSessionInteractions.ts:155-165),
是第三份。ask-user-answered / plan-rejected 对称路径(app.ts:449,475)同病。

### 根因 3:没有 "interaction 已解决" 的广播语义

- 事件目录(events/event-types.ts)只有 `session.askUser` / `session.planApproval`
  两个 "pending 到达" 事件,**没有 resolved/retracted 事件**。
- 客户端 B 的 `pendingQuestion/pendingPlan` state 永远不会被清除,
  `sessions.pendingInteraction` 的 invalidate 只发生在操作端的 `onSuccess`
  (useSessionInteractions.ts:146,166,187)。
- B 点已失效的卡 → `planApprovals.resolve` 返回 undefined → tRPC `NOT_FOUND`,
  mutation 报错,死卡也不清除。

### 结构性诊断

三个 bug 是同一个错误的三个症状:**交互状态住在事件里,而不是住在实体里**。
`session.askUser` / `session.planApproval` 事件既是通知又是状态的唯一完整载体;
没有一个持久、可查询、可更新、单一权威的 interaction 实体。UI 侧被迫用
"SSE 事件 + 内存 Map rehydrate + 本地乐观行 + transcript 持久行" 四路数据源
拼一个卡片,四路形状互不相同,于是丢失、重复、失同步全部出现。
(Slack 路径没有这些问题,因为它天然是实体模型:一张卡片消息,原地编辑状态。)

## 目标设计:Interaction 一等实体 + "事件是提示,查询是真相"

### 1. 数据模型:持久化 interaction 实体

新增 interactions 存储(建议并入 per-session conversation-history JSONL,
用 created/resolved 两条事件在物化时 reduce;或独立 `interactions.jsonl` repo,
实现取舍见 §6):

```ts
interface InteractionRecord {
  id: string;                    // = hook requestId,稳定主键
  sessionId: string;
  channel: string;
  kind: 'ask-user' | 'plan-approval';
  payload: {                     // 创建时全量落盘 —— 修根因 1
    questions?: AskQuestion[];
    planContent?: string;
    planFilePath?: string | null;
    summary?: string;
  };
  status: 'pending' | 'answered' | 'approved' | 'rejected'
        | 'expired' | 'cancelled';   // 重启孤儿与 TTL 超时统一归 expired,
                                     // resolvedVia 区分 'timeout' | 'restart'
  result?: { answers?: Record<string,string>; reason?: string };
  createdAt: string;
  resolvedAt?: string;
  resolvedVia?: 'web' | 'slack' | 'timeout' | 'restart' | 'command';
}
```

### 2. 生命周期:状态机,所有路径收敛到同一实体

- **created**:hook-bridge register 时写入 record(status pending, payload 全量),
  再 publish 状态变更事件。
- **resolved**:web mutation / Slack action / TTL 超时 / `!new` 清场 / 重启孤儿回收,
  全部走同一个 `resolveInteraction(id, status, result)`:更新 record →
  resolve 阻塞的 webhook → publish 状态变更事件。first-writer-wins,
  二次提交返回 `already-resolved`(带最终状态),不再是 NOT_FOUND 报错。
- **重启处理(已确认,2026-07-16)**:不做恢复。启动时扫描 pending record,
  由于阻塞 webhook 已死,统一标记 `expired`(resolvedVia:'restart')并广播。
  UI 显示灰化的"已过期"卡而非凭空消失。修根因 1 的重启分支。
- TTL 到期同样更新实体 + 广播(替代现在 hook-bridge 里静默 resolve timeout)。

### 3. 事件语义:单一事件类型,只做通知

废弃 `session.askUser` / `session.planApproval` 作为内容载体,新增:

```
session.interaction  { sessionId, interactionId, status }
```

- created 和每次状态变更都发这一个事件。payload 只带 id + status(提示),
  客户端收到后 invalidate / 定点拉取实体(`sessions.interaction({id})` 或
  invalidate transcript)。事件丢失无害——查询是权威,重连时 refetch 即收敛。
- 所有订阅该 session 的客户端(web、mobile、多标签页)收到同一事件,
  同步收敛到同一实体状态。修根因 3。

### 4. 渲染模型:interaction 是 transcript 中的一行,不是流外的 slot

- transcript 查询把 interaction record 物化为 `kind:'interaction'` 的 ChatRow
  (稳定 id = interactionId),按 createdAt 插入消息流。
- 同一行随实体状态变换形态:pending → 渲染问题/plan 内容 + 操作按钮;
  approved/answered/rejected → 渲染结果摘要;expired/cancelled → 灰化。
  与 Slack 的"原地编辑卡片"模型对齐。
- **删除**三处冗余发射:`publishSessionMessage`('plan-approved'/'plan-rejected'/
  'ask-user-answered' 三条,app.ts:449,463,475)、前端乐观 `AnsweredRow`
  (useSessionInteractions.ts)、`appendInteraction` 双写(若 record 并入
  conversation-history 则它就是唯一写入)。一份实体 → 一行渲染,重复不可能发生。
  修根因 2。
- 前端删掉 `useSessionInteractions` 的三个 useState 数据源,pending 卡片不再是
  独立 slot;`sessions.pendingInteraction` 查询可保留为"是否有待办"的轻量指示
  (badge 用),或直接由 transcript 派生。

### 5. 并发与幂等

- `answerQuestion` / `respondPlan` 改为按 interactionId 幂等:已解决则返回
  `{code:'already-resolved', status, resolvedVia}`,前端将卡片切到最终状态并
  toast "已在其他客户端处理"。
- record 更新在 repo 层加互斥(现有 async-mutex 模式),防止 web/Slack 同刻竞争。

### 6. 存储实现取舍

- **方案 A(推荐)**:并入 per-session conversation-history JSONL,append
  `interaction.created` 与 `interaction.resolved` 两条事件,transcript 物化时
  reduce 成单行。优点:天然按 session 归档、随 transcript 一起分页、无新 repo;
  append-only 与现有 JSONL 纪律一致。
- 方案 B:独立 `interactions.jsonl` repo(store 层第 13 个 repo),transcript
  查询时 join。优点:全局可查(审批中心可复用);缺点:两处数据源 join、归档另做。
- plan payload 可能较大(整个 plan 文件内容):方案 A 下直接入 JSONL 可接受
  (与长消息同量级);如担心膨胀,payload 存 planFilePath、物化时读文件,
  但需处理文件被后续修改的问题——建议直接快照内容。

## 迁移路径

分两步落地,每步独立可验证:

**Step 1 — 止血(不动架构,~4 个小改)**:
1. `PendingPlan` 存 `planContent`/`planFilePath`,rehydrate 返回全文(修刷新后空卡)。
2. 新增 `session.interactionResolved` 事件,`answerQuestion`/`respondPlan`/超时/
   `!new` 时广播;客户端收到后清 pending state + invalidate(修多端失同步)。
3. 删 `publishSessionMessage` 三处双发 + 前端乐观 `AnsweredRow`,resolve 后统一
   靠 transcript 的 interaction 行(修双卡)。
4. `respondPlan`/`answerQuestion` 对已解决的请求返回 already-resolved 而非
   NOT_FOUND,前端优雅降级。

**Step 2 — 实体化重构(修根本)**:按 §1-§6 落地 InteractionRecord + 单一
`session.interaction` 事件 + transcript 内联渲染,删除 `session.askUser`/
`session.planApproval` 内容载体事件与 `useSessionInteractions` 的 slot 模型;
重启时把遗留 pending 标记 expired(不恢复)。Step 1 的 interactionResolved 事件在此步被 `session.interaction`
取代。

若只做 Step 1,三个可见症状都会消失,但状态仍住在内存里(重启仍丢、
仍有四路数据源);Step 2 才是与 Slack 路径对齐的正确形态。

## 实现细节定稿(2026-07-16,代码勘察后)

- **存储 = 方案 A**:conversation-history JSONL 增加两种 interaction 记录形态:
  - created:`{type:'interaction', ts, id, kind, status:'pending', payload, text}`
  - resolved:`{type:'interaction', ts, id, status, result?, resolvedVia, text}`
  - legacy 行(`{subtype, text}`)继续可读渲染。
  - `getHistory` 读时按 id 归并:created 行占位,resolved 行原位更新
    status/result/resolvedVia/text。repo 新增 `appendInteractionCreated` /
    `appendInteractionResolved`,删除旧 `appendInteraction`。
- **实体服务** `orchestration/interactions/interaction-records.ts`(单例,
  init(history,bus)):create/resolve/get/getPendingByChannel/resolvePendingByChannel。
  in-memory index(id→{sessionId,channel,kind,status,payload,createdAt})既是
  快速查询也是**存活判据**:重启后 index 为空 ⇒ 读取端把 JSONL 里仍 pending 的
  记录派生为 expired——无需启动扫描、无需 lazy 写。resolve 幂等:terminal 状态
  二次 resolve 返回 'already-resolved'。
- **派生过期规则**(transcript 物化,query/sessions.ts):
  `status==='pending' && (!deps.isInteractionPending(id) || age>30min) → 'expired'`。
- **TTL 广播**:hook-bridge `cleanupStale` 增加 `setOnStale(cb)`,app.ts 接线到
  `interactionRecords.resolve(id,'expired','timeout')` + 清 group/plan Map。
- **事件**:`session.interaction {sessionId, channel, interactionId, kind, status}`,
  created 与每次状态变更各发一次;subscribe.ts 的 sessionId 后置过滤天然适用。
  删除 `session.askUser` / `session.planApproval`。
- **pendingInteraction 查询保留**(旧客户端兼容 + 修 planContent 为空的 bug),
  改由 interactionRecords 提供全量 payload。
- **mutation 返回**:`answerQuestion`/`respondPlan` 返回
  `{outcome:'resolved'|'already-resolved'}`,不存在 → not-found err;
  deps 签名改为返回三态 union。删除 app.ts 三处 publishSessionMessage 双发。
- **!new**:handleNewCmd 追加 `interactionRecords.resolvePendingByChannel(channel,
  'cancelled','command')`。
- **前端**:
  - ChatRow 'interaction' 增加 `detail?: {id, kind, status, payload, result}`,
    msgKey 用 interaction id;新 pure vm `interaction-vm.ts` 做 payload→卡片映射。
  - 共享组件 InteractionRowCard:pending→AskQuestionCard/PlanApprovalCard,
    resolved→摘要行,expired/cancelled→灰化行,legacy→旧 InteractionRow。
    桌面 ChatRows 与移动 MChatStream 都走它,通过 onInteraction 回调束传入动作。
  - `useSessionMessageLiveSync` 订阅列表加 `session.interaction`(收到即
    invalidate transcript,不入 live tail)。
  - 删除 `useSessionInteractions` 及 interactionsSlot / pendingQuestion /
    pendingPlan / answeredQuestions 全套 slot 模型;新
    `useInteractionActions(sessionId)` 只暴露三个 mutation 回调
    (成功/已被他端处理都 invalidate transcript)。

## 涉及文件(Step 2 主清单)

- `agent-server/src/orchestration/routing/hook-bridge.ts` — resolver 与实体解耦
- `agent-server/src/orchestration/interactions/{ask-user-question,plan-approvals}.ts`
  — 收敛为实体状态机的适配层(或删除,逻辑并入 interaction service)
- `agent-server/src/store/conversation-history-repo.ts`(方案 A)或新 repo(方案 B)
- `agent-server/src/events/event-types.ts` — `session.interaction`
- `agent-server/src/orchestration/routing/hook-bridge-subscribers.ts` — 改发新事件
- `agent-server/src/domain/ui-service/{types,query/sessions,mutate/sessions,app-router}.ts`
- `agent-server/src/entry/app.ts` — deps 重接线,删三处双发
- `packages/ui-contract` — InteractionRecord 类型与事件 payload 进 contract
  (顺带修掉前端手写 RawAskUserPayload 的类型缺口)
- `web/src/features/workbench/{useSessionInteractions,transcript-vm,MessageStream}.tsx`
- `web/src/mobile/v3/{MChatView,MChatScreen,m-chat-vm}.ts(x)`
