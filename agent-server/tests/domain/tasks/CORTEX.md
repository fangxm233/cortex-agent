Please update me when files in this folder change

Task domain tests: task record mutation, project locking, and guarding of the task file.

| filename | role | function |
|---|---|---|
| mutator.test.ts | test | Task mutations, state transitions, lock contention and events |
| task-lock.test.ts | test | project lock lifecycle and ownership |
| tasks-yaml-guard.test.ts | test | edit permission decisions for the task file |
