Please update me when files in this folder change

Task system domain: reads and writes TASKS.yaml, dispatches tasks to agents, archives finished work.
Also tracks dispatched runs, records acceptance verdicts, and recovers claims orphaned by a crash.

| filename | role | function |
|---|---|---|
| acceptance-ledger.ts | core | records child result deliveries and verdicts |
| archiver.ts | core | archives completed tasks out of TASKS.yaml |
| claim-recovery.ts | core | releases task claims orphaned by a crash |
| dispatcher.ts | core | selects and claims the next task to run |
| dispatch-utils.ts | util | device registry and task id generation |
| lint.ts | util | checks task files for cycles and errors |
| mutator.ts | core | Serializes task mutations and terminal hooks |
| parser.ts | adapter | re-exports the task file parser |
| pending-tracker.ts | core | tracks dispatched tasks and their status |
| store.ts | adapter | re-exports the task store and git lock |
| recommendation/ | subdir | extracts implied tasks from project notes |
| system/ | subdir | task CLI, state machine and file locking |
