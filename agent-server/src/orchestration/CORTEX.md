Please update me when files in this folder change

Direct-turn and thread workflows across domain and platform layers.

| filename | role | function |
|---|---|---|
| agent-file-send.ts | delivery | Stores and publishes agent-sent files |
| agent-runner.ts | runner | Runs agent workflows |
| bg-continuation.ts | background | Forwards background continuation output |
| bg-wait-guard.ts | guard | Bounds background continuation waiting |
| busy-tracker.ts | tracker | Tracks busy state |
| conduit-queue.ts | queue | Queues conduit work |
| conversation-runner.ts | runner | Runs conversation workflows |
| delta-coalescer.ts | streaming | Batches delta updates |
| dispatch-reconciler.ts | recovery | Reconciles dispatch state |
| durable-helpers.ts | helper | Provides durable helpers |
| lifecycle.ts | lifecycle | Coordinates orchestration lifecycle |
| manager-qa.ts | routing | Routes questions between subtasks and managers |
| mid-turn-inject.ts | injection | Injects mid turn messages |
| orchestrator.ts | workflow | Coordinates orchestration workflows |
| pending-injection-recovery.ts | recovery | Recovers pending injection state |
| resume-dispatcher.ts | dispatch | Dispatches resume work |
| session-compact.ts | control | Compacts idle backend sessions |
| session-events.ts | events | Publishes session events |
| session-rewind.ts | control | Rewinds and resends edited session turns |
| session-send.ts | delivery | Sends direct web session messages |
| status-helpers.ts | helper | Provides status helpers |
| superseded-edits.ts | tracker | Tracks superseded message edits |
| thread-callback.ts | callback | Delivers thread callbacks |
| thread-executor.ts | runner | Executes thread workflows |
| turn-notify.ts | notice | Sends turn notices |
| web-bg-hold.ts | background | Holds web sessions during background work |
| interactions/ | directory | Contains user interaction workflows |
| routing/ | directory | Contains inbound routing modules |
