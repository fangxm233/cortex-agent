Please update me when files in this folder change

Task file write path plus the command line entry points of the task system.
Owns TASKS.yaml editing primitives, status transitions, locking, and remote run launching.

| filename | role | function |
|---|---|---|
| cortex-run.ts | entry | Launches remote runs with task generation metadata |
| task-cli.ts | entry | Routes task reads and ownership-aware writes |
| task-completion.ts | core | Fences completion and verifies persisted evidence |
| task-file-input.ts | adapter | parses structured add and spawn task input |
| task-id-utils.ts | util | Assigns task IDs under mutation locks |
| task-lifecycle-edit.ts | core | Locks and atomically edits TASKS.yaml records |
| task-lock.ts | core | Acquires and releases logical project locks; in-trial operations run on the trial's own lock table via withTrialTaskLockScope (P4) |
| task-mutations.ts | core | Creates tasks and fences owned decomposition |
| task-process.ts | core | Stops task processes with owned unclaim |
| task-state.ts | core | Applies owned pending and task state transitions |
