Please update me when files in this folder change

Task domain tests: task record mutation, project locking, guarding of the task file, and the
acceptance ledger's verdicts and delivery semantics.

| filename | role | function |
|---|---|---|
| acceptance-ledger.test.ts | test | proves the four verdicts, preserved supersession history and the unchanged delivery semantics |
| mutator.test.ts | test | Task generations, mutations, locks and events |
| task-lock.test.ts | test | project lock lifecycle and ownership |
| tasks-yaml-guard.test.ts | test | edit permission decisions for the task file |
