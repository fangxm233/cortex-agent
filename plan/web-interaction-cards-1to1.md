# Plan 审批 + Agent 提问 UI — 1:1 完整实现

Status: PLAN (awaiting approval)
Builds on: web-interactions-redesign.md (interaction 实体层已落地 2026-07-16)
Ground truth: `context/projects/cortex-self/design/ref/scheme-mobile.dc.html` **§4 / §5 / §6**
+ `scheme.dc.html` **13b / 13c**（用户指定，样式严格遵循）

## 现状 vs 设计的差距

实体层（后端）已完备：`TranscriptInteractionDetail`（questions[]{options,multiSelect} /
planContent / planFilePath / result{answers,feedback} / status 状态机）、
`sessions.answerQuestion`（answers: Record<question,string>，multi-select 平台约定 ", " join）、
`sessions.respondPlan`（approved+feedback）、`session.interaction` SSE 收敛、30m TTL
（`query/sessions.ts INTERACTION_TTL_MS`，从行 ts 起算）。**本计划纯前端（web/），零后端改动。**

前端现状是简化版，与指定设计差距：

| 处 | 现状 | 设计要求 |
|---|---|---|
| 提问卡 | 单问题卡；点一个选项 = 所有问题都填同一答案（bug 级简化）；无 TTL、无多选、无自由输入 | 13b：一卡多问，单选 ○/● / 多选 ☐/☑ chips + 「其他…」展开输入框，答完一次「提交回答」；5b（移动）：逐问推进——已答封绿行、当前题展开、后续题压暗排队，TTL 整卡计时，composer 可直接输入回答当前题 |
| Plan 卡 | 把 planContent 逐行伪造成「步骤」列表；驳回无反馈输入 | 13c/6a：**薄卡** = badge + 标题 + **文件行主入口** + 批/驳，无步骤摘要；驳回必附反馈（13c 卡内展开琥珀输入框；5a 移动端 composer 进驳回模式 + 原因 chips） |
| Plan 全文 | 无处可读 | 6b：下钻阅读页渲染 plan markdown，底部常驻批/驳，未读完主按钮显示已读 %，封存后同页只读 |
| 封存态 | 单行 summary | 4a/4b/4c：原地封存卡（绿 ✓ 已回答/已批准、灰已驳回+删除线），可点展开回看，4c 反馈以用户气泡入流 |
| 会话 header | 只有 running/idle | 待批时琥珀点「计划待批 · 线程已暂停」/「等待你的回答 k/n · 线程已暂停」 |

## 改动设计（全部在 `web/src/`）

### Phase 1 — 共享纯 VM 层（TDD 先行）

1. `features/workbench/transcript-vm.ts`：interaction ChatRow 增加 `ts`（源 `TranscriptMessage.ts`，
   已有字段，非伪造）— 供时间戳徽标 + TTL 倒计时。
2. `features/workbench/interaction-vm.ts` 扩展（保持纯函数 + 单测）：
   - `planCardModel(detail, ts)`：title = planContent 首个 markdown 标题（剥 `#`；fallback 文件名
     basename；再 fallback 'Plan'）、`filePath`、`lineCount`（真实行数，6b「128 行」）、状态、
     `feedback`、HH:MM 时间。**删除现在的伪造 steps 解析。**
   - `askCardModel(detail)`：全部问题（含 multiSelect/options/description）+ `result.answers`。
   - `askAnswerReducer`（5b/13b 共用的作答状态机）：per-question 已答 map、当前题 index、
     多选选中集、「其他/自定义」自由文本；`buildAnswers()` → Record<question,string>
     （多选按平台约定 ", " join）；全部答完 → 可提交。
   - `interactionTtl(ts, now)`：`ts + 30min - now`（与服务端 INTERACTION_TTL_MS 一致，非伪造），
     配 `formatTtl` 复用。
