# Cortex Architecture

Cortex is an autonomous research agent system for robotics and AI/ML. It runs as a server-client architecture: the **agent-server** orchestrates work — conversations and their agent runs, scheduling, chat integrations, and MCP tools — while remote **agent clients** connect via WebSocket to execute commands on remote machines. For deeper dives into these subsystems, see [memory.md](./memory.md), [scheduling.md](./scheduling.md), and [mcp.md](./mcp.md).

## Two Packages

Cortex consists of two npm packages plus a set of plugins:

| Package | Path | Purpose |
|---------|------|---------|
| `@cortex-agent/server` | `agent-server/` | Main server: Slack bot, LLM orchestration, scheduling, MCP tools. Provides four CLI binaries: `cortex`, `cortex-hook`, `cortex-evidence-export`, `cortex-signal`. |
| `@cortex-agent/client` | `client/` | Lightweight remote agent daemon. Connects via WebSocket and executes shell/file commands locally. |
| Plugins | `plugins/cortex-*` | Plugin bundles containing skills. Not npm packages — loaded as directories at runtime. |

## Agent-Server Architecture: Six Layers

The agent-server code at `agent-server/src/` is organized into six strict layers (L0 through L5). Each layer may only import from lower-numbered layers. This constraint is **enforced at test time** by `agent-server/.dependency-cruiser.cjs` — the `depcruise` rule runs as part of `npm test` and fails the build on any violation.

```
L0  core/          → (no dependencies)
L1  store/         → core
L2  events/        → core
L3  domain/        → core, store, events
L4  orchestration/ → core, store, events, domain
L5  entry/         → everything (composition root)
```

Two additional directories sit outside the layer hierarchy because they are imported across multiple layers:

- **`agent-adapter/`** — the two-LLM-backend abstraction (Claude Code and PI)
- **`platform/`** — the messaging platform abstraction (Slack)

### Layer 0: `core/` — Zero-Dependency Foundation

The foundation layer. Contains only pure TypeScript with no runtime dependencies on other layers.

| File | Purpose |
|------|---------|
| `paths.ts` | Canonical path constants: `INSTALL_ROOT`, `DATA_DIR` (`~/.cortex/`), `CONFIG_DIR`, `STORE_DIR`, `CONTEXT_DIR`, `PROJECTS_DIR`, `WORKSPACE_DIR`, `PLUGINS_DIR`, `PROMPTS_DIR`, `HOOKS_DIR`, `LOGS_DIR` |
| `utils.ts` | Re-exports path constants plus utility functions: `chunkText`, `formatDurationCompact`, `todayISO`, `listProjectDirs`, `readableTimestamp` |
| `async-mutex.ts` | `AsyncMutex` class — promise-based mutex for serializing async disk writes. Used throughout the store layer to prevent concurrent file corruption |
| `log.ts` | `createLogger(tag)` — console + daily-rolling file sink with 14-day retention |
| `cli-utils.ts` | `formatHelp`, `formatError`, `readStdinSync`, `cliError` — shared CLI formatting |
| `status-format.ts` | Pure formatting: `computeElapsed`, `formatMetricsSuffix`, `buildSessionTag`, `buildUserProcessingMessage` |
| `rebuild-progress.ts` | The hot-rebuild progress record the supervisor publishes to `daemon-rebuild.json`: pure step transitions (`planRebuildProgress`, `startRebuildStep`, `finishRebuildStep`, `settleRebuildProgress`) plus a read that never throws |
| `run-registry.ts` | `RunRegistry` — the single in-memory index of the executions that are live right now, keyed by executionId and indexed by channel. Publishes the `agent.*` lifecycle events to the EventBus |
| `session-holds.ts` | `SessionHolds` — the other half of "is this session busy": a turn that ended while background work continues, with per-owner handles, supersede and stop |
| `session-state.ts` | `sessionState(sessionId)` / `channelEngineBusy()` — the one join of live executions and holds, and the only place that answers whether a session is busy |
| `types/agent-types.ts` | `AgentResult`, `AgentHandle`, `AgentProgress`, `AskUserQuestionInfo` |
| `types/environment-types.ts` | Execution environment types: `AgentDefinition` (one `config/environments/*.json` file), its per-use overrides, and the resolved `AgentSlotConfig` a run opens with |
| `config-generator.ts` | Config file initialization for new installs |
| `gateway-generator.ts` | API gateway YAML generation |
| `profile-generator.ts` | Profile JSON generation |

