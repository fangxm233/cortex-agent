Please update me when files in this folder change

File-backed repositories for sessions, threads, tasks, costs, and history.
Also manages schedules, provider state, migrations, hooks, and plugin sync.

| filename | role | function |
|---|---|---|
| in-memory-repository.ts | testing | In-memory repository double for tests |
| outbound-queue.ts | queue | Durable queue for outbound messages |
| thread-repo.ts | store | Thread state persistence |
| session-repo.ts | store | Session record persistence |
| session-registry-journal.ts | store | Session registry JSONL journal I/O and compaction |
| session-registry-repo.ts | store | Session identity, delete intents and admission |
| conversation-ledger-repo.ts | store | Turn to message mapping per conduit |
| conversation-history-reader.ts | parser | Streams session JSONL into collapsed SessionHistory snapshots or reusable incremental accumulators |
| conversation-display-projection.ts | projection | Projects compact titles, summaries and details |
| conversation-history-repo.ts | store | Stores transcripts plus durable incrementally updated compact/detail read models and lazy DEBUG details |
| retention-candidate-repo.ts | store | Persists two-sweep orphan cleanup candidates |
| pending-injection-repo.ts | store | Injected messages not yet consumed |
| execution-repo.ts | store | Execution record persistence |
| project-dir-repo.ts | store | Project to code directory mapping |
| project-notes-repo.ts | store | Persists private project notes with stable metadata in Markdown |
| schedule-repo.ts | store | Scheduled-task persistence |
| commission-repo.ts | store | Commission (long-task) registry persistence |
| provider-state-repo.ts | store | Persists provider usage, throttle and resume state |
| cost-repo.ts | store | Cost records and budget persistence |
| profile-repo.ts | store | Reloads profiles and tracks config revisions |
| task-repo.ts | store | TASKS.yaml read, write, lock, and git sync |
| prompt-migration-replacements.ts | config | Defines coder, reviewer, manager and STATUS-register prompt replacements |
| version-migrations.ts | startup | Migrates config, stock prompts, and hook collisions |
| hook-registry.ts | config | Validates event capabilities, loads and classifies mounted hook declarations |
| hook-writer.ts | config | Creates, edits, removes and toggles hook declarations |
| hook-sync.ts | startup | Syncs and diagnoses managed hook assets |
| plugin-sync.ts | startup | Refreshes deployed plugins from defaults and prunes retired paths |
