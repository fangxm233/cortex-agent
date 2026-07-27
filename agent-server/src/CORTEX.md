Please update me when files in this folder change

agent-server's TypeScript ESM runtime source, organized by six-layer structure (S12, plan/agent-server-decouple.md §2).

| Layer | Directory | Function |
|---|---|---|
| L0 | `core/` | Zero dependency: types, path constants, async-mutex, json-repository, atomic-write, CLI utilities |
| L1 | `store/` | Persistence: 11 JsonRepository implementations |
| L2 | `events/` | Event bus: EventBus + daily rolling jsonl + debug replay CLI |
| L3 | `domain/` | Domain services: agents/sessions/tasks/executions/costs/scheduling/system/memory/monitor/remote/mcp/threads |
| L4 | `orchestration/` | Orchestration layer: orchestrator/agent-runner/thread-executor/busy-tracker + routing/ + interactions/ |
| L5 | `entry/` | Entry points: app.ts / daemon.ts / startup-helpers / startup-notify |

### L0: core/
`async-mutex.ts` `atomic-write.ts` `json-repository.ts` `paths.ts` `version.ts` `cli-utils.ts` `utils.ts` `status-format.ts` `running-executions.ts` `task-parser.ts` `debug-mode.ts` (single truthy `DEBUG` gate shared by logging, lossless transcript capture, and DTO exposure) `singleton-lock.ts` (PID-file singleton lock shared by daemon.ts/app.ts) `auth.ts` (shared-secret auth: `ensureAuthTokens`/`getClientToken`/`getWebhookToken`/`timingSafeEqualStr`/`AUTH_HEADER` for the WS client + webhook bearer gates; no Cloudflare dependency) `i18n.ts` (zero-dep localization: `t()`/`setLocale`/`getLocale`/`detectSystemLocale`; locale set by entry/app.ts, never reads domain) `locales/` (`en.ts`/`zh.ts` barrels aggregating per-cluster `slices/*`; zh typed `Record<MessageKey,string>` for compile-time parity) `types/agent-types.ts` `types/thread-types.ts`

### L1: store/
`in-memory-repository.ts` + 11 repos: `thread-repo` `session-repo` `conversation-ledger-repo` `session-registry-repo` `execution-repo` `project-dir-repo` `schedule-repo` `cost-repo` `profile-repo` `task-repo` + `outbound-queue` (WAL)
Project→conduit mapping (formerly `channel-repo.ts`) has moved into `platform/adapters/slack-project-conduits.ts` — owned by the Slack adapter, since project-report rendering is adapter-specific.

### L2: events/
`event-bus.ts` `event-types.ts` (`config.changed` drives UI config snapshot refresh) `event-logger.ts` `event-replay.ts` `index.ts`

### L3: domain/
| Subdirectory | Files |
|---|---|
| `agents/` | `config.ts` `facade.ts` `profile-manager.ts` `index.ts` |
| `sessions/` | `session.ts` `session-registry.ts` `session-backup.ts` `session-hooks.ts` (unified onNew/onMessageEnd hook pipeline — spawn + OutputStream display + optional agent injection) |
| `tasks/` | `parser.ts` `lint.ts` `archiver.ts` `dispatcher.ts` `dispatch-utils.ts` `pending-tracker.ts` `claim-recovery.ts` `store.ts` `recommendation/` `system/` |
| `executions/` | `registry.ts` |
| `costs/` | `cost-tracker.ts` `gateway-manager.ts` `rate-limit-parser.ts` `rate-limit-throttle.ts` `resume-registry.ts` (records sessions/threads interrupted by a rate limit, for auto-resume) `codex-usage-monitor.ts` `codex-event-format.ts` |
| `scheduling/` | `scheduler.ts` `runner.ts` `job-registry.ts` `schedule-command.ts` `schedule-cli.ts` `jobs/` (includes `target-dispatch.ts` 4-way fresh/channel/session/thread decision) |
| `memory/` | `index-regen.ts` `consolidate.ts` `watcher.ts` `skill-scanner.ts` `claude-md-scanner.ts` `claude-md-injector.ts` `user-context.ts` (USER.md → plain-conversation injection) |
| `monitor/` | `gpu-monitor.ts` `disk-monitor.ts` |
| `remote/` | `client-manager.ts` `client-bootstrap.ts` `client-hot-reload.ts` `cortex-client.ts` |
| `system/` | `update-state.ts` (DR-0013 update-state I/O) `preferences.ts` (config/preferences.json — operator UI language `loadLang`/`setLang`) |
| `threads/` | `index.ts` `utils.ts` `artifact-io.ts` `template-loader.ts` `prompt-builder.ts` `state-machine.ts` `runner.ts` `hook-runner.ts` `auto-thread.ts` `template-resolver.ts` |
| `mcp/` | `server.ts` (ext) + `core-server.ts` (core) + `slack-server.ts` (cortex-slack, `slack:` sessions) + `feishu-server.ts` (cortex-feishu, `feishu:` sessions) + `web-server.ts` (cortex-web, `web:` sessions — `send_file` tool, 20a) + `tools/slack.ts` `ui-file.ts` (send_file → `/webhook/ui-file`) `cost.ts` `executions.ts` `task-ops.ts` `context.ts` `schedule.ts` `thread-ops.ts` `task-monitor.ts` `time.ts` `manager-qa.ts` |

