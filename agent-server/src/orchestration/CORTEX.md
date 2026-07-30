Please update me when files in this folder change

Orchestration layer for agent-server: routes incoming turns to agents and threads and manages their lifecycle.
Coordinates queues, session state, background continuations, and cross-thread callbacks.

| filename | role | function |
|---|---|---|
| agent-file-send.ts | chat | delivers an agent-produced file into a session |
| agent-runner.ts | core | Routes provider-attributed plain user turns |
| bg-continuation.ts | helper | forwards background continuation output |
| bg-wait-guard.ts | guard | bounds the background task waiting window |
| busy-tracker.ts | tracker | counts active LLM runs and signals busy state |
| conduit-queue.ts | queue | serializes work per conduit |
| conversation-runner.ts | runner | runs one plain user turn end to end |
| delta-coalescer.ts | stream | batches assistant text deltas for web sessions |
| dispatch-reconciler.ts | timer | cleans up stale dispatch executions |
| durable-helpers.ts | util | builds durable post and update hooks |
| lifecycle.ts | core | Finalizes provider-attributed turn outcomes |
| manager-qa.ts | channel | relays subtask questions to managers and humans |
| mid-turn-inject.ts | core | injects turns with a live wait cap |
| orchestrator.ts | router | picks the thread or default routing branch |
| pending-injection-recovery.ts | recovery | commits and recovers pending injected turns |
| resume-dispatcher.ts | runner | Resumes and requeues provider-paused work |
| session-compact.ts | control | compacts an idle session's context |
| session-events.ts | events | publishes session state events on the bus |
| session-rewind.ts | chat | rewinds a web session to an edited turn |
| session-send.ts | chat | sends a user turn into a web session |
| status-helpers.ts | helper | builds and seals status messages |
| superseded-edits.ts | tracker | marks channels superseded by a message edit |
| thread-callback.ts | callback | Resumes parents with live rotation and sweep settings |
| thread-executor.ts | core | routes thread turns and runs threads |
| turn-notify.ts | notify | notifies users when a long turn finishes |
| web-bg-hold.ts | helper | holds web turns until background work seals |
| interactions/ | subdir | approvals, prompts, and user interaction handling |
| routing/ | subdir | message, edit, file, and webhook routing |
