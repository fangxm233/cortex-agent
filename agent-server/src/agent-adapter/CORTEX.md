Please update me when files in this folder change

Agent abstraction layer: decouples Cortex core from the three backend CLIs: Claude Code / Codex / PI.
Unified NormalizedEvent event schema and AgentAdapter contract.

| filename | role | function |
|---|---|---|
| `index.ts` | entry | getAdapter(backend) dispatch + centralized symbol export |
| `types.ts` | contract | AgentAdapter/AgentProcess/SpawnConfig types + `ContinuationSink` (spontaneous background-task turns) + `InjectionAckSink` (mid-turn injection delivery ack; `foldedIntoTurn` discriminates the two landing outcomes) + the optional `AgentProcess.injectUserMessage` / `setInjectionAckSink` pair |
| `capabilities.ts` | capabilities | Capability enum + per-backend capability set (`StreamingDeltas` = claude + pi — the backend republishes token-level assistant text as `assistant_delta`; `MidTurnInject` = claude only — print-mode stdin accepts a user message while a turn is in flight) |
| `normalize/event-types.ts` | event types | NormalizedEvent discriminated union (incl. `assistant_delta` — an incremental text chunk of a block still being generated, grouped by `blockId` and superseded by the `assistant_text` carrying the same id) |
| `normalize/event-stream.ts` | queue | createEventStream single-producer FIFO |
| `normalize/tool-names.ts` | tool name table | canonical ↔ backend-native bidirectional mapping |
| `normalize/hooks.ts` | hook contract | NormalizedHookSpec + trigger types |
| `bg-wait.ts` | bg wait | thread-session INLINE background-task wait (waitForBgContinuation merges the spontaneous continuation into the step result; shouldAwaitBgInline gates on threadId+claude+sink+remaining) + shared env gates (isBgContinuationEnabled / getBgGraceMs / getBgMaxWaitMs — single source, re-exported by orchestration bg-continuation/bg-wait-guard) |
| `claude/adapter.ts` | adapter | ClaudeAdapter + session pool + runClaude + `resolveResumeForPrint` (gates print-mode `--resume` on the transcript existing — fixes the cortex-tui fresh-session "No conversation found" error) + `killSession(channel)` (module-level hard stop, SIGTERM now — the counterpart of the graceful `closeSession`; used by the Stop path to end background tasks still living in a pooled session whose foreground turn already finished) + **mid-turn injection** (`injectUserMessage` writes the same NDJSON user line a turn writes but registers NO turn, so the already-awaited turn promise covers it and no second result is fabricated; returns false with no live process / no active turn so the caller falls back to the conduit queue). Landing is a race the caller cannot control, so both landing outcomes are wired: a tool-result boundary folds the message into the running turn (ONE result), while a mid-text-generation landing makes the CLI start a turn of its own AFTER this turn's result — the `--replay-user-messages` echo (`handleReplayEcho`, the ONLY consumer of replay events) acks delivery and, when it fires with no turn in flight, arms `openContinuationTurn` so that spontaneous reply reaches `continuationSink` instead of being dropped. Pending injections also hold the idle timer open and seal the sink on process death |
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
| `pi/adapter.ts` | adapter | PIAdapter + PISession + switch_session; forwards agent tool allowlist to subprocess via CORTEX_PI_ALLOWED_TOOLS env (from rawTools/canonical tools). Resume guard (`piSessionFileExists` + sessionPathRegistry): `--session <id>` is passed only when the id is KNOWN (bootstrapped this instance or a matching file on disk) — PI can only resume an existing session, not create one under an external id (unlike Claude's `--session-id`), so an unknown id starts fresh instead of exiting "No session found matching <id>". Streaming preview: each incoming text delta is re-emitted as an `assistant_delta` (incremental chunk + blockId) while still being buffered into the authoritative whole-message `assistant_text` that carries the same blockId; suppressed by `CORTEX_STREAM_DELTAS=0`, read once at spawn time |
| `pi/event-parser.ts` | parser | piRpcLineToNormalized translation; text deltas carry a `blockId` derived from `message.id ?? message.responseId` (real PI AssistantMessage has no `id` — `responseId` is the provider's per-message identifier, fixed before the first delta) |
| `pi/framing.ts` | framing | LF-only NDJSON encoding and splitter |
| `pi/spawn-args.ts` | args | buildSpawnArgs constructs pi CLI args (profile `thinking` → `--thinking`) |
| `pi/mcp-bridge.ts` | extension | Bridge PI to Cortex MCP server |
| `pi/hook-bridge.ts` | extension | Bridge PI tool events to hooks/*.mjs |
| `pi/tool-shims.ts` | extension | ask/exit_plan/todo pseudo tool registration, gated by agent tool allowlist (makeToolGate + CORTEX_PI_ALLOWED_TOOLS) so thread agents don't get interaction tools |
| `pi/pi-ext-types.ts` | types | Minimal TS type stub for PI SDK |
