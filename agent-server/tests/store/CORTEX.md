Please update me when files in this folder change

Regression tests for the store layer: JSON repositories, WAL queues,
and the persisted registries for sessions, tasks, schedules and costs.

| filename | role | function |
|---|---|---|
| conversation-history-repo.test.ts | test | Covers history append, rewind and idempotency |
| cost-repo.test.ts | test | Covers cost entry writes, pruning and budget |
| execution-repo.test.ts | test | Covers execution records, index and staleness |
| hook-registry.test.ts | test | Covers capabilities, sources, defaults and TTL |
| hook-sync.test.ts | test | Covers managed asset sync and I/O diagnostics |
| hook-writer.test.ts | test | Covers create, edit, remove and toggle guards |
| json-repository.test.ts | test | Covers concurrent mutate, atomic write, cache |
| outbound-queue.test.ts | test | Covers outbound WAL enqueue, drain and compact |
| pending-injection-repo.test.ts | test | Covers pending message persistence and removal |
| plugin-sync.test.ts | test | Covers managed plugin deploy and refresh rules |
| profile-repo.test.ts | test | Covers profile reads, writes and file watching |
| project-dir-repo.test.ts | test | Covers per-machine project directory mapping |
| schedule-repo.test.ts | test | Covers schedules, throttles and resume queues |
| session-hook-migration.test.ts | test | Covers legacy migration and destination collisions |
| session-registry-repo.test.ts | test | Covers session lookup, prune and migration |
| session-store.test.ts | test | Covers session migration and prune references |
| task-repo.test.ts | test | Covers task store locking, flush and round-trip |
| version-migrations.test.ts | test | Covers config and prompt migration idempotency |