3. `mobile/v3/m-chat-vm.ts`：`ChatHeaderStatus` 增加 `tone: 'running'|'idle'|'waiting'`（琥珀点），
   新增 `interactionHeaderStatus(pendingKind, answered, total)` → 「计划待批 · 线程已暂停」/
   「等待你的回答 k/n · 线程已暂停」。

### Phase 2 — 移动端（scheme-mobile 4/5/6，`mobile/v3/`）

4. 新 `MInteractionCards.tsx`（替换 MChatView 里 1m/1n 旧卡在流中的使用；旧
   `AskQuestionCard`/`PlanApprovalCard` 删除——desktop 也不再引用，见 Phase 3）：
   - **MAskCard**（5b + 4a）：badge「Agent 提问 · k/n」+ id + TTL「MM:SS 后按默认继续」；
     已答题 = 灰底绿 ✓ 行「问题 → **答案**」；当前题 Q{k} 展开选项（首选项「默认」徽标，
     option.description 作右侧 meta，仅真实存在时渲染）；后续题虚线压暗「待答」；
     multiSelect 题：选项可多选 ☑ + 「确认」行（移动端设计未画多选，按 13b 语义补，标注）；
     「自定义…」→ composer 输入路径；答完最后一题一次性 `answerQuestion` 提交。
     封存态（4a）：「✓ 已回答」绿 badge + 问题（muted）+ 所选答案行；可点展开回看全部选项。
   - **MPlanCard**（6a + 4b/4c）：薄卡 = 「计划待批」badge + ExitPlanMode + HH:MM；标题；
     **文件行主体**（文件 icon + path + 「批准前建议通读全文」+ 阅读 ›）→ 6b 阅读页；
     「批准并执行」/「驳回并反馈」（44px）；footer「批准 = 开始执行」（`来自 X` 无数据源→省略，
     标注 GAP）。已批准（4b）：绿「✓ 计划已批准」+ 「HH:MM 由你批准」+ muted 标题 +
     footer path + 查看完整计划 ›。已驳回（4c）：灰「已驳回」+ 删除线标题 + footer
     「· 重规划将改写」+ 查看原计划 ›；`result.feedback` 紧随其后渲染为用户气泡（真实数据）。
5. **6b 阅读页**：新路由 `/m/session/:sessionId/plan/:requestId`（`MPlanReadScreen` +
   `MPlanReadView` + `m-plan-read-vm`）。数据取自 `sessions.transcript`（实体已含全文快照）。
   header：‹ 返回 + 标题 + `path · N 行 · 状态` + 状态 pill + 顶部 3px 阅读进度条（滚动 %）；
   正文：白底 `ChatMarkdown` 渲染 planContent + 底部渐隐；底部常驻操作条：待批 =
   「批准并执行」（未读完时副行「已读 N% · 下滑读完或直接批准」）+「驳回并反馈」（→ 返回会话
   并武装驳回模式，router state 传递）；封存后同页只读、操作条换状态戳。
6. **5a 驳回模式**（`MChatScreen` + `MChatView` 扩展）：点「驳回并反馈」→ 卡片压暗（opacity .55、
   按钮收起为「查看完整计划 ›」行）；composer 上方琥珀上下文条「驳回「{title}」— 说明原因后发送」
   + ✕ 取消；常见原因 chips（范围太大 / 先做 dry-run / 成本超预期 / 步骤顺序不对——静态快捷插入文案）
   点选追加进输入框；composer 边框转琥珀 `#C99A2E` + 光晕；空文本发送置灰；发送 =
   `rejectPlan(id, text)` 即驳回。
7. **composer 作答路由**：存在 pending 提问卡时 placeholder 变「点选项，或直接输入回答 Q{k}…」，
   发送的文本作为当前题的自由回答（不走 `sessions.send`）。
8. header 状态接入（Phase 1 的 `interactionHeaderStatus`，从 rows 派生 pending interaction）。

### Phase 3 — 桌面端（scheme 13b/13c，`features/workbench/`）

