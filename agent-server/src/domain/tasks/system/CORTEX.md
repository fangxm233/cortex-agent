Please update me when files in this folder change

Task file write path plus the command line entry points of the task system.
Owns TASKS.yaml editing primitives, status transitions, locking, and remote run launching.

| filename | role | function |
|---|---|---|
| cortex-run.ts | entry | Launches remote runs with task generation metadata |
| task-cli.ts | entry | Routes task reads and ownership-aware writes |
| task-completion.ts | core | Fences completion and verifies persisted evidence |
| task-file-input.ts | adapter | parses structured add and spawn task input |
| task-id-utils.ts | util | Generates and assigns task IDs under mutation locks |
| task-lifecycle-edit.ts | core | Locks and atomically edits TASKS.yaml records |
| task-lock.ts | core | Atomically acquires and releases logical project task locks |
| task-mutations.ts | core | Constructs generation-initialized task records |
| task-process.ts | core | Stops tracked task processes with generation-fenced unclaim |
| task-state.ts | core | Applies claims and ownership-revoking transitions |
