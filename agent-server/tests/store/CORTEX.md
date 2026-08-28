Please update me when files in this folder change

Regression tests for the store layer: JSON repositories, WAL queues,
and the persisted registries for sessions, tasks, schedules, providers and costs.

| filename | role | function |
|---|---|---|
| conversation-history-repo.test.ts | test | Covers prompts, compact/detail projections, durable incremental cache behavior, rewind, and idempotency |
| conversation-ledger-repo.test.ts | test | Covers bulk clearing by tracked session ids |
| cost-repo.test.ts | test | Covers cost entry writes, pruning and budget |
| execution-repo.test.ts | test | Covers lifecycle, concurrency, recovery and archival |
| hook-registry.test.ts | test | Covers schema, sources, loading and filtering |
| hook-sync.test.ts | test | Covers managed asset sync and I/O diagnostics |
| hook-writer.test.ts | test | Covers create, edit, remove and toggle guards |
| json-repository.test.ts | test | Covers concurrent mutate, atomic write, cache |
| outbound-queue.test.ts | test | Covers outbound WAL enqueue, drain and compact |
| pending-injection-repo.test.ts | test | Covers pending message persistence and removal |
| plugin-sync.test.ts | test | Covers managed plugin deploy and refresh rules |
| profile-repo.test.ts | test | Covers profile reads, writes and file watching |
| profile-watcher-fallback.test.ts | test | Covers profile polling after watcher failure |
| project-dir-repo.test.ts | test | Covers per-machine project directory mapping |
| project-notes-repo.test.ts | test | Covers private notes CRUD, stable timestamps, and concurrency |
| prompt-migrations.test.ts | test | Covers coder, reviewer and manager prompt migrations |
| provider-state-repo.test.ts | test | Covers provider state defaults, writes and migration |
| schedule-repo.test.ts | test | Covers scheduled tasks and channel migration |
| retention-candidate-repo.test.ts | test | Covers orphan candidate persistence and clearing |
| session-hook-migration.test.ts | test | Covers legacy migration and destination collisions |
| session-registry-repo.test.ts | test | Covers session JSONL journal replay, delete-intent guards, malformed-line fail-closed behavior, and append rollback |
| session-store.test.ts | test | Covers session migration, conflict-safe backups, replacement cleanup, and prune references |
| task-repo.test.ts | test | Covers task store locking, flush and round-trip |
| thread-repo.test.ts | test | Covers thread cleanup archival to JSONL |
| version-migrations.test.ts | test | Covers config, text migrations and version clocks |
