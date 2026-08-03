Please update me when files in this folder change

Orchestration layer for agent-server: routes incoming turns to agents and threads and manages their lifecycle.
Coordinates queues, session state, background continuations, and cross-thread callbacks.

| filename | role | function |
|---|---|---|
| agent-file-send.ts | chat | stores and delivers agent files with safe display names |
| agent-runner.ts | core | admits and routes visible user turns |
| bg-continuation.ts | helper | forwards background continuation output |
| bg-wait-guard.ts | guard | bounds the background task waiting window |
| busy-tracker.ts | tracker | counts active LLM runs and signals busy state |
| conduit-queue.ts | queue | serializes work per conduit |
| conversation-runner.ts | runner | runs plain turns and captures backend prompts |
| delta-coalescer.ts | stream | batches assistant text deltas for web sessions |
| dispatch-reconciler.ts | timer | cleans up stale dispatch executions |
| durable-helpers.ts | util | builds durable post and update hooks |
| lifecycle.ts | core | adopts admission leases and snapshots turns |
| manager-qa.ts | channel | relays subtask questions to managers and humans |
| mid-turn-inject.ts | core | injects turns with resolved files and DEBUG prompts |
| orchestrator.ts | router | picks the thread or default routing branch |
| pending-injection-recovery.ts | recovery | commits and recovers pending injected turns |
| resume-dispatcher.ts | runner | Resumes paused work under runtime settings |
| session-compact.ts | control | compacts an idle session's context |
| session-events.ts | events | publishes session state events on the bus |
| session-rewind.ts | chat | restores and pins snapshots before Web resend |
| session-send.ts | chat | forwards admitted Web user turns |
| status-helpers.ts | helper | builds settings-aware status messages |
| superseded-edits.ts | tracker | marks channels superseded by a message edit |
| thread-callback.ts | callback | Fences child results and resumes current parents |
| thread-executor.ts | core | routes thread turns and runs threads |
| turn-mutation-lock.ts | guard | grants per-channel mutation leases |
| turn-notify.ts | notify | applies settings and notifies completed long turns |
| web-bg-hold.ts | helper | holds web turns until background work seals |
| interactions/ | subdir | approvals, prompts, and user interaction handling |
| routing/ | subdir | message, edit, file, and webhook routing |
