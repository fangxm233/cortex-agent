Please update me when files in this folder change

Domain layer (L3) directory — established according to the six-layer structure of plan/agent-server-decouple.md §2.
Currently only has threads/ subdirectory; subsequent S8-S11 will gradually add agents / sessions / tasks / executions, etc.

| subdirectory | status | function |
|---|---|---|
| `system/` | [DR-0013] DONE | Server auto-update: UpdatePrompt interface, update state persistence. `system-notice.ts` = the encapsulated admin/system broadcast seam: `emitSystemNotice(adapter, {text,level?,title?})` posts to the platform admin channel AND publishes a `system.notice` EventBus event (Web toast source); `publishSystemNotice` is the bus-only half. Routed from startup/restart (entry/startup-notify), profile/config/machine + client hot-reload (entry/app), disk-monitor, rate-limit-throttle, codex-usage-monitor |
| `threads/` | [S7] DONE | Thread lifecycle, prompt building, config loading, artifact I/O |
| `agents/` | [S11] DONE | Agent execution facade, bridge exports, gateway routing, and fallback policy. The normalized callback seam dispatches backend-neutral context usage, typed notices, tool ids/results, and progress. `profile-switch.ts` owns the shared same-backend switch rule |
| `tasks/` | [S2] DONE | Task system: parser (read path, core in core/task-parser.ts), mutator (write path, 17 mutations), dispatcher, archiver, recommendation |
| `executions/` | [S14] DONE | Execution registry re-export layer (registry.ts) — wraps ExecutionRepo terminal transitions with lock-release side effect (+ `releaseExecutionLocks(id)` for the thread suspend/`thread_wait` path, DR-0014 lock hygiene: release before yielding so a `decompose --auto-lock` lock isn't leaked across the child-wait). `log-tailer.ts` (342f/B2): ref-counted live tail of a running cortex-run/dispatch output.log → bounded `execution.log` EventBus events (fs-local + bash-remote, no client-protocol change). `resolveExecutionLogLocation(executionId)` (6c5b/B2-C) is registry-only: reads the persisted `dispatch.runName` (set at cortex-run launch via the daemon `/webhook/remote-command` seam) to locate `<DATA_DIR>/tmp/cortex-run/<runName>/output.log`, local-vs-remote from `dispatch.machine` |
| `scheduling/` | [S9] DONE | Scheduled task scheduling: job-registry + 4 job runners (scheduled-task / task-dispatch / memory-index-regen / task-archive) + jobs/target-dispatch.ts (4-way decision tree) |
| `projects/` | [M1] DONE | Project domain: types + ProjectStore (list/get/exists/getDefault/resolveFromMessage, auto-scaffold general/, fs.watch cache invalidation) |
| `ui-service/` | [M3] DONE | Transport-agnostic facade: query/mutate/subscribe over all domain stores and managers |
| `sessions/` | [C1] DONE | Session lifecycle primitives: registerNamedSession, attachExistingSession, resetChannelSession — additive extraction from agent-runner + commands/session |
| `tui-session/` | [B3] DONE | TUI session lifecycle: resolveHandshake, switchSession, transcript assembly — additive extraction from tui-gateway.ts |
