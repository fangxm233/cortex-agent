# Cortex Architecture

Cortex is an autonomous research agent system for robotics and AI/ML. It runs as a server-client architecture: the **agent-server** orchestrates work — conversations and their agent runs, scheduling, chat integrations, the Web UI, and MCP tools — while remote **agent clients** connect via WebSocket to execute commands on remote machines. For deeper dives into these subsystems, see [memory.md](./memory.md), [scheduling.md](./scheduling.md), and [mcp.md](./mcp.md).

## Packages

The repository is a pnpm workspace. Two packages are published to npm; the others are built into them or deployed on their own.

| Package | Path | Purpose |
|---------|------|---------|
| `@cortex-agent/server` | `agent-server/` | Main server: Slack and Feishu adapters, the Web UI host, the TUI gateway, LLM orchestration, scheduling, MCP tools. Provides five CLI binaries: `cortex`, `cortex-browser`, `cortex-hook`, `cortex-evidence-export`, `cortex-signal`. The published package also carries the built web app and the client bundle |
| `@cortex-agent/client` | `client/` | Lightweight remote agent daemon (`cortex-client`). Connects via WebSocket and executes shell/file commands locally |
| `@cortex-agent/web` | `web/` | Vite + React app for the browser, desktop and mobile layouts. Built to `web/dist` and served by the server's Web UI host |
| `@cortex-agent/desktop` | `desktop/` | Tauri v2 desktop and Android shell. Serves the web app through the `cortexui://` scheme, from its bundled copy or a newer bundle downloaded from the server |
| `@cortex-agent/ui-contract` | `packages/ui-contract/` | Type-only re-export of the server's Web UI router and DTO types, which the web app compiles against |
| `@cortex-agent/deepseek-relay-worker` | `packages/deepseek-relay-worker/` | Cloudflare Worker that relays to DeepSeek for hosts that cannot reach it directly |
| Plugins | `agent-server/defaults/plugins/` | Built-in plugin bundles (`cortex-system`, `cortex-board`, `cortex-feishu`) containing skills. Not npm packages — read in place as directories at runtime |

## Agent-Server Architecture: Six Layers

The agent-server code at `agent-server/src/` is organized into six layers (L0 through L5), plus two adapter directories with rules of their own. A layer may import only from the layers below it at runtime; type-only imports may cross layers. These rules are **enforced at test time** by `agent-server/.dependency-cruiser.cjs` — `npm test` runs `depcruise` and fails on any runtime violation (`npm run test:quick` skips it).

```
L0  core/          → (no runtime dependencies)
L1  store/         → core
L2  events/        → core
L3  domain/        → core, store, events, platform, agent-adapter
L4  orchestration/ → core, store, events, domain, platform, agent-adapter
L5  entry/         → everything (composition root)

    platform/      → core, events
    agent-adapter/ → core, store, events
```

`orchestration/` must also be free of import cycles.

- **`agent-adapter/`** — the two-LLM-backend abstraction (Claude Code and PI). `domain/runs/adapters.ts` is the one place the adapters are assembled.
- **`platform/`** — the messaging and transport layer: the Slack and Feishu adapters, the TUI gateway, the composite adapter that runs several platforms at once (`adapters/`), the Web UI HTTP host (`ui-http/`), and the server's Chrome and the agent-browser process runner (`browser/`).

A further directory, **`tui/`**, is the Ink terminal client that `cortex tui` runs. It talks to the server only over the TUI gateway's WebSocket, sharing the gateway's protocol types and the i18n strings, and has no layer rule of its own.

### Layer 0: `core/` — Shared Kernel

The shared kernel every other layer builds on: types, path constants, settings, and the in-memory run and session state. It has no runtime imports of other layers; it may import their types, which is how core types such as the hook bus entry or the environment definition refer to shapes owned elsewhere.

