Please update me when files in this folder change

Task system domain: reads and writes TASKS.yaml, dispatches tasks to agents, archives finished work.
Also tracks dispatched runs, records acceptance verdicts, and recovers claims orphaned by a crash.

| filename | role | function |
|---|---|---|
| acceptance-ledger.ts | core | records child result deliveries and verdicts |
| archiver.ts | core | Archives completed tasks under the task-file mutation lock |
| claim-recovery.ts | core | Generation-fences recovery of task claims orphaned by a crash |
| dispatcher.ts | core | Selects and claims tasks with fresh generations |
| dispatch-utils.ts | util | device registry and task id generation |
| lint.ts | util | checks task files for cycles and errors |
| mutator.ts | core | Serializes generation-aware mutations and events |
| parser.ts | adapter | re-exports the task file parser |
| pending-tracker.ts | core | Durably tracks dispatched tasks, status, and generation |
| store.ts | adapter | re-exports the task store and git lock |
| recommendation/ | subdir | extracts implied tasks from project notes |
| system/ | subdir | task CLI, state machine and file locking |
