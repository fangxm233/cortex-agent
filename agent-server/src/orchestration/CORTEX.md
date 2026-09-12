Please update me when files in this folder change

Orchestration layer for agent-server: routes incoming turns to agents and threads and manages their lifecycle.
Coordinates queues, session state, background continuations, and cross-thread callbacks.

| filename | role | function |
|---|---|---|
| agent-file-send.ts | chat | stores and delivers agent files with safe display names |
| agent-view-send.ts | chat | delivers agent-rendered HTML views with size and height limits |
| agent-decision-send.ts | chat | records agent-announced decisions on Web chat transcripts |
| outputs-store.ts | core | shared workspace outputs placement and filename discipline |
| agent-runner.ts | core | Routes turns with transcript tool metadata |
| bg-continuation.ts | helper | forwards background continuation output |
| bg-wait-guard.ts | guard | bounds the background task waiting window |
| busy-tracker.ts | tracker | counts active LLM runs and signals busy state |
| conduit-queue.ts | queue | serializes work per conduit |
| conversation-runner.ts | runner | builds the plain-turn RunRequest and runs it through startRun |
| delta-coalescer.ts | stream | batches assistant text deltas for web sessions |
| dispatch-reconciler.ts | timer | optionally cleans up stale dispatch executions |
| durable-helpers.ts | util | builds durable post and update hooks |
| lifecycle.ts | core | finalizes turns, attributes continuation costs, and resumes edit-retry/ask-user turns through startRun |
| manager-qa.ts | channel | durably relays subtask manager questions and answers |
| mid-turn-inject.ts | core | routes a busy-channel message to the live AgentRun.steer; the ledger it feeds lives in transcript-sink |
| orchestrator.ts | router | picks the thread or default routing branch |
| pending-injection-recovery.ts | recovery | commits and recovers pending injected turns |
| resume-dispatcher.ts | runner | Resumes paused work under runtime settings |
| session-compact.ts | control | compacts an idle session's context |
| session-events.ts | events | Publishes session and remote tool metadata |
| subagent-rows.ts | util | maps native-subagent attribution to history and payload fields |
| subagent-attribution.ts | core | streams a delegated child into its parent turn's live transcript |
| subagent-delivery.ts | core | holds a session for a backgrounded run (Stop handle only — a new foreground turn supersedes the hold without killing the child) and delivers its answer as a turn |
| pi-background-subagent.ts | bridge | implements the adapter's background-subagent port for PI's in-process `agent` tool |
| subagent-webhook.ts | entry | serves start / wait / stop / list for the `agent` MCP tool |
| session-rewind.ts | chat | restores and pins snapshots before Web resend |
| session-retention-controller.ts | timer | serializes startup and periodic retention sweeps |
| session-send.ts | chat | forwards admitted Web user turns |
| status-helpers.ts | helper | builds settings-aware status messages; scheduled auto-compound follow-ups run through startRun |
| superseded-edits.ts | tracker | marks channels superseded by a message edit |
| thread-callback.ts | callback | Fences child results and resumes current parents |
| thread-executor.ts | core | routes threads and buffers downloaded user files |
| transcript-sink.ts | core | single history+publish observer for the RunEvent stream, plus the mid-turn injection ledger that persists/commits injected messages from injection events |
| turn-mutation-lock.ts | guard | grants per-channel mutation leases |
| turn-notify.ts | notify | applies settings and notifies completed long turns |
| web-bg-hold.ts | helper | holds Web turns, forwards continuation limits, owns the continuation's rate-limit notice |
| interactions/ | subdir | approvals, prompts, and user interaction handling |
| routing/ | subdir | message, edit, file, and webhook routing |
