Please update me when files in this folder change

Task system domain: reads and writes TASKS.yaml, dispatches tasks to agents, archives finished work.
Also tracks dispatched runs, records acceptance verdicts, and recovers claims orphaned by a crash.

| filename | role | function |
|---|---|---|
| acceptance-ledger.ts | core | Records child delivery verdicts |
| archiver.ts | core | Archives completed tasks |
| claim-recovery.ts | core | Recovers orphaned task claims |
| dispatcher.ts | core | Selects tasks for agents |
| dispatch-utils.ts | util | Provides task dispatch helpers |
| lint.ts | util | Checks task graph validity |
| mutator.ts | core | Applies task mutations |
| parser.ts | adapter | Exports the task parser |
| pending-tracker.ts | core | Tracks dispatched task state |
| store.ts | adapter | Exports task persistence |
| recommendation/ | subdir | Extracts task recommendations |
| system/ | subdir | Provides task lifecycle operations |
