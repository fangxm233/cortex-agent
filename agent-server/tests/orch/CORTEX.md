Please update me when files in this folder change

tests/orch/ — Regression tests for the orch/ orchestration layer.
Covers API and event publication contracts for running-executions, channel-queue, superseded-edits, busy-tracker, and interactions/plan-approvals singletons (running-executions is in core/, tests are here, corresponding to Phase 1 Step 1).

DEBUG coverage here includes byte-identical assembled-prompt capture (`first-turn-interrupt-resume.test.ts`) and the content-free `session.debug.updated` bus contract (`session-events.test.ts`).

| filename | role | function |
|---|---|---|
| `running-executions.test.ts` | Test | RunningExecutions three-index consistency, kill chain, event publication (Phase 1 Step 1) |
| `channel-queue.test.ts` | Test | conduitQueues Map + enqueue() serialization and auto-cleanup (S6-B) |
| `superseded-edits.test.ts` | Test | supersededEdits mark/check/clear API (S6-B) |
| `plan-approvals.test.ts` | Test | PlanApprovals state transitions and approved event |
| `plan-response.test.ts` | Test | Web PI approve/reject delivery and retry safety |
| `hook-bridge-subscribers-web.test.ts` | Test | Web interaction snapshots including full plan and path |
| `busy-tracker.test.ts` | Test | BusyTracker +1/-1 publish+IPC, multi-publisher aggregate, re-entrant safety (S6-C) |
| `orchestrator.test.ts` | Test | Orchestrator two-branch decision tree: threadAddMatch / isActiveThread / threadStartMatch -> threadExecutor; no match -> agentRunner (S8-A) |
| `agent-runner.test.ts` | Test | Context snapshot persist-before-publish, queue marker cleanup, and plain-turn routing |
| `mid-turn-inject.test.ts` | Test | Pending commits, markers, and continuation context |
| `mid-turn-inject-persistence.test.ts` | Test | Durable ordering and early-ack marker races |
| `pending-injection-recovery.test.ts` | Test | Ledger/history/store crash-boundary idempotency, concurrent-order serialization, and startup drain |
| `agent-runner-wake-guard.test.ts` | Test | 2026-07-05 self-consumption regression: synthetic wakeSession notices (SYNTHETIC_CALLBACK_SENDER) bypass the manager-qa human-answer backstop in route(); real human replies still consumed; buildSyntheticWakeMessage shape sync |
| `lifecycle-rate-limit.test.ts` | Test | handleAgentError thrown-rate-limit pause branch: throttled + rate-limit error + userMessage → recordResume(direct) + seal, no error post; normal error path otherwise (not throttled / no userMessage / non-rate-limit) |
| `bg-continuation.test.ts` | Test | Continuation text/tool/context and terminal dispatch |
| `web-bg-hold.test.ts` | Test | Web hold status, context forwarding, guards, and seals |
| `cancel-bg-hold.test.ts` | Test | Stop during a web background hold (regression: the click did nothing because the execution was already torn down) — `cancelBgHolds` no-hold no-op, kill-then-abort ordering, one kill per channel with every hold aborted, seal still fires when the kill throws, end-to-end against the real `bgHeldSessions` (found by channel, sealed, second Stop finds nothing) |
| `bg-wait-guard.test.ts` | Test | BgWaitGuard busy bracket (+1/-1 exactly once), grace watchdog (undelivered-only), max-wait cap (running), rearm switching, env-tunable durations |
| `lifecycle-bg-hold.test.ts` | Test | Lifecycle hold context, grace, interruption, and cap |
| `turn-notify.test.ts` | Test | isTurnNotifyEnabled / getTurnNotifyThresholdS gating + maybeNotifyTurnComplete dispatch (threshold/scope/disable gates, success metrics vs failure, threadId forwarding, never-throws) |
| `thread-executor.test.ts` | Test | Thread queue marker cleanup and routing |
| `thread-detached.test.ts` | Test | runThreadDetached holds the busy gate for the whole fire-and-forget thread AND across the onSettled callback (sync +1, -1 in finally on success/reject, balanced, deferred until callback settles — test e) — regression for restart killing MCP `thread_start` background threads / dropping the completion callback |
| `seal-thread-status.test.ts` | Test | sealThreadStatus unifies the interactive `!thread` + background/resume terminal seal: text == buildThreadSummary; interactive style attaches SEALED action blocks (Cancel removed), background attaches none; delivery failure propagates (no internal swallow) |
| `ask-user-question-pi.test.ts` | Test | PI ask-user-question branch: tryResolveHook extension_ui_response routing, multi-question join, incomplete does not resolve early (S3) |
| `session-lifecycle-characterization.test.ts` | Test | Stage C characterization: resolveSessionName (existing→cached name, unknown→register with label/profileName/backend/projectId, null→generate only) + handleNewCmd (clears all backends + ledger + posts "new conversation") |
| `session-events.test.ts` | Test | Session context/notice/message/delta/debug events plus stable pending/delivered identity contract |