### L4: orchestration/
| Path | Function |
|---|---|
| `running-executions.ts` | Unified live-execution registry, keyed by executionId (byKey/byThreadId/byChannel) + agent.* event publishing |
| `bg-held-sessions.ts` | (core/) Web bg-hold registry — mirrors `session.status` backgroundRunning deltas so sessions.list can serve the Background state as a snapshot, indexes each hold by channel, and carries its abort handle so the channel-keyed Stop path can reach a session that has already left running-executions |
| `conduit-queue.ts` | Per-conduit serial Promise queue |
| `superseded-edits.ts` | Message edit supersede marker |
| `busy-tracker.ts` | activeLlmCount + IPC busy/idle (S13: subscriber-as-source-of-truth) |
| `orchestrator.ts` | Two-branch decision tree (thread-match / default) |
| `agent-file-send.ts` | `sendAgentFile` (20a): copy an agent-produced file into `workspace/outputs/<sessionId>/`, append it as an assistant message carrying file attachments (persisted for `sessions.transcript`) + publish a shared-ts `session.message`. Invoked by the `/webhook/ui-file` route on behalf of the web-only `send_file` MCP tool |
| `agent-runner.ts` | runAgent + lifecycle wrapper |
| `thread-executor.ts` | Thread routing wrapper |
| `lifecycle.ts` | Agent success/failure/recovery/retry |
| `resume-dispatcher.ts` | rate-limit auto-resume: drains resume-registry on throttle clear (or on startup if orphans remain with no active throttle), re-enters interrupted direct sessions (agentRunner.route, serial per channel) / threads (resumeRateLimitedThread, fired concurrently — channel-parallel-safe, only skipped when a live direct session holds the channel; each detached thread resume holds the daemon busy gate via track ±1 across run+settle so a pending .restart cannot fire mid-resume, 2026-07-09 fix) |
| `dispatch-reconciler.ts` | stale dispatch cleanup timer (S13: extracted from app.ts) |
| `routing/message-router.ts` | Slack message entry thin layer |
| `routing/webhook.ts` | GitHub/task-op/hook webhook |
| `routing/hook-bridge.ts` | PreToolUse interaction events including PI plan paths |
| `routing/hook-bridge-subscribers.ts` | ask-user.requested / plan.submitted subscribers (S13: extracted from app.ts) |
| `routing/edit-handler.ts` | Slack message edit orchestration |
| `routing/file-handler.ts` | Slack file download and classification |
| `routing/commands/` | 14 !command handlers |
| `interactions/` | ask-user-question / plan-handler / plan-approvals / interaction-handlers |
| `status-helpers.ts` | execution / status-message / streaming-VM helpers (pure subset has been sunk to `core/status-format.ts`) |

### L5: entry/
`app.ts` (composition root; publishes `config.changed` after valid profile reloads and wires Web plan responses through shared delivery; the Web UI transport-host is loaded on demand via `entry/ui-http-gate.ts`, whose CORTEX_UI_HTTP-gated dynamic `import('./start-ui-http.js')` is the sole runtime edge to @trpc/server+jose — so core stays @trpc-free when the flag is off) `daemon.ts` `start-ui-http.ts` (Web UI wiring: binds domain/ui-service AppRouter → platform/ui-http host; also mounts the `/api/attachments/upload` (15a) + `/api/files/download` (15a/20a file cards, traversal-guarded to WORKSPACE_DIR) custom routes) `ui-http-gate.ts` (the lazy CORTEX_UI_HTTP seam) `startup-helpers.ts` `startup-notify.ts`

The Web UI transport (tRPC AppRouter binding + HTTP/SSE host + same-origin SPA serving) lives
**in-core**, split by layer: `domain/ui-service/{trpc,app-router}.ts` (the tRPC contract bound over
the ui-service facade), `platform/ui-http/{ui-http-server,access-jwt}.ts` (the HTTP/SSE host +
Cloudflare Access JWT verification — core+external only), and `entry/{start-ui-http,ui-http-gate}.ts`
(the wiring that binds them + the lazy CORTEX_UI_HTTP gate). `@trpc/server` + `jose` are ordinary
core dependencies, but they are **runtime-lazy**: `app.ts` loads the transport only through the
gate's dynamic import, so an unset `CORTEX_UI_HTTP` keeps both out of the module graph (guarded by
`tests/platform/ui-http-lazy-load.test.ts`). CORS resolves from `CORTEX_UI_CORS_ORIGINS`; the SPA is
served from `CORTEX_UI_SPA_DIR`, else the package-root `web/dist` (staged on publish via prepack),
else the monorepo `web/dist`. `@cortex-agent/ui-contract` re-exports the `AppRouter` type from
`domain/ui-service/app-router.ts` for the browser client.
(Reversal of the Stage-9 §9.1 package split — `@cortex-agent/ui-server` was merged back per plan §11.)

### Other static directories
| Directory | Contents |
|---|---|
| `agent-adapter/` | Claude/Codex/PI three-backend abstraction layer (unchanged) |
| `platform/` | Platform abstraction layer Slack/Feishu (unchanged) + `tool-trace.ts` (UI helper for OutputStream tool traces) |
| `tui/` | Ink TUI client (M5) — chat-only terminal client speaking M4 protocol (ws-client, hooks, components, render utilities) |
| `hooks/` | Thread lifecycle hook scripts (unchanged) |
