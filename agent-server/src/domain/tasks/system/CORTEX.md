Please update me when files in this folder change

Task file write path plus the command line entry points of the task system.
Owns TASKS.yaml editing primitives, status transitions, locking, and remote run launching.

| filename | role | function |
|---|---|---|
| cortex-run.ts | entry | launches and cancels remote task runs |
| task-cli.ts | entry | routes task reads and unique-path structured writes |
| task-completion.ts | core | Verifies evidence and timestamps task completion |
| task-file-input.ts | adapter | parses structured add and spawn task input |
| task-id-utils.ts | util | generates and validates task ids |
| task-lifecycle-edit.ts | core | reads, writes and edits task entries |
| task-lock.ts | core | acquires and releases project task locks |
| task-mutations.ts | core | adds, batch edits and decomposes tasks |
| task-process.ts | core | stops running tasks |
| task-state.ts | core | applies task status transitions |
