Please update me when files in this folder change

Persistence layer: file-backed repositories for sessions, threads, tasks, schedules, costs, and history.
Also runs startup file migrations and keeps deployed hooks and plugins in sync with defaults.

| filename | role | function |
|---|---|---|
| in-memory-repository.ts | testing | In-memory repository double for tests |
| outbound-queue.ts | queue | Durable queue for outbound messages |
| thread-repo.ts | store | Thread state persistence |
| session-repo.ts | store | Session record persistence |
| session-registry-repo.ts | store | Session identity and context snapshots |
| conversation-ledger-repo.ts | store | Turn to message mapping per conduit |
| conversation-history-repo.ts | store | Append-only conversation transcript per session |
| pending-injection-repo.ts | store | Injected messages not yet consumed |
| execution-repo.ts | store | Execution record persistence |
| project-dir-repo.ts | store | Project to code directory mapping |
| schedule-repo.ts | store | Scheduled tasks and rate limit windows |
| cost-repo.ts | store | Cost records and budget persistence |
| profile-repo.ts | store | Agent profiles with hot reload |
| task-repo.ts | store | TASKS.yaml read, write, lock, and git sync |
| version-migrations.ts | startup | Migrates config and safely handles hook collisions |
| hook-registry.ts | config | Validates event capabilities, loads and classifies mounted hook declarations |
| hook-writer.ts | config | Creates, edits, removes and toggles hook declarations |
| hook-sync.ts | startup | Syncs and diagnoses managed hook assets |
| plugin-sync.ts | startup | Refreshes deployed plugins from defaults |