9. 新 `InteractionCards.tsx`（desktop 专属，替换现在复用移动卡的 `InteractionRowCard` 内体；
   解除 desktop→mobile 组件耦合）：
   - **AskCard 13b**：靛蓝卡 `#C9CFF2`/`#FBFBFE`；header = ? 圆徽 + 「需要你拍板」pill +
     `AskUserQuestion` mono + 右侧「阻塞中 · TTL MM:SS」（真实倒计时）；全部问题同屏，
     每题「单选/多选」小标签；选项 = ○/●（单选）/ ☐/☑（多选）chips；「其他…」选中才展开
     自由输入框；底部说明行 + 「提交回答」单按钮（未答完置灰）。
     封存态：灰化卡 + 「已回答」pill + 逐题 `✓ 问题 → 答案` 行（源 `result.answers`）。
   - **PlanCard 13c**：header 条（「PLAN · 等待批准」pill + ExitPlanMode + 「线程暂停中 · TTL MM:SS」）；
     标题；文件行（icon + path + 「已写入 · 批准前建议通读全文」+ 阅读 ›）；footer
     「批准 = 开始执行」+「请求修改」+「批准计划」。点「请求修改」→ 卡内展开琥珀输入框
     （1.5px `#C99A2E` + 光晕），footer 换「反馈必填 · 确认后退回重新规划」+「取消」+「确认退回」，
     反馈为空置灰。已批准封存：绿 pill「✓ 计划已批准」+「HH:MM 由你批准」+ muted 标题 + footer
     path「· 线程继续执行」+ 查看计划 ›。已驳回封存：按 4c 语义移植 13c 骨架（灰 pill + 删除线 +
     feedback 气泡）——desktop 设计未画驳回封存态，标注为 4c 同构移植。
10. **PlanReadOverlay**（诚实补充，13c 明言「全文在阅读页看」但桌面稿未画阅读页 → 以 6b 结构
    移植桌面 chrome：居中 modal、`ChatMarkdown` 渲染、阅读进度 + 底部批/驳条/状态戳；
    「阅读 ›」「查看计划 ›」都指向它）。
11. `MessageStream.tsx` 的 `InteractionRowCard` 改为组装新卡；`interactionsCopy` hack 删除，
    换 zh/en copy（沿用现有 per-feature copy 模式 + `useLang`）。

### Phase 4 — 收尾与验证

12. 单测：vm 全部纯函数 TDD（reducer 状态机 / answers 形状 / ttl / title 派生 / header 状态 /
    阅读进度门控）+ 组件渲染测试沿用现有 `MChatView.test.tsx` / render-test 模式。
13. `tsc --noEmit` + `vitest run` + `vite build` 全绿。
14. 活体验证：dev harness + 合成 pending interaction（复用 web-interactions-redesign 的验证路径）
    截图对照 scheme 13b/13c/6a/6b/5a/5b/4a-c，存 `design/build-shots/`。
15. 更新索引：`web/src/features/workbench/CORTEX.md`、`web/src/mobile/CORTEX.md`、本计划标 implemented。

## 诚实占位（不伪造）

- `来自 ablation-sweep › plan` 来源：实体无 source 字段 → footer 左侧省略，只留右侧提示语（GAP 标注）。
- 选项右侧 `+$4.20 · +38m` 成本 meta：仅当 `option.description` 真实存在时渲染其文本。
- 「hook 已同步 Slack」脚注：无数据源 → 省略。
- TTL 倒计时 = 行 ts + 30min（与服务端派生 expired 的常量一致），不是服务端下发的 deadline —— 注释注明。
- 默认徽标沿用现状「首选项 = 默认」约定。

## 风险

- 移动端 multiSelect 无设计稿 → 按 13b 语义在 5b 骨架内补「☑ + 确认」，标注为同构补全。
- 桌面驳回封存态无设计稿 → 4c 同构移植，标注。
- 作答为 session-local 状态（实体一次性 resolve），刷新丢失未提交的部分作答 —— 与「答一题进一题、
  全答完才提交」的设计一致，可接受。
