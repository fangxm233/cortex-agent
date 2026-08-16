Please update me when files in this folder change

Task domain tests: task record mutation, project locking, guarding of the task file, and the
acceptance ledger's verdicts and delivery semantics.

| filename | role | function |
|---|---|---|
| acceptance-ledger.test.ts | test | proves verdict, delivery and correlated rework history |
| mutator.test.ts | test | Task generations, mutations, locks and events |
| production-topology-ledger.test.ts | test | proves durable lifecycle facts and strict Q&A projection |
| task-lock.test.ts | test | project lock lifecycle and ownership |
| tasks-yaml-guard.test.ts | test | edit permission decisions for the task file |
