# Message Edit + Rewind (desktop 23 / mobile 7)

用户可编辑已发送的用户消息 → 回退其后全部会话流 → 用新文本重新生成。
样式契约：`context/projects/cortex-self/design/ref/scheme.dc.html#sec-23`（桌面）、
`scheme-mobile.dc.html#sec-7`（移动）。工作区文件不回滚；附件原样保留；重新生成沿用当前 profile。

## 已有机制（复用，不重建）

Slack 编辑链路已经完整（`orchestration/routing/edit-handler.ts` processEdit）：
ledger `rollbackTo`/`truncateTurns`（conversation-ledger-repo）+ Claude/PI per-turn 备份恢复
（session-backup，`~/.claude/projects/<hash>/<backendSessionId>.jsonl.turn-N.bak`）+
`closeClaudePooledSession`（杀 pooled CLI 使 --resume 重读回滚后的 jsonl）。
关键：web 会话的 ledger + 备份**一直在写**（agent-runner → lifecycle.initTurnTracking）。
id 模型：track sessionId（UI/history/channel `web:<id>`）≠ backendSessionId（resume/备份文件名，
`effectiveBackendSessionId`）。ledger turnIndex 与 history 派生 turnIndex 同为"第 N 条 user 消息"，天然对齐。

## 后端新增

1. `store/conversation-history-repo.ts`
   - `truncateFromTurn(sessionId, turnIndex)`：写链序列化，砍掉从第 turnIndex 条 user 事件起的所有行；
     返回被移除的开头 user 事件（text/ts/attachments）供 marker + 附件复用。
   - raw 行新增 `edit-marker` 类型（originalText/originalTs）；`getHistory` 把 marker 归并到下一条
     user 事件的 `edited` 字段，marker 本身不输出。`appendEditMarker()`。
2. `events/event-types.ts`：`session.rewound {sessionId, channel, turnIndex}`；
   `orchestration/session-events.ts`：`publishSessionRewound`。前端收到后清 live tail 并 refetch transcript。
3. `orchestration/session-rewind.ts`：`rewindWebSession({sessionId, channel, turnIndex, text, adapter}, deps?)`
   - running（runningExecutions.hasChannel）→ `{ok:false, reason:'running'}`（UI 同时置灰，双保险）
   - ledger conv 缺失 / turnIndex 越界 → `{ok:false, reason:'not-found'}`
   - 流程 = processEdit 的 channel 无关版：rollbackTo → 备份恢复（turn 0 或备份缺失 → 清
     backendSessionId 重开 backend 会话，**保留 track id 与 channel 绑定**，不走 Slack 的
     deleteSessionAsync）→ closePooledSession → truncateTurns + cleanupBackupsAfter →
     history.truncateFromTurn → appendEditMarker → publishSessionRewound →
     sendWebUserMessage(新文本 + 原附件)。web 无平台消息可删，靠 transcript refetch 收敛。
4. ui-service 合同：`sessions.rewind` mutation（input {sessionId, turnIndex, text}）。
   types.ts（MutateOp/Args/Return/Deps.rewindSession）+ input-schemas + mutate/sessions.ts
   `handleRewindSession`（reason 'running'→code 'session-running'）+ ui-service.ts 注册 +
   app-router（ERR_CODE_MAP 'session-running'→CONFLICT）+ entry/app.ts 注入。
   `TranscriptMessage` 增 `edited?: {originalText, originalTs}`（query/sessions.ts 透传）。
   同步 ui-contract parity/drift-guard。

## 前端（web/src，桌面与移动分树、共享 VM）

5. `transcript-vm.ts`：user ChatRow 携带 turnIndex + edited；`useSessionMessageLiveSync`
   订阅 `session.rewound` → 清 live buffer + invalidate transcript。
6. 桌面 `MessageStream.tsx` + `Composer.tsx`（sec-23）：
   - user 气泡 hover 左侧浮出 复制/编辑 pill（agent 消息仅复制，pill 在下方）；复制取 markdown 源文，
     按钮 1.5s ✓ 绿 + 「已复制」tooltip；running 时编辑置灰 + tooltip「运行中不可编辑 — 暂停后可用」。
   - 点编辑：气泡原位变编辑框（1.5px #4655D4 描边 + 3px 8% glow，底部「Esc 取消 · ⌘↩ 发送」+
     取消 / 发送并回退按钮）；下方琥珀行「发送后回退其后 N 条回复 · N 次工具调用作废」（N 由
     transcript 行计算）；其后所有行 opacity .35 + 右上「将被回退」琥珀角标。
   - 发送 → sessions.rewind → invalidate；编辑后气泡下挂「已编辑 · HH:MM」，hover 浮原文卡；
     重新生成首条回复顶部小字「由编辑重新生成」。
7. 移动 `MChatView.tsx`/`MChatScreen.tsx`/`kit.tsx`（sec-7）：
   - 长按（~500ms touch）气泡：全屏压暗(rgba(25,28,34,.38)+blur) + 气泡上浮 + 贴下缘菜单
     复制 / 编辑消息（46px 行）；agent 消息仅复制；running 编辑置灰。
   - 编辑 → composer 编辑模式（复用 rejectBar 横条模式，蓝色 accent）：横条「编辑消息 — 发送将回退
     后续回复」+ ×；原文装入 composer（accent 描边）；原气泡 ring + 「编辑中」badge；后续压暗 +
     「将被回退 · N 条回复 · N 次工具调用」；发送 → rewind mutation；×取消原样退出。
   - 编辑后气泡下挂「已编辑」小字，点开看原文；重新生成首条回复顶部「由编辑重新生成」。

## 测试（TDD）

- store：truncateFromTurn（中间/0/越界/attachments 返回）+ edit-marker 读取归并。
- orchestration：session-rewind 纯依赖注入 —— running 拒绝、not-found、happy path 调用序列、
  turn-0/备份缺失 reset 分支（保留 track id）。
- ui-service：mutate-sessions-rewind handler（not-found / running→session-running / accepted）。
- 合同：drift-guard / ui-contract parity 更新。
- 前端：transcript-vm 纯函数单测（turnIndex/edited 透传、rewound 清 tail 逻辑若为纯函数）；
  `pnpm --filter web build` 过 tsc。

## 验证

agent-server `npm test` 全绿；web build；本地起 server + `CORTEX_FRONTEND_DIR`/dev 走一轮
编辑→回退→重生成 手动冒烟。