### Layer 1: `store/` — Persistence

All write operations are serialized through `AsyncMutex` to prevent corruption from concurrent writes. The layer uses two repository patterns:

- **Pattern A (JsonRepository delegation)**: Simple CRUD wrappers around `JsonRepository<T>`. Used for schedule-repo, session-repo, channel-repo, session-registry-repo, cost-repo. All writes go through `atomicWrite()` (write to `.tmp.<pid>.<ts>` then `fs.rename`).
- **Pattern B (in-memory Map + fire-and-forget persist)**: Synchronous in-memory `Map` for reads, with async persist chain for writes. Used for execution-repo where read latency matters and stale-on-crash is acceptable.

| File | Purpose |
|------|---------|
| `json-repository.ts` | Generic `JsonRepository<T>` base class: `read()`, `write()`, `mutate(fn)`, `flush()`. Lazy orphan `.tmp.*` sweep on first I/O. Corrupt-JSON backup mechanism |
| `atomic-write.ts` | `atomicWrite(filePath, data)` — write to `.tmp.<pid>.<ts>` then `fs.rename` |
| `outbound-queue.ts` | WAL-based durable outbound message queue. 30-min TTL, 200-entry compaction, 5-second drain loop. Coalesces consecutive updates to the same message |
| `conversation-ledger-repo.ts` | Façade over `session-registry-repo.ts` — same per-channel turn API (`initConversation`, `beginTurn`, `addResponseTs`, `completeTurn`, `rollbackTo`) with no file of its own |
| `session-registry-repo.ts` | JSONL-backed `cortex-XXXX` short-name registry and single owner of session records, channel→session bindings, and per-channel conversation headers and turns. Replays an append-only journal (`put`/`patch`/`delete-intent`/`delete-commit`/`bind`/`unbind`/`turn`/`conversation`), admits sessions, and compacts snapshots when the log grows |
| `execution-repo.ts` | Pattern B repository. Full CRUD: `startLocalExecution`, `registerDispatchExecution`, `completeExecution`, `failExecution`. Async stale detection via `reconcileStaleDispatches` |
| `channel-repo.ts` | `projectName → channelId` mapping |
| `project-dir-repo.ts` | `projectName → machineName → dirPath` with reverse channel lookup |
| `schedule-repo.ts` | Schedule persistence. `ScheduleTask` interface, `ScheduleTarget` union type |
| `cost-repo.ts` | Costs in JSONL (append-only), budget in JSON. 90-day pruning at startup |
| `profile-repo.ts` | Hybrid sync/async reader. `startProfileWatcher()` for hot-reload |

### Layer 2: `events/` — Event Bus

A synchronous, type-safe event bus with JSONL logging.

