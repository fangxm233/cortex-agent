Please update me when files in this folder change

Agent abstraction layer: decouples Cortex core from the three backend CLIs: Claude Code / Codex / PI.
Unified NormalizedEvent event schema and AgentAdapter contract.

| filename | role | function |
|---|---|---|
| `index.ts` | entry | getAdapter(backend) dispatch + centralized symbol export |
| `types.ts` | contract | Adapter/process contracts plus manual compact results and sinks |
| `capabilities.ts` | capabilities | Capability enum + per-backend capability set (`StreamingDeltas` = Claude + PI; `MidTurnInject` = Claude print-mode stdin + PI RPC prompt steering) |
| `normalize/event-types.ts` | event types | NormalizedEvent discriminated union, including backend-neutral `context_usage` snapshots and `assistant_delta` streaming blocks |
| `normalize/event-stream.ts` | queue | createEventStream single-producer FIFO |
| `normalize/tool-names.ts` | tool name table | canonical ↔ backend-native bidirectional mapping |
| `normalize/hooks.ts` | hook contract | NormalizedHookSpec + trigger types |
| `bg-wait.ts` | bg wait | Inline continuation wait forwarding text, tools, and context |
| `claude/adapter.ts` | adapter | Claude print turns, exact `/compact`, injection, and continuations |
| `claude/context-usage.ts` | tracker | Tracks provider-call usage and reconciles model context windows |
| `claude/defaults.ts` | constants | timeout/MCP/tools/hooks constants |
| `claude/hooks-builder.ts` | builder | Generates Claude hooks, including CORTEX Read/Edit injection |
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
| `pi/adapter.ts` | adapter | PI sessions, correlated manual compact/stats, switching, steering, and turns |
| `pi/discovery.ts` | helper | Provider discovery (`pi --list-models` without Cortex's private agent-dir override) + bounded session-file existence check (filename fast path, JSONL header fallback) |
| `pi/session-support.ts` | helper | PI session primitives: timers, prompt assembly, event queue, process/turn types, safe RPC parse, FIFO steering, and `PIContextUsageProbe` (2s live throttle/single-flight + independent final correlation/timeout) |
| `pi/defaults.ts` | defaults | PI session directory and compiled extension paths used by process spawning |
| `pi/event-parser.ts` | parser | PI event translation and shared context-stats payload validation |
| `pi/framing.ts` | framing | LF-only NDJSON encoding and splitter |
| `pi/spawn-args.ts` | args | `buildSpawnArgs` constructs PI CLI args; `buildPiEnv` clears stale context and injects authoritative thread/task/session identity |
| `pi/mcp-bridge.ts` | extension | Bridge PI to Cortex MCP server |
| `pi/hook-bridge.ts` | extension | Bridges PI tool events and CORTEX Read/Edit context |
| `pi/tool-shims.ts` | extension | gated ask/enter/exit/todo pseudo-tools |
| `pi/pi-ext-types.ts` | types | Minimal TS type stub for PI SDK |