| File | Purpose |
|------|---------|
| `paths.ts` | Canonical path constants: `INSTALL_ROOT`, `DEFAULTS_DIR`, `DATA_DIR` (`~/.cortex/`), `CONFIG_DIR`, `STORE_DIR` (`data/`), `CONTEXT_DIR`, `PROJECTS_DIR`, `WORKSPACE_DIR` (`tmp/`), `PLUGINS_DIR`, `PROMPTS_DIR`, `HOOKS_DIR`, `LOGS_DIR`, `AGENT_CWD`, `CLAUDE_CONFIG_HOME`, and the daemon PID and restart-trigger files |
| `settings.ts`, `settings-spec.ts` | The runtime settings in `config/settings.json`: the key schema with defaults and legacy variables, validation, the cached snapshot, and hot reload (see [configuration.md](./configuration.md#configsettingsjson)) |
| `utils.ts` | Utility functions: `chunkText`, `formatDurationCompact`, `todayISO`, `listProjectDirs`, `readableTimestamp`, npm prefix resolution |
| `atomic-write.ts` | `atomicWrite(filePath, data)` / `atomicWriteSync` — write to `.tmp.<pid>.<ts>.<rand>` then `fs.rename`; `mutateFileAtomically` for read-modify-write |
| `json-repository.ts` | Generic `JsonRepository<T>` base class: `read()`, `write()`, `mutate(fn)`, `flush()`. Lazy orphan `.tmp.*` sweep on first I/O. Corrupt-JSON backup mechanism |
| `async-mutex.ts` | `AsyncMutex` class — promise-based mutex for serializing async disk writes. Used throughout the store layer to prevent concurrent file corruption |
| `log.ts` | `createLogger(tag)` — console + daily-rolling file sink with 14-day retention |
| `i18n.ts`, `locales/` | English and Chinese strings for system-generated messages; `CORTEX_LANG` or the `!lang` preference picks the locale |
| `cli-utils.ts` | `formatHelp`, `formatError`, `readStdinSync`, `readStdinBufferSync`, `cliError` — shared CLI formatting |
| `status-format.ts` | Pure formatting: `computeElapsed`, `formatMetricsSuffix`, `buildSessionTag`, `buildUserProcessingMessage`, `renderTurnStatus` |
| `rebuild-progress.ts` | The hot-rebuild progress record the supervisor publishes to `daemon-rebuild.json`: pure step transitions (`planRebuildProgress`, `startRebuildStep`, `finishRebuildStep`, `settleRebuildProgress`) plus a read that never throws |
| `run-registry.ts` | `RunRegistry` — the single in-memory index of the executions that are live right now, keyed by executionId and indexed by channel. Publishes the `agent.*` lifecycle events to the EventBus |
| `session-holds.ts` | `SessionHolds` — the other half of "is this session busy": a turn that ended while background work continues, with per-owner handles, supersede and stop |
| `session-state.ts` | `sessionState(sessionId)` / `channelEngineBusy()` — the one join of live executions and holds, and the only place that answers whether a session is busy |
| `agents/` | Subagent role loading (`roles.ts`) and the shared delegation schema, model choice and orchestration (`subagent/`) used by both backends |
| `types/agent-types.ts` | `Backend`, `AgentResult`, `AgentProgress`, `AskUserQuestionInfo`, and the todo, context-usage, attachment and notice shapes |
| `types/environment-types.ts` | Execution environment types: `AgentDefinition` (one `config/environments/*.json` file) and the `ResolvedEnvironment` a run opens with |
| `config-generator.ts` | Config file initialization for new installs, and the MCP configs written at every start |
| `gateway-generator.ts` | API gateway YAML generation |
| `models-generator.ts` | Default model and favorites JSON generation |

### Layer 1: `store/` — Persistence

All write operations are serialized through `AsyncMutex` to prevent corruption from concurrent writes. The layer uses two repository patterns:

- **Pattern A (JsonRepository delegation)**: Simple CRUD wrappers around `JsonRepository<T>`. Used for schedule-repo, cost-repo, board-repo, waitpoint-repo, provider-state-repo and most other repositories. All writes go through `atomicWrite()`.
- **Pattern B (in-memory Map + fire-and-forget persist)**: Synchronous in-memory `Map` for reads, with async persist chain for writes. Used for execution-repo where read latency matters and stale-on-crash is acceptable.

| File | Purpose |
|------|---------|
| `outbound-queue.ts` | WAL-based durable outbound message queue. 30-min TTL, 200-entry compaction, 5-second drain loop. Coalesces consecutive updates to the same message |
| `conversation-ledger-repo.ts` | Façade over `session-registry-repo.ts` — same per-channel turn API (`initConversation`, `beginTurn`, `addResponseTs`, `completeTurn`, `rollbackTo`) with no file of its own |
| `session-registry-repo.ts` | JSONL-backed UUID session registry and single owner of session records, channel→session bindings, and per-channel conversation headers and turns. Replays an append-only journal (`put`/`patch`/`delete-intent`/`delete-commit`/`bind`/`unbind`/`turn`/`conversation`), admits sessions, and compacts snapshots when the log grows |
| `conversation-history-repo.ts` | Per-session transcript JSONL under `data/conversation-history/`, the record the Web UI renders a conversation from |
| `execution-repo.ts` | Pattern B repository: `startLocalExecution`, `completeExecution`, `failExecution`, `cancelExecution`. At startup `markMissingRunningExecutionsStale` marks runs that are not alive any more as stale; terminal records older than seven days are archived to `data/archive/` |
| `project-dir-repo.ts` | `projectName → machineName → dirPath` with reverse channel lookup |
| `schedule-repo.ts` | Schedule persistence. `ScheduleTask` interface; `schedules.json` is shared with out-of-process writers |
| `cost-repo.ts` | Costs in JSONL (append-only), budget in JSON. 90-day pruning at startup |
| `models-repo.ts` | Synchronous cached reader. `startModelsWatcher()` for hot-reload |
| `waitpoint-repo.ts`, `provider-state-repo.ts`, `board-repo.ts` | Waitpoints, provider throttle state and the resume queue, and the board registry |
| `team-inbox-repo.ts`, `team-outbox-repo.ts` | Messages between team leads and their workers, kept across restarts |
| `hook-registry.ts`, `hook-writer.ts` | The hook registry: built-in declarations with `config/hooks/` laid over them, and the writer behind hook switches |
| `version-migrations.ts` | One-time upgrade migrations of `$CORTEX_HOME`, run at startup |

### Layer 2: `events/` — Event Bus

A synchronous, type-safe event bus with JSONL logging.

| File | Purpose |
|------|---------|
| `event-types.ts` | The `CortexEvent` discriminated union, grouped below, plus two meta events (`event-bus.handler-failed`, `event-logger.dropped`) |
| `event-bus.ts` | `EventBus` class — `subscribe(type, handler)` / `publish(event)`. Synchronous fan-out. Async handlers fire-and-forget. Re-entrant guard for `event-bus.handler-failed`. Close hooks for SIGTERM drain |
| `event-logger.ts` | Subscribes to `'*'`, ring buffer of 1024 entries, 100ms flush interval, daily rolling JSONL under `logs/events/`, 14-day retention. Gated by the `eventLog` setting in [`config/settings.json`](./configuration.md#configsettingsjson) (legacy env `CORTEX_EVENT_LOG=off` is read as a deprecated fallback) |

**Event categories:**

- **Session**: `session.message`, `session.message.delta`, `session.message.delivered`, `session.status`, `session.turn`, `session.turn.completed`, `session.todos`, `session.context-usage`, `session.context-compacted`, `session.rewound`, `session.decision`, `session.board`, `session.interaction`, `session.tool-images`, `session.debug.updated`
- **Interaction**: `plan.submitted`, `plan.approved`, `ask-user.requested`, `ask-user.answered`
- **Agent lifecycle**: `agent.started`, `agent.completed`, `agent.failed`, `agent.superseded`
- **Auth**: `auth.required`, `auth.recovered`
- **Board**: `board.updated`, `board.style-updated`
- **System**: `system.notice`, `config.changed`, `llm.active-count-delta`, `rate-limit.changed`, and `ui.mutate-invoked`

### Layer 3: `domain/` — Business Logic

The thickest layer. Contains one subdirectory per domain concern.

| Subdirectory | Purpose |
|-------------|---------|
| `agents/` | Engine selections, favorites, model memory, execution environments (`agents/environments/`), subagent runners and credentials: what a run may be configured as. Starting one belongs to `runs/` |
| `runs/` | The run layer: `startRun` and the `AgentRun` ownership object, `RunRequest` selection/spec/prompt resolution and its shared builders (`builders.ts`), the backend-neutral `RunEvent` stream, and the `SessionEngines` pool |
| `sessions/` | Session lifecycle and records, the session hook pipeline (`onNew`, `onMessageEnd`, pre-close) with optional agent injection, team sessions, and the retention sweep |
| `executions/` | Execution registry access over `store/execution-repo.ts`, plus teardown and stop of live executions |
| `auth/` | Claude Code, PI and Codex credentials and login flows, auth status and expiry watching, and gateway sync after a login |
| `pi-providers/` | Custom PI providers: the model catalog entries and gateway routes behind `cortex auth provider` |
| `costs/` | Cost tracking, gateway management, usage collection, account readings and banked resets, rate limiting with per-provider awareness |
| `scheduling/` | Persisted schedule engine plus settings-backed built-in job controller. `Scheduler` hot-reloads user schedules and opens a new session for each fire; built-in jobs such as the memory-index rebuild own daemon timers |
| `waitpoints/` | Waitpoint service: arming, signal resolution, expiry, and the notices that wake a session (see [waitpoints.md](./waitpoints.md)) |
| `boards/` | Board service, paths and slugs, the file watcher that re-renders open boards, and the projection of decisions onto a board |
| `plugins/` | Plugin catalog, built-in and user plugin loading, skill projection, and plugin MCP servers |
| `projects/` | Project registry: scaffolding, scanning `context/projects/`, and project metadata |
| `memory/` | Memory/index management. `index-regen.ts` rebuilds the generated index.md files from YAML frontmatter and the access log (CLI: `cortex memory regen`). File watcher for context changes. AGENTS.md scanning and injection, and the rules loader |
| `hooks/` | Read-only view of the hook registry for the Web UI |
| `monitor/` | GPU and disk resource monitoring |
| `system/` | Host-level concerns: doctor checks, update state and prompts, system notices and their history, and `rebuild-hold.ts` — the supervisor-pushed "no new turns" state consulted by admission |
| `browser/` | The agent browser broker (`broker.ts`): one lease per session that binds it to its own tab in the server's or a device's Chrome, closes the tab after 10 idle minutes, and holds the user's takeover state (see [agent-browser.md](./agent-browser.md)) |
| `remote/` | Remote device management via WebSocket. SSH-based client bootstrap; clients self-update from server-pushed bundles |
| `mcp/` | The bundled Cortex MCP server and its tool modules (see [mcp.md](./mcp.md)) |
| `ui-service/` | The backend of the Web UI: the tRPC `AppRouter` (`app-router.ts`), its query and mutation handlers, and the event-bus subscription that streams live events to the UI (`subscribe.ts`) |
| `tui-session/` | Session handshake and switching for the TUI gateway |
| `benchmark/` | Production benchmark evidence: attempt identity and journals, and the export behind `cortex-evidence-export` |

### Layer 4: `orchestration/` — Message Routing and Execution

Connects platform messages to domain logic. The hook-bridge (part of this
layer) is detailed in [hooks.md](./hooks.md).

| File | Purpose |
|------|---------|
| `conduit-queue.ts` | Per-conduit serial Promise queue. Ensures only one turn runs per conversation at a time and lets `!cancel` discard a pending tail |
| `orchestrator.ts` | Hands each inbound message to `AgentRunner` |
| `agent-runner.ts` | Admission for the default-agent path: routing, mid-turn injection, queueing, and the session and lease resolution a turn needs. The turn body itself belongs to `turn/turn.ts` |
| `session-gateway.ts` | `deliverToSession()` — the one door into a conversation turn for everything that is not an inbound platform message (web sends, scheduled fires, agent results, resumes, waitpoint wakes) |
| `session-events.ts` | Publishes the `session.*` events the Web UI and TUI render: messages, deltas, status, turns, todos, context usage |
| `runtime.ts` | The `PlatformAdapter` + `EventBus` orchestration holds, injected once by the composition root |
| `conversation-request.ts` | `prepareConversationRequest()` — assembles a plain chat turn's `RunRequest`: agent spec plus the first-turn ambient blocks |
| `turn/turn.ts` | `Turn` / `openTurn()` — the single owner of one conversation turn: status message, ledger turn tracking, session lease, `startRun`, observer fan-out, terminal render, the `running:true/false` bracket |
| `turn/turn-prep.ts` | What a caller resolves before `openTurn`: the turn's files and its session record and use lease |
| `turn/terminal.ts` | A turn's terminal rendering: status seal, the ledger's turn completion, the error body, error-session persistence |
| `turn/turn-tracking.ts` | The ledger half of a turn's bookkeeping: begin, snapshot, accept, and the supersede-while-pending window |
| `turn/active-turns.ts` | Per-channel turn state: the streaming callback a turn registered, the edit-supersede flag |
| `turn/background-hold.ts` | One hold lifecycle for "the turn is over but the session is not": busy bracket, `SessionHolds` registration, run subscription, six terminal verdicts |
| `turn/hold-render-platform.ts` | The Slack/Feishu rendering of a held turn — the status line while the background phase runs, and its seal |
| `turn/hold-render-web.ts` | The web rendering of a held turn — the continuation's prose, tools and notices on the session event stream |
| `mid-turn-inject.ts`, `session-compact.ts`, `session-rewind.ts` | Steering a message into a running turn, compaction on request, and rewinding a conversation to an earlier turn |
| `subagent-*.ts`, `team-*.ts` | Delivery of background subagent results and of team worker reports into their parent or lead session |
| `waitpoint-*.ts` | Waitpoint signal ingress, the periodic sweep, draining spooled signals from connected devices, and wake notices |
| `session-retention-controller.ts` | Runs the session-retention sweep at startup, every 6 hours, and on a retention setting change |
| `resume-dispatcher.ts` | Rate-limit resume queue: continues the sessions a usage limit interrupted once the window resets |
| `busy-tracker.ts` | Tracks active LLM count, sends IPC `busy`/`idle` to parent daemon process |
| `human-answer-backstop.ts` | Leaf registry of channels waiting on a human's free-text reply, consulted by every entry into a session so the answer is consumed instead of opening a turn |
| `routing/message-router.ts` | Platform message entry point: registers the inbound message handler on the adapter and delegates to the orchestrator |
| `routing/commands/` | `!command` handlers, one module per family: `cancel`, `channel`, `compact`, `cost`, `device`, `lang`, `login` (with `login-custom`), `mode`, `nvtop`, `orient`, `restart`, `schedule`, `sendfile`, `session`, `status`, `tail`, `usage` (with `usage-reset`). `index.ts` maps the command words — `!agent`, `!backend`, `!model`, `!thinking`, `!new`, `!resume`, `!usage` and the rest — to them |
| `routing/webhook.ts` | The loopback webhook server (`WEBHOOK_PORT`, default 3001): hook callbacks, `cortex-signal`, `cortex-browser` leases (`browser-webhook.ts`), subagent, team and board callbacks |
| `routing/hook-bridge.ts` | PreToolUse hook → EventBus bridge. Publishes `plan.submitted` and `ask-user.requested` |
| `routing/hook-bridge-subscribers.ts` | Subscribers that turn a question or a submitted plan into an interaction record, which each surface renders as a card |
| `interactions/` | AskUserQuestion flow, plan approval state machine, button/modal action routing |

### Layer 5: `entry/` — Composition Root

| File | Purpose |
|------|---------|
| `app.ts` | **Composition root**. Loads `.env` and migrates legacy settings, then wires EventBus → event logger → hook bridge → RunRegistry/plan approvals/busy tracker → platform adapters → outbound queue → auth watch → scheduler → commands → interactions → message handler → Web UI host → platform connect → client manager → webhook → memory watcher |
| `shutdown.ts` | SIGTERM handling: an ordered list of shutdown steps, each run even when an earlier one fails, then exit |
| `daemon.ts` | Process supervisor. Forks `app.js`, watches `$CORTEX_REPO/src` for auto-rebuild (when `CORTEX_REPO` is set), watches `.restart` trigger file, crash recovery with exponential backoff (1s→30s max). Publishes per-step rebuild progress, waits for an idle app before install/restart, and holds new turns across that window (see below) |
| `daemon-notice.ts` | The app side of the downward IPC: turns `rebuild-aborted` into a system notice and `rebuild-hold` into the admission hold, and lifts the hold if the supervisor disconnects |
| `cortex-cli.ts`, `cli.ts` | `cortex` CLI entry point. Dispatches to `init`, `config`, `auth`, `doctor`, `feishu`, `restart`, `setup-gateway`, `ui`, `client`, `install`, `schedule`, `memory`, `start`, `daemon`, `tui`, each implemented in its own `*-cli.ts` module (see [cli-reference.md](./cli-reference.md)) |
| `browser-cli.ts`, `hook-cli.ts`, `signal-cli.ts`, `production-evidence-export-cli.ts` | The `cortex-browser`, `cortex-hook`, `cortex-signal` and `cortex-evidence-export` binaries |
| `init.ts` | Interactive first-time initialization |
| `start-ui-http.ts`, `ui-http-gate.ts`, `ui-service-wiring.ts` | Start the Web UI host when `CORTEX_UI_HTTP` is on, and wire the `UiService` it serves |
| `startup-helpers.ts` | Cleanup logs, ensure MCP config |
| `startup-notify.ts` | Send startup DM to admin channel |
| `platform-connect.ts` | Start the platform adapters. The TUI gateway is bound before boot continues; Slack and Feishu connect in the background, so boot never waits on a network handshake (outbound posts use their HTTP APIs, not the socket). A failed connect is retried after 5 s, 30 s and 2 min, then reported as an error notice; a platform still connecting after 60 s is reported as a warning |

### Hot Rebuild: Published Progress and the Turn Hold

With `CORTEX_REPO` set, a source change makes the supervisor rebuild the packages, reinstall itself,
and replace the app process. The build runs as three concurrent lanes. One is an ordered chain —
`server`, then `ui-contract`, then `web-typecheck` — because ui-contract re-exports the server's built
types and web typechecks against ui-contract's built output. The other two, `web-bundle` and
`web-depcruise`, read only web sources and start at once beside it. Every lane runs to its end, and
any failed step stops the rebuild before the install, with a notice naming each step that failed.
Two mechanisms make the rebuild visible and safe.

**Progress lives in a file, not in memory.** Before step one the pipeline writes its whole plan to
`$STORE_DIR/daemon-rebuild.json` — the steps this checkout will run (the build steps above, then
`install` and `restart`), which are in flight, and how each ended (`done`, `failed`,
`skipped`), with the `install` step recording whether it took the fast staged-rename path or
`npm pack` + `npm install -g`. A file is the only option: the pipeline's last act replaces the very
process that would have held that state, so nothing in memory can tell the new `app.js` what the
rebuild it was born from did. `system.daemonStatus` reads the record and the daemon page renders it,
polling once per second while a rebuild runs. A `running` record whose `daemonPid` is not the live
supervisor is dropped rather than shown forever; a terminal record is kept, so "the last rebuild
failed at `web-typecheck`" is still readable after the restart. The terminal statuses are `succeeded`,
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
| Claude Code | `claude/adapter.ts` | Stateless engine adapter: opens a Claude process session (print mode), spawn-args builder, event parser and translator |
| PI | `pi/adapter.ts` | Stateless engine adapter: opens an in-process PI session, MCP bridge, hook bridge, tool shims |

The session pool lives in `domain/runs/engines.ts` (`SessionEngines`), not in either adapter.

Each adapter translates its backend's events into the unified `NormalizedEvent` shapes (`normalize/`) and the `RunEvent` stream (`run-events.ts`). The `capabilities.ts` file declares a `Capability` enum with capability sets for Claude and PI. See [backends.md](./backends.md) for how runs, sessions and engines fit together.

## Platform Adapter

`platform/adapter.ts` defines the `PlatformAdapter` interface. Slack (`adapters/slack.ts`), Feishu (`adapters/feishu.ts`) and the TUI gateway (`adapters/tui/`) implement it, and `adapters/composite-adapter.ts` combines whichever are online into one adapter that routes each outbound call to the platform owning the conduit (`slack:`, `feishu:`, `tui-`). The Web UI does not go through this interface; it reads and drives sessions through `domain/ui-service/` (see [Web UI Protocol](#web-ui-protocol)).

| Member | Purpose |
|--------|---------|
| `name` / `capabilities` | Identity and what the platform supports |
| `start` / `stop` | Lifecycle |
| `onMessage` / `onMessageEdit` / `onAction` / `onModalSubmit` | Event registration |
| `postMessage` / `updateMessage` / `deleteMessage` | Outbound messaging |
| `postInteractive` | Interactive messages with buttons |
| `openModal` | Modals |
| `markQueued` / `unmarkQueued` | The queued marker on a message waiting behind a running turn |
| `uploadFile` / `downloadFile` | File operations |
| `openOutputStream` | A stream that renders an agent's output as it arrives |
| `bindProjectConduit` / `unbindProjectConduit` / `getProjectConduits` / `resolveInboundProject` | Project ↔ channel bindings |
| `ownsConduit` | Whether a conduit id belongs to this platform |
| `getPermalink` / `adminChannelKey` / `setAdminChannel` | Utility and the admin channel used for system notices |

`OutputStream` (`platform/output-stream.ts`, with Slack, Feishu and chunked implementations under `adapters/`) carries a turn's output to a chat platform: committed text, mutable regions such as the status line that later edits update in place, and interactive messages, split into chunks the platform accepts and queued so updates arrive in order.

## WebSocket Protocol (Server ↔ Client)

The WebSocket protocol is used for **remote device command execution**, not for chat or UI traffic. The server runs a WebSocket server (default port 3002, `CORTEX_CLIENT_PORT`) via `startClientManager()`. Every connection presents the client token in the `x-cortex-token` header. For the full cross-machine story — deployment, network topology, and security — see [cross-machine.md](./cross-machine.md).

### Message Flow

1. **Client connects** → sends `{ type: 'hello', device, platform, capabilities, gpuCount, bundleHash, pid? }`
2. **Server validates** → closes with `4001` when the device name is missing, `4005` when `machines.json` does not list it, and `4002` when that device is already connected
3. **Heartbeat** → client sends `{ type: 'heartbeat', device, timestamp }` every 5 seconds. Server closes a device silent for 15 seconds (code `4003`)
4. **Command dispatch** → server sends `{ type: 'command', commandId, action, params }`. Client executes and replies with `{ type: 'result', commandId, success, data, error }`
5. **Update** → when the `bundleHash` differs from the server's client bundle, the server sends `{ type: 'update', hash, files }`; the client installs it, answers `update-result`, and restarts on the new bundle
6. **Streams** → `open-stream` (a TCP port forward) and `open-file-stream` (a file transfer) ask the client to dial back a separate WebSocket for the bytes; a callback naming an unknown stream is closed with `4004`

### Command Actions

The client supports these remote actions: `bash` (shell execution with timeout/background), `read` (file read with text/image/PDF support), `write` (file write with CRLF detection), `edit` (text replacement with replace_all), `glob` (file glob with VCS exclusion), `grep` (ripgrep with pagination), `file.stat` (pre-transfer metadata probe).

### Client Architecture

The client (`client/src/client.ts`) is a lightweight WebSocket daemon that maintains a persistent connection. It supports automatic reconnection with exponential backoff (1s→30s max). It does not launch or supervise long-running jobs: those run independently and report back through a [waitpoint](./waitpoints.md).

## Web UI Protocol

The browser workbench, the desktop app and the mobile app all talk to the server through one HTTP host (`platform/ui-http/`), started when `CORTEX_UI_HTTP` is on. It listens on `127.0.0.1:3004` (`CORTEX_UI_PORT`); remote access goes through a tunnel or a LAN proxy (see [browser-access.md](./browser-access.md) and [desktop-app.md](./desktop-app.md)).

- **tRPC** under `/trpc/`. Queries and mutations are plain HTTP requests against the `AppRouter` in `domain/ui-service/app-router.ts`; the web app gets its types from `packages/ui-contract`.
- **Live events** use one `subscribe` subscription over Server-Sent Events. The client names the event types it wants, optionally scoped to a project or session, and the server forwards matching `CortexEvent`s from the bus through a bounded queue, sending `ui-subscribe.dropped` if the client falls behind. A subscriber to streamed text first receives a snapshot of the assistant message in progress.
- **Authentication**, checked in order: the `x-cortex-token` header carrying the client token (the desktop and mobile apps), a `cortex_ui` session cookie from token login (`/api/ui/login`, `/api/ui/logout`, `/api/ui/session`), or a Cloudflare Access JWT. Browser origins outside the same origin need an entry in the `uiCorsOrigins` setting.
- **Other routes**: file download and attachment upload (`/api/files/download`, `/api/attachments/upload`), board assets (`/api/boards/asset`), the web-bundle update the desktop app downloads (`/api/ui-ota/manifest.json`, `/api/ui-ota/bundle.zip`), the native app update manifest (`/api/app-update/manifest.json`), port forwarding to remote machines (`/api/forward/*`, with the `/forward` WebSocket), and the agent browser: its sessions, takeover and typed text (`/api/browser/*`) and the live view over the `/api/browser/stream` WebSocket.
- The same host serves the built web app, so a browser loads the UI and its API from one origin.

The TUI uses a separate WebSocket gateway on port 3003 (`CORTEX_TUI_PORT`), and hooks and signals reach the server through the loopback webhook on port 3001.

## Event Bus Topology

The EventBus is created in `app.ts`. `runRegistry`, `planApprovals` and `busyTracker` are constructed with no dependencies and wired with `setBus(bus)`; every other component receives the bus as an argument.

| Component | Publishes | Subscribes |
|-----------|-----------|------------|
| `runRegistry` | `agent.started/completed/failed/superseded` | — |
| `eventLogger` | `event-logger.dropped` | `'*'` (all events → JSONL) |
| `hookBridge` | `plan.submitted`, `ask-user.requested` | — |
| `routing/hook-bridge-subscribers.ts` | — | `plan.submitted`, `ask-user.requested` |
| `planApprovals` | `plan.approved` | — |
| `interactionHandlers` | `ask-user.answered` | — |
| `busyTracker` | `llm.active-count-delta` (pending background tasks) | `llm.active-count-delta`, counted to send IPC `busy`/`idle` |
| `orchestration/session-events.ts` | `session.*` | — |
| `domain/auth/` | `auth.required`, `auth.recovered` | `auth.*` (auth watch) |
| `domain/boards/` | `board.updated` | `board.updated` (board watcher) |
| `domain/system/system-notice.ts` | `system.notice` | — |
| `app.ts` | `config.changed`, `rate-limit.changed` | `session.status` (session holds) |
| `resume-dispatcher.ts` | — | `agent.completed/failed/superseded` |
| `team-delivery.ts`, `subagent-delivery.ts` | — | `session.turn.completed`, `session.status` |
| `domain/ui-service/` | `ui.mutate-invoked` | the event types each UI subscription asks for |

## State Storage

Cortex stores all state on the filesystem under `~/.cortex/`. There is no database — everything is JSON or JSONL on disk, with the session registry and history paths intentionally append-oriented. Paths below are relative to `~/.cortex/`; [configuration.md](./configuration.md#file-hierarchy) lists the whole tree.

| Path | Purpose |
|------|---------|
| `data/agent-state.json` | Channel selections, model memory, new-session choice, and default agent |
| `config/models.json` | Default engine selection and favorite models |
| `config/budget.json` | Daily and monthly budget limits |
| `config/environments/` | Execution environments — one JSON file per environment |
| `data/schedules.json` | Persistent schedule list |
| `data/boards.json` | Board registry: each board's project, slug, title, creation time and last use (created, attached to by a session, or its files changed). The page itself lives in the project context under `boards/<slug>/` |
| `data/session-registry.jsonl` | Append-only JSONL journal and single owner of session records, channel→session bindings, and per-channel conversation headers and turns. Events: `put`/`patch`/`delete-intent`/`delete-commit`/`bind`/`unbind`/`turn`/`conversation`; startup replays the stream to rebuild live and pending state. Compaction keeps live records + bindings + live turns; it runs once the journal holds more than `max(512, live×4, 2×compacted)` events — where `compacted` is the number of events a compaction would write — or exceeds both 16 MB and twice its size after the last compaction. A one-time upgrade migration imports the retired `sessions.json` and `conversation-ledger.json` and renames them to `*.pre-2026.9.14.bak` |
| `data/retention-candidates.json` | Two-sweep orphan retention candidates for history and PI cleanup |
| `data/conversation-history/` | Per-session transcript/history JSONL keyed by stable Cortex session id |
| `data/executions.json` | Unified execution registry |
| `data/archive/` | Terminal execution records older than a week, moved out of `executions.json` |
| `data/provider-state.json` | Provider usage, throttle windows, and the provider-attributed resume queue |
| `data/waitpoints.json` | Waitpoints and their signals |
| `data/team-inbox.json`, `data/team-outbox.json` | Messages between team leads and workers |
| `data/ui-sessions.json` | Browser login sessions for the Web UI |
| `browser/profile/` | Profile of the server's agent browser: its cookies and logins |
| `data/daemon-rebuild.json` | The supervisor's published hot-rebuild record: plan, per-step status and timings, and the terminal outcome of the last rebuild |
| `data/costs.jsonl` | Per-call cost records (90-day rolling) |
| `logs/sessions/` | Claude capture logs used for retention protection/cleanup |
| `logs/sessions-pi/` | PI transcript bundles keyed by backend session id |
| `logs/` | Daemon and backend logs, and the daily event log under `logs/events/` |

The session registry is an append-only journal rather than a mutable JSON file. `session-registry-journal.ts` owns an append-only JSONL file whose events carry the full session record for `put` and `delete-intent`, plus a final `delete-commit`. A delete intent also freezes the validated Claude turn-backup cleanup manifest, so a later retry does not depend on a ledger that an earlier partial cleanup already removed. Startup first migrates any legacy `session-registry.json` file into the journal, writes a backup of that legacy file, truncates any unterminated tail, and then stream-replays the journal line by line into in-memory `live` and `pending` maps. When the journal grows too large, compaction rewrites a minimal snapshot consisting of one full-record event per live session plus one `delete-intent` event per pending deletion.

Session retention is coordinated separately from registry mutation. `session-retention-controller.ts` starts a `session-retention.ts` sweep in the background at app startup — boot does not wait for it, and the session registry's own lock serializes it against other session mutations — then runs it every 6 hours, with an immediate debounced rerun when `sessionRetentionDays` hot-reloads. The startup sweep begins after any ready provider-resume dispatch, and queued direct resumes retain their stable tracking id as a liveness guard. The coordinator retries pending delete commits, writes registry delete intents for all expired idle sessions in one append, then works through them in batches of 100 — one append each releases their channel bindings and their conversations, their files are deleted, and one append commits the sessions whose cleanup succeeded. Stopping the controller aborts the sweep between batches, leaving uncommitted deletions pending for the next sweep. It also prunes orphan `conversation-history`, prunes orphan PI transcript bundles, prunes inactive Claude capture logs, prunes orphan `tmp/tool-images/` session directories, and syncs Claude user `cleanupPeriodDays`.

## Naming Conventions

- **Execution IDs**: `exec_<kind>_<base36-ts>_<4-rand>` (e.g., `exec_local_1a2b3c_xyzw`)
- **Schedule IDs**: 8 hex characters (from `randomBytes(4)`)
- **Session IDs**: UUIDs identify sessions in the registry and UI. Unlabeled sessions display the first 8 characters of the UUID. `/resume` accepts a full UUID or a unique prefix of at least 6 characters.
- **Board IDs**: 8 hex characters (from `randomBytes(4)`). A board's directory is a slug of its title, with a numeric suffix when the slug is taken, or `board-<id>` when the title has no slug-safe characters.
- **Waitpoint IDs**: `wp_` followed by 12 hex characters (from `randomBytes(6)`); each waitpoint also carries its own secret for `cortex-signal`.
- **File format**: All TypeScript uses `.ts` with ESM import style (`import { X } from './foo.js'`)