| File | Purpose |
|------|---------|
| `event-types.ts` | The `CortexEvent` discriminated union: user events plus two meta events (`event-bus.handler-failed`, `event-logger.dropped`). Categories: message/interaction, agent lifecycle, session, system |
| `event-bus.ts` | `EventBus` class — `subscribe(type, handler)` / `publish(event)`. Synchronous fan-out. Async handlers fire-and-forget. Re-entrant guard for `event-bus.handler-failed`. Close hooks for SIGTERM drain |
| `event-logger.ts` | Subscribes to `'*'`, ring buffer of 1024 entries, 100ms flush interval, daily rolling JSONL, 14-day retention. Gated by the `eventLog` setting in [`config/settings.json`](./configuration.md#configsettingsjson) (set it to `false` to disable; legacy env `CORTEX_EVENT_LOG=off` still works as a deprecated fallback) |

**Event categories:**

- **Message/interaction**: `message.received`, `message.edited`, `plan.submitted`, `plan.approved`, `ask-user.requested`, `ask-user.answered`
- **Agent lifecycle**: `agent.started`, `agent.completed`, `agent.failed`, `agent.superseded`
- **System**: `llm.active-count-delta`, `scheduler.tick`, `rate-limit.breach`

### Layer 3: `domain/` — Business Logic

The thickest layer. Contains one subdirectory per domain concern; the table below covers the main ones.

| Subdirectory | Purpose |
|-------------|---------|
| `agents/` | Profiles, execution environments (`agents/environments/`), subagent roles and credentials: what a run may be configured as. Starting one belongs to `runs/` |
| `runs/` | The run layer: `startRun` and the `AgentRun` ownership object, `RunRequest` profile/spec/prompt resolution and its shared builders (`builders.ts`), the backend-neutral `RunEvent` stream, and the `SessionEngines` pool |
| `sessions/` | Session lifecycle. Hook pipeline (onNew, onMessageEnd) with VirtualMessage display and optional agent injection |
| `executions/` | Thin re-export over `store/execution-repo.ts` |
| `costs/` | Cost tracking, gateway management, rate limiting with per-provider awareness |
| `scheduling/` | Persisted schedule engine plus settings-backed built-in job controller. `Scheduler` hot-reloads user schedules and opens a new session for each fire; built-in jobs such as the memory-index rebuild own daemon timers |
| `memory/` | Memory/index management. `memory-index-regen.ts` rebuilds index.md from YAML frontmatter. File watcher for context changes. AGENTS.md scanning and injection |
| `monitor/` | GPU and disk resource monitoring |
| `system/` | Host-level concerns: doctor checks, update state and prompts, system notices and their history, and `rebuild-hold.ts` — the supervisor-pushed "no new turns" state consulted by admission |
| `remote/` | Remote device management via WebSocket. SSH-based client bootstrap; clients self-update from server-pushed bundles |
| `mcp/` | The bundled Cortex MCP server and its tool modules (see [mcp.md](./mcp.md)) |

### Layer 4: `orchestration/` — Message Routing and Execution

Connects platform messages to domain logic. The hook-bridge (part of this
layer) is detailed in [hooks.md](./hooks.md).

| File | Purpose |
|------|---------|
| `channel-queue.ts` | Per-channel serial Promise queue. Ensures only one agent runs per channel at a time |
| `orchestrator.ts` | Hands each inbound message to `AgentRunner` |
| `agent-runner.ts` | Admission for the default-agent path: routing, mid-turn injection, queueing, and the session/lease/browser resolution a turn needs. The turn body itself belongs to `turn/turn.ts` |
| `session-gateway.ts` | `deliverToSession()` — the one door into a conversation turn for everything that is not an inbound platform message (web sends, scheduled fires, agent results, resumes, waitpoint wakes) |
| `runtime.ts` | The `PlatformAdapter` + `EventBus` orchestration holds, injected once by the composition root |
| `conversation-request.ts` | `prepareConversationRequest()` — assembles a plain chat turn's `RunRequest`: agent spec plus the first-turn ambient blocks |
| `turn/turn.ts` | `Turn` / `openTurn()` — the single owner of one conversation turn: status message, ledger turn tracking, session lease, `startRun`, observer fan-out, terminal render, the `running:true/false` bracket |
| `turn/turn-prep.ts` | What a caller resolves before `openTurn`: the turn's files, its session record and use lease, the browser endpoint the session opted into |
| `turn/terminal.ts` | A turn's terminal rendering: status seal, the ledger's turn completion, the error body, error-session persistence |
| `turn/turn-tracking.ts` | The ledger half of a turn's bookkeeping: begin, snapshot, accept, and the supersede-while-pending window |
| `turn/active-turns.ts` | Per-channel turn state: the streaming callback a turn registered, the edit-supersede flag |
| `turn/background-hold.ts` | One hold lifecycle for "the turn is over but the session is not": busy bracket, `SessionHolds` registration, run subscription, six terminal verdicts |
| `turn/hold-render-platform.ts` | The Slack/Feishu rendering of a held turn — the status line while the background phase runs, and its seal |
| `turn/hold-render-web.ts` | The web rendering of a held turn — the continuation's prose, tools and notices on the session event stream |
| `resume-dispatcher.ts` | Rate-limit resume queue: continues the sessions a usage limit interrupted once the window resets |
| `busy-tracker.ts` | Tracks active LLM count, sends IPC `busy`/`idle` to parent daemon process |
| `human-answer-backstop.ts` | Leaf registry of channels waiting on a human's free-text reply, consulted by every entry into a session so the answer is consumed instead of opening a turn |
| `routing/message-router.ts` | Slack message entry point. Normalizes skill commands and delegates to the orchestrator |
| `routing/commands/` | `!command` handlers: `cancel`, `channel`, `compact`, `cost`, `device`, `lang`, `login`, `mode`, `nvtop`, `orient`, `restart`, `schedule`, `sendfile`, `session`, `status`, `tail`, `usage` |
| `routing/hook-bridge.ts` | PreToolUse hook → EventBus bridge. Publishes `plan.submitted` and `ask-user.requested` |
| `routing/hook-bridge-subscribers.ts` | Subscribers that create Slack modals for questions and send plans to Slack |
| `interactions/` | AskUserQuestion modal flow, plan approval state machine, button/modal action routing |

### Layer 5: `entry/` — Composition Root

| File | Purpose |
|------|---------|
| `app.ts` | **Composition root**. Wires EventBus → logger → hook-bridge → RunRegistry → adapters → commands → interactions → scheduler → remote clients → webhook → memory watcher. Handles SIGTERM graceful shutdown |
| `daemon.ts` | Process supervisor. Forks `app.js`, watches `src/*.ts` for auto-rebuild (when `CORTEX_REPO` is set), watches `.restart` trigger file, crash recovery with exponential backoff (1s→30s max). Publishes per-step rebuild progress, waits for an idle app before install/restart, and holds new turns across that window (see below) |
| `daemon-notice.ts` | The app side of the downward IPC: turns `rebuild-aborted` into a system notice and `rebuild-hold` into the admission hold, and lifts the hold if the supervisor disconnects |
| `cli.ts` | `cortex` CLI entry point. Dispatches to: `init`, `start`, `daemon`, `restart`, `tui`, `config`, `setup-gateway` |
| `init.ts` | Interactive first-time initialization |
| `startup-helpers.ts` | Cleanup logs, ensure MCP config |
| `startup-notify.ts` | Send startup DM to admin channel |

### Hot Rebuild: Published Progress and the Turn Hold

With `CORTEX_REPO` set, a source change makes the supervisor rebuild the packages, reinstall itself,
and replace the app process. Two mechanisms make that visible and safe.

**Progress lives in a file, not in memory.** Before step one the pipeline writes its whole plan to
`$STORE_DIR/daemon-rebuild.json` — the steps this checkout will run (`server`, `ui-contract`, `web`,
then `install` and `restart`), which one is in flight, and how each ended (`done`, `failed`,
`skipped`), with the `install` step recording whether it took the fast staged-rename path or
`npm pack` + `npm install -g`. A file is the only option: the pipeline's last act replaces the very
process that would have held that state, so nothing in memory can tell the new `app.js` what the
rebuild it was born from did. `system.daemonStatus` reads the record and the daemon page renders it,
polling once per second while a rebuild runs. A `running` record whose `daemonPid` is not the live
supervisor is dropped rather than shown forever; a terminal record is kept, so "the last rebuild
failed at `web`" is still readable after the restart. The terminal statuses are `succeeded`,
`aborted`, and `deferred`.

**The dangerous half of the pipeline waits for an idle app.** The build steps read the repo and
write `dist/`; the `install` step overwrites the files the running `app.js` loaded and `restart`
kills it. So busy/idle is checked twice: once before the build, and again after it, because a build
takes minutes and a turn can legitimately have started meanwhile. A busy child at the second gate
parks the trigger in `pendingRebuild`, publishes the record as `deferred`, and the whole pipeline
runs again on the next idle transition — real work is waited for, not refused, because a refused
turn is not a delayed turn (a waitpoint wake or a background agent's result would be dropped
outright).

**No new turns in the seconds the process is being replaced.** Entering `install` or `restart` — or
queueing a restart — makes the supervisor send `rebuild-hold` down the fork IPC, and admission
(`agent-runner.ts`) refuses before tracking, queueing, or mid-turn injection:
a turn started now is orphaned by the SIGTERM a moment later, with its backend CLI left writing into
a pipe no one reads. The scope is deliberately narrow — never the build — so the only messages it
can catch are those landing in the tick-level race between the idle check and the SIGTERM. A person
who typed gets an in-channel reply naming the current phase; a callback or system message nobody is
waiting on becomes a warning-level system notice naming what was dropped. The hold carries a
five-minute lease renewed by each phase message, so a supervisor that dies mid-pipeline cannot mute
the app forever, and an IPC `disconnect` lifts it immediately.

## LLM Backend Adapter

The `agent-adapter/` directory abstracts two LLM backends behind a unified interface:

| Backend | Adapter | Notes |
|---------|---------|-------|
| Claude Code | `claude/adapter.ts` | Stateless engine adapter: opens a Claude process session (print mode), spawn-args builder, event parser. TUI mode (tmux + JSONL tail) is deprecated (D9) |
| PI | `pi/adapter.ts` | Stateless engine adapter: opens an in-process PI session, MCP bridge, hook bridge, tool shims |

The session pool lives in `domain/runs/engines.ts` (`SessionEngines`), not in either adapter.

A normalization layer (`normalize/`) converts backend-specific events into a unified `NormalizedEvent` stream. The `capabilities.ts` file declares a `Capability` enum with capability sets for Claude and PI.

## Platform Adapter

The `platform/` directory abstracts Slack behind a `PlatformAdapter` interface:

| Method | Purpose |
|--------|---------|
| `start` / `stop` | Lifecycle |
| `onMessage` / `onMessageEdit` / `onAction` / `onModalSubmit` | Event registration |
| `postMessage` / `updateMessage` / `deleteMessage` | Outbound messaging |
| `postInteractive` | Interactive messages with buttons |
| `openModal` | Modals |
| `uploadFile` / `downloadFile` | File operations |
| `addReaction` | Emoji reactions |
| `getPermalink` / `getAdminChannel` | Utility |

`VirtualMessage` handles message aggregation — merging multiple appends into fewer messages with retry delays to avoid rate limits.

## WebSocket Protocol (Server ↔ Client)

The WebSocket protocol is used for **remote device command execution**, not for Slack/agent communication. The server runs a WebSocket server (default port 3002) via `startClientManager()`. For the full cross-machine story — deployment, network topology, and security — see [cross-machine.md](./cross-machine.md).

### Message Flow

1. **Client connects** → sends `{ type: 'hello', device, platform, capabilities }`
2. **Server validates** → checks for duplicate device name (error code `4002` if duplicate)
3. **Heartbeat** → client sends `{ type: 'heartbeat', device, timestamp }` every 5 seconds. Server marks device offline after 15 seconds of silence (code `4003`)
4. **Command dispatch** → server sends `{ type: 'command', commandId, action, params }`. Client executes and replies with `{ type: 'result', commandId, success, data, error }`

### Command Actions

The client supports these remote actions: `bash` (shell execution with timeout/background), `read` (file read with text/image/PDF support), `write` (file write with CRLF detection), `edit` (text replacement with replace_all), `glob` (file glob with VCS exclusion), `grep` (ripgrep with pagination), `file.stat` (pre-transfer metadata probe).

### Client Architecture

The client (`client/src/client.ts`) is a lightweight WebSocket daemon that maintains a persistent connection. It supports automatic reconnection with exponential backoff (1s→30s max). It does not launch or supervise long-running jobs: those run independently and report back through a [waitpoint](./waitpoints.md).

## Event Bus Topology

The EventBus is wired in `app.ts` via a singleton-then-inject pattern. Components are constructed with no dependencies, then wired via `setBus(bus)`:

| Component | Publishes | Subscribes |
|-----------|-----------|------------|
| `runRegistry` | `agent.started/completed/failed/superseded` | — |
| `eventLogger` | `event-logger.dropped` | `'*'` (all events → JSONL) |
| `planApprovals` | `plan.approved` | `plan.submitted` |
| `busyTracker` | — | `llm.active-count-delta` |
| `interactionHandlers` | `ask-user.answered` | `ask-user.requested` |
| `hookBridge` | `plan.submitted`, `ask-user.requested` | — |

## State Storage

Cortex stores all state on the filesystem under `~/.cortex/`. There is no database — everything is JSON or JSONL on disk, with the session registry and history paths intentionally append-oriented.

| Path | Purpose |
|------|---------|
| `agent-state.json` | Selected profile, default agent, and per-channel overrides (migrated once from `mode.json`) |
| `profiles.json` | Named agent profile list |
| `schedules.json` | Persistent schedule list |
| `session-registry.jsonl` | Append-only JSONL journal and single owner of session records, channel→session bindings, and per-channel conversation headers and turns. Events: `put`/`patch`/`delete-intent`/`delete-commit`/`bind`/`unbind`/`turn`/`conversation`; startup replays the stream to rebuild live and pending state. Compaction keeps live records + bindings + live turns; it runs once the journal holds more than `max(512, live×4, 2×compacted)` events — where `compacted` is the number of events a compaction would write — or exceeds both 16 MB and twice its size after the last compaction. Replaces the retired `sessions.json` and `conversation-ledger.json`, which a one-time upgrade migration renames to `*.pre-2026.9.14.bak` |
| `retention-candidates.json` | Two-sweep orphan retention candidates for history and PI cleanup |
| `conversation-history/` | Per-session transcript/history JSONL keyed by stable Cortex session id |
| `executions.json` | Unified execution registry |
| `daemon-rebuild.json` | The supervisor's published hot-rebuild record: plan, per-step status and timings, and the terminal outcome of the last rebuild |
| `config/environments/` | Execution environments — one JSON file per environment |
| `costs.jsonl` | Per-call cost records (90-day rolling) |
| `logs/sessions/` | Claude capture logs used for retention protection/cleanup |
| `logs/sessions-pi/` | PI transcript bundles keyed by backend session id |
| `logs/` | Daemon and backend logs |

The session registry is no longer a single mutable JSON blob. `session-registry-journal.ts` owns an append-only JSONL file whose events carry the full session record for `put` and `delete-intent`, plus a final `delete-commit`. A delete intent also freezes the validated Claude turn-backup cleanup manifest, so a later retry does not depend on a ledger that an earlier partial cleanup already removed. Startup first migrates any legacy `session-registry.json` file into the journal, writes a backup of that legacy file, truncates any unterminated tail, and then stream-replays the journal line by line into in-memory `live` and `pending` maps. When the journal grows too large, compaction rewrites a minimal snapshot consisting of one full-record event per live session plus one `delete-intent` event per pending deletion.

Session retention is coordinated separately from registry mutation. `session-retention-controller.ts` starts a `session-retention.ts` sweep in the background at app startup — boot does not wait for it, and the session registry's own lock serializes it against other session mutations — then runs it every 6 hours, with an immediate debounced rerun when `sessionRetentionDays` hot-reloads. The startup sweep begins after any ready provider-resume dispatch, and queued direct resumes retain their stable tracking id as a liveness guard. The coordinator retries pending delete commits, writes registry delete intents for all expired idle sessions in one append, then works through them in batches of 100 — one append each releases their channel bindings and their conversations, their files are deleted, and one append commits the sessions whose cleanup succeeded. Stopping the controller aborts the sweep between batches, leaving uncommitted deletions pending for the next sweep. It also prunes orphan `conversation-history`, prunes orphan PI transcript bundles, prunes inactive Claude capture logs, prunes orphan `tmp/tool-images/` session directories, and syncs Claude user `cleanupPeriodDays`.

## Naming Conventions

- **Execution IDs**: `exec_<kind>_<base36-ts>_<4-rand>` (e.g., `exec_local_1a2b3c_xyzw`)
- **Schedule IDs**: 8 hex characters (from `randomBytes(4)`)
- **Session names**: `cortex-<6-hex-chars>` (e.g., `cortex-a1b2c3`)
- **File format**: All TypeScript uses `.ts` with ESM import style (`import { X } from './foo.js'`)
