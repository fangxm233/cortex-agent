Please update me when files in this folder change

Regression tests for the orchestration layer: message routing, per-channel
queueing, mid-turn injection, background holds and execution lifecycle.

| filename | role | function |
|---|---|---|
| agent-runner-wake-guard.test.ts | test | Covers synthetic wake notice routing guard |
| agent-runner.test.ts | test | Covers plain message routing and queue markers |
| ask-user-question-pi.test.ts | test | Covers PI ask-user-question resolution |
| bg-continuation.test.ts | test | Covers background continuation sink dispatch |
| bg-wait-guard.test.ts | test | Covers background wait bracket, grace and cap |
| busy-tracker.test.ts | test | Covers busy counter publish and aggregation |
| cancel-bg-hold.test.ts | test | Covers stop during a background hold |
| channel-queue.test.ts | test | Covers per-channel queue serialization |
| edit-handler.test.ts | test | Covers message edit rollback and backend pick |
| first-turn-interrupt-resume.test.ts | test | Covers prompt capture and first-turn interrupt |
| hook-bridge-subscribers-web.test.ts | test | Covers hook to Web interaction delivery |
| interaction-records.test.ts | test | Covers interaction create and resolve lifecycle |
| lifecycle-bg-hold.test.ts | test | Covers lifecycle hold, grace and wait cap |
| lifecycle-rate-limit.test.ts | test | Covers provider-attributed error recovery |
| mid-turn-inject-persistence.test.ts | test | Covers durable ordering of pending injection |
| mid-turn-inject.test.ts | test | Covers the mid-turn injection lifecycle |
| orchestrator.test.ts | test | Covers thread versus agent routing choice |
| pending-injection-recovery.test.ts | test | Covers injection idempotency and startup drain |
| plan-approvals.test.ts | test | Covers plan approval state transitions |
| plan-response.test.ts | test | Covers Web plan approve and reject delivery |
| resume-dispatcher.test.ts | test | Covers provider-ready dispatch and guards |
| running-executions.test.ts | test | Covers execution registry indices and events |
| seal-thread-status.test.ts | test | Covers terminal thread status sealing |
| session-events.test.ts | test | Covers session event publication contract |
| session-lifecycle-characterization.test.ts | test | Covers session naming and new session command |
| session-send.test.ts | test | Covers Web user message build and send |
| superseded-edits.test.ts | test | Covers superseded edit mark, check and clear |
| teardown-execution.test.ts | test | Covers execution teardown and balanced events |
| thread-detached.test.ts | test | Covers detached thread busy gate bracket |
| thread-executor.test.ts | test | Covers thread queue markers and routing |
| turn-notify.test.ts | test | Covers turn completion notification gating |
| web-bg-hold.test.ts | test | Covers Web background hold status and seal |
