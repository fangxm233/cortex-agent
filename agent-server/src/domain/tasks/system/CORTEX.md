Please update me when files in this folder change

Task state transitions and command-line entry points.

| filename | role | function |
|---|---|---|
| cortex-run.ts | entry | Forwards managed run requests to clients |
| task-cli.ts | entry | Handles task command-line actions |
| task-completion.ts | lifecycle | Completes and reopens task records |
| task-id-utils.ts | utility | Provides task id helpers |
| task-lifecycle-edit.ts | mutation | Edits task queue lifecycle fields |
| task-lock.ts | lock | Guards task state |
| task-mutations.ts | mutation | Adds, edits, and decomposes tasks |
| task-process.ts | process | Controls task processes |
| task-state.ts | state | Maintains task state |
