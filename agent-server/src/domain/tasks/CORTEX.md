Please update me when files in this folder change

Task system domain: reads and writes TASKS.yaml, dispatches tasks to agents, archives finished work.
Also tracks dispatched runs, records acceptance verdicts, and recovers claims orphaned by a crash.

| filename | role | function |
|---|---|---|
| acceptance-ledger.ts | core | records child result deliveries and verdicts |
| archiver.ts | core | Archives completed tasks under mutation lock |
| claim-recovery.ts | core | Generation-fences orphaned dispatch claim recovery |
| dispatcher.ts | core | Selects and claims tasks with fresh generations |
| dispatch-utils.ts | util | Reloads devices and provides task dispatch helpers |
| lint.ts | util | checks task files for cycles and errors |
| mutator.ts | core | Serializes generation-aware mutations and events; preserves the daemon wrapper verbatim, plus the additive §19.12.7 trial factory `createTrialCapabilityAwareTaskMutator` binding the shipped lifecycle functions into the benchmark P3 |
| parser.ts | adapter | re-exports the task file parser |
| pending-tracker.ts | core | Tracks dispatched tasks, status and generation |
| store.ts | adapter | re-exports the task store and git lock |
| recommendation/ | subdir | extracts implied tasks from project notes |
| system/ | subdir | task CLI, state machine and file locking |
