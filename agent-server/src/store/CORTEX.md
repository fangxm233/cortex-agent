Please update me when files in this folder change

Persistence layer (L1) — 12 store modules: 11 data repos + outbound-queue WAL + in-memory-repository test implementation. All write operations are serialized via AsyncMutex.
`JsonRepository` and `atomicWrite` (the underlying base + primitive) live in `core/` — they are zero-dependency utilities consumed by both `store/` repos and platform adapter conduit stores.
task-repo.ts responsibilities are limited to I/O + lock + git sync, does not carry any domain mutation forwarding (mutations have been migrated to domain/tasks/mutator.ts).

| filename | role | function |
|---|---|---|
| `in-memory-repository.ts` | base | In-memory implementation for testing |
| `outbound-queue.ts` | persistence | WAL-based outbound message queue, prevents message loss on restart. Provides durablePost/durableUpdate helper functions |
| `thread-repo.ts` | persistence | Thread state persistence |
| `session-repo.ts` | persistence | Session persistence |
| `conversation-ledger-repo.ts` | persistence | Conversation ledger persistence (per-channel turn→message-ts mapping for edit/rollback) |
| `conversation-history-repo.ts` | persistence | Cortex's backend-independent conversation history — one **append-only JSONL file per session** under `store/conversation-history/<sessionId>.jsonl` (keyed by sessionId, persistent across reconnects). Writes are pure O(1) appends (`appendUser`/`appendAssistant`/`appendTool`, serialized per session); turn grouping + streaming-growth dedup are derived at READ time (`getHistory`). The full event stream (user inputs, every assistant message, every tool call) and the TUI transcript-replay source. Fed by BOTH the direct path (agent-runner) and thread steps (domain/threads/thread-transcript). Also exports `summarizeToolInputForHistory` (shared one-line tool-input summary). Does NOT use JsonRepository/atomicWrite. |
| `session-registry-repo.ts` | persistence | Session registry persistence. Each `Session` carries `kind` ('local'\|'scheduled', resumable semantics) AND `origin` ('direct'\|'thread'\|'scheduled', how it was initiated — the UI session list shows only origin='direct'). `deriveSessionOrigin(kind,label)` is the single source of truth (scheduled kind → scheduled; `[threadId:slot]` label → thread; else direct), used as the registerSession default and to back-fill legacy records in the migration. `listByOrigin(origin, projectId?)` drives the origin-filtered UI list. `lastReadAt` (optional, stamped by `markRead(sessionId)`) backs the web unread flag: unread = lastUsedAt > lastReadAt. |
| `execution-repo.ts` | persistence | Execution registry persistence |
| `project-dir-repo.ts` | persistence | Project → external code directory mapping |
| `schedule-repo.ts` | persistence | Scheduled task list persistence — ScheduleTask includes target (fresh/channel/session/thread) + fallback (fresh/skip/wait), migrate auto-backfills target=fresh for old records |
| `cost-repo.ts` | persistence | Cost record persistence |
| `profile-repo.ts` | persistence | Agent profile persistence |
| `task-repo.ts` | persistence | load/refresh/flush + read-only queries + runExclusive/commitAndPush. Pure I/O + mutex + git, no domain mutation forwarding |
| `version-migrations.ts` | startup | `runMigrations()` — version-tracked file migrations (CalVer in `data/versions.json`), run on startup before config load. Supports JSON (parse/serialize) and `format:'text'` migrations (raw markdown, e.g. system prompts / CORTEX.md via `upsertMarkerBlock`; directive-prompt phrasing fixes via `applyReplacements`) |
| `hook-sync.ts` | startup | `syncManagedHooks()` — refresh version-stamped (`@cortex-hook-version`) hooks in `DATA_DIR/hooks` from defaults when shipped is newer; closes init's copy-if-missing gap so hook code fixes reach existing installs |
| `plugin-sync.ts` | startup | `syncManagedPlugins()` — deploy new plugins / refresh updated skills in `DATA_DIR/plugins` from defaults when the shipped `.claude-plugin/plugin.json` `version` is newer; closes the same copy-if-missing gap for plugins. CONVENTION: bump a plugin's manifest `version` whenever you change any file inside it, or the change won't reach existing installs |

Removed in the OutputStream refactor: `channel-repo.ts` (project→Slack channel mapping). The mapping is adapter-private and now lives in `platform/adapters/slack-project-conduits.ts`; the channel→project reverse lookup that used to live on `ProjectDirRepo.getChannelProject()` is now `PlatformAdapter.resolveInboundProject()`.
