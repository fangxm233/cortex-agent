Please update me when files in this folder change

Task system domain — TASKS.md reading (parser), writing (mutator), dispatch (dispatcher), archiving (archiver).
mutator.ts takes over the 17 mutation forwarding responsibilities from the original store/task-repo.ts, serializing write operations via taskStore.runExclusive.

| filename | role | function |
|---|---|---|
| `parser.ts` | read path | TASKS.md parsing |
| `mutator.ts` | write path | 17 mutations via `taskStore.runExclusive`: claim / complete / block / add / batchEdit, etc. |
| `acceptance-ledger.ts` | ledger | DR-0017 W1 task-keyed acceptance ledger (`context/projects/{project}/manager/{taskId}/ledger.json`): readLedger / recordDelivered / recordVerdict / pendingDeliveries — cross-incarnation delivery dedupe ('accepted' never re-delivers; pending/rejected re-deliver at-least-once per manager incarnation); verdict write path = `cortex-task verdict` (system/task-cli.ts handleVerdict); writes are sync-atomic via core atomicWriteSync |
| `claim-recovery.ts` | recovery | recoverOrphanedClaims — startup reconciliation (called from entry/app.ts after markRunningAsFailedOnStartup): unclaims `task-dispatcher` claims whose owner died with the server (claimed → not actionable → never re-dispatched, stranding the task and any waiting manager). Respects surviving owners: waiting/rate_limited threads owning the task, remote cortex-run tracked in pending-tasks.json, pending status, and manual (non-dispatcher) claims |
| `task-lock.ts` | lock | TASKS.yaml file-level lock primitives (acquire / release / read / assert) |
| `lint.ts` | validation | TASKS.md format check |
| `archiver.ts` | archive | Completed task archiving |
| `dispatcher.ts` | dispatch | Automatic task dispatch |
| `dispatch-utils.ts` | utility | Dispatch helper functions |
| `pending-tracker.ts` | tracker | Pending task tracking |
| `store.ts` | adapter | Store access adaptation layer |
| `recommendation/` | subdirectory | Task recommendation |
| `system/` | subdirectory | Task CLI and state machine (CORTEX.md exists) |
