Please update me when files in this folder change

Agent abstraction layer: decouples Cortex core from the three backend CLIs: Claude Code / Codex / PI.
Unified NormalizedEvent event schema and AgentAdapter contract.

| filename | role | function |
|---|---|---|
| `index.ts` | entry | getAdapter(backend) dispatch + centralized symbol export |
| `types.ts` | contract | AgentAdapter/AgentProcess/SpawnConfig types + `ContinuationSink` (assistant text plus id-correlated full tool use/results across spontaneous turns) (spontaneous background-task turns) + backend-neutral `InjectionAckSink` (`onDelivered` consumption edge + optional `onUndelivered` seal; `foldedIntoTurn` says whether the tracked run carries the reply) + optional `AgentProcess.injectUserMessage` / `setInjectionAckSink` |
| `capabilities.ts` | capabilities | Capability enum + per-backend capability set (`StreamingDeltas` = Claude + PI; `MidTurnInject` = Claude print-mode stdin + PI RPC prompt steering) |
| `normalize/event-types.ts` | event types | NormalizedEvent discriminated union, including backend-neutral `context_usage` snapshots and `assistant_delta` streaming blocks |
| `normalize/event-stream.ts` | queue | createEventStream single-producer FIFO |
| `normalize/tool-names.ts` | tool name table | canonical ↔ backend-native bidirectional mapping |
| `normalize/hooks.ts` | hook contract | NormalizedHookSpec + trigger types |
| `bg-wait.ts` | bg wait | thread-session INLINE background-task wait; forwards assistant text plus complete id-correlated tool use/results (waitForBgContinuation merges the spontaneous continuation into the step result; shouldAwaitBgInline gates on threadId+claude+sink+remaining) + shared env gates (isBgContinuationEnabled / getBgGraceMs / getBgMaxWaitMs — single source, re-exported by orchestration bg-continuation/bg-wait-guard) |
| `claude/adapter.ts` | adapter | ClaudeAdapter + session pool + runClaude; print mode preserves native tool-use ids and complete tool-result carriers as normalized events + `resolveResumeForPrint` (gates print-mode `--resume` on the transcript existing — fixes the cortex-tui fresh-session "No conversation found" error) + `killSession(channel)` (module-level hard stop, SIGTERM now — the counterpart of the graceful `closeSession`; used by the Stop path to end background tasks still living in a pooled session whose foreground turn already finished) + **mid-turn injection** (`injectUserMessage` writes the same NDJSON user line a turn writes but registers NO turn, so the already-awaited turn promise covers it and no second result is fabricated; returns false with no live process / no active turn so the caller falls back to the conduit queue). Landing is a race the caller cannot control, so both landing outcomes are wired: a tool-result boundary folds the message into the running turn (ONE result), while a mid-text-generation landing makes the CLI start a turn of its own AFTER this turn's result — the `--replay-user-messages` echo (`handleReplayEcho`, the ONLY consumer of replay events) acks delivery and, when it fires with no turn in flight, arms `openContinuationTurn` so that spontaneous reply reaches `continuationSink` instead of being dropped. Pending injections also hold the idle timer open and seal the sink on process death |
| `claude/defaults.ts` | constants | timeout/MCP/tools/hooks constants |
| `claude/hooks-builder.ts` | builder | buildHooksSettings generates hook configuration |
| `claude/tool-summarizers.ts` | summarizer | summarizeToolInput tool input rendering |
| `claude/spawn-args.ts` | args | buildSpawnArgs constructs CLI args (profile `thinking` → `--effort`; print mode also passes `--include-partial-messages` for token-level `stream_event` output, killable with `CORTEX_STREAM_DELTAS=0` via the exported `isStreamDeltasEnabled`, and `--replay-user-messages`, whose echo is the mid-turn injection delivery ack — it fires when the CLI CONSUMES a message, not when it was written) |
| `claude/event-parser.ts` | parser | stream-json event parsing + plan tracking + token-level delta extraction (`createStreamDeltaState` / `parseStreamEvent` / `takeTextBlockId`). The CLI sends one complete `assistant` event PER content block, so that block's array position is always 0 and cannot recover the streamed `content_block_index` — `takeTextBlockId` hands the open text block's id to the finalizing message instead, which is what lets the UI replace a preview in place. `formatUserEvent` guards on an array `content` — replay echoes arrive as bare strings |
| `claude/bg-task-tracker.ts` | tracker | background-task (run_in_background) running/undelivered dual-set tracking (task_updated terminal statuses count as work-done because CC may never send task_notification — old-CLI same-turn completions / killed tasks) + spontaneous continuation-turn detection (BgTaskTracker / routeLine / isContinuationResult) |
| `claude/tmux-control.ts` | utility | tmux CLI wrapper (DR-0012 Phase 1, TUI mode foundation) |
| `claude/jsonl-tail.ts` | utility | session jsonl file tail + NormalizedEvent translation (DR-0012 Phase 1) |
| `claude/cost-from-usage.ts` | pricing | reverse-derive USD cost from message.usage tokens (DR-0012 Phase 1) |
| `claude/adapter-tui.ts` | adapter | ClaudeTuiSession — interactive Claude under tmux + jsonl tail (DR-0012 Phase 2) |
| `codex/adapter.ts` | adapter | CodexAdapter + RouteRuntime pool |
| `codex/event-parser.ts` | parser | codexEventToNormalized translation |
| `pi/agent-dir.ts` | config | PI agent directory constants (data/pi/models.json + logs/sessions-pi/) + multi-provider models.json writer (writeProvidersConfig; re-asserts gateway-lost PI compat via PROVIDER_COMPAT_OVERRIDES, e.g. deepseek supportsDeveloperRole=false) + auth.json symlink/copy mirror (ensureAuthVisible) |
| `pi/adapter.ts` | adapter | PIAdapter + PISession + switch_session + **mid-turn steering**. `message_update`/`message_end` drive throttled live `get_session_stats` snapshots without flushing partial text; `agent_settled` still gates terminal on an independent final snapshot. Steering, turn/cost aggregation, env/tool gates, resume guards, and previews remain supported |
| `pi/discovery.ts` | helper | Provider discovery (`pi --list-models` without Cortex's private agent-dir override) + bounded session-file existence check (filename fast path, JSONL header fallback) |
| `pi/session-support.ts` | helper | PI session primitives: timers, prompt assembly, event queue, process/turn types, safe RPC parse, FIFO steering, and `PIContextUsageProbe` (2s live throttle/single-flight + independent final correlation/timeout) |
| `pi/defaults.ts` | defaults | PI session directory and compiled extension paths used by process spawning |
| `pi/event-parser.ts` | parser | piRpcLineToNormalized translation; validates `get_session_stats.contextUsage` as an estimate, aggregates `agent_end`, and emits terminal completion only at `agent_settled`; text deltas carry stable block ids |
| `pi/framing.ts` | framing | LF-only NDJSON encoding and splitter |
| `pi/spawn-args.ts` | args | `buildSpawnArgs` constructs PI CLI args; `buildPiEnv` clears stale context and injects authoritative thread/task/session identity |
| `pi/mcp-bridge.ts` | extension | Bridge PI to Cortex MCP server |
| `pi/hook-bridge.ts` | extension | Bridge PI tool events to hooks/*.mjs |
| `pi/tool-shims.ts` | extension | ask/exit_plan/todo pseudo tool registration, gated by agent tool allowlist (makeToolGate + CORTEX_PI_ALLOWED_TOOLS) so thread agents don't get interaction tools |
| `pi/pi-ext-types.ts` | types | Minimal TS type stub for PI SDK |
