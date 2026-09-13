Please update me when files in this folder change

Claude backend adapter for print-mode Cortex turns.
Translates Claude stream and transcript events into the normalized event schema.

| filename | role | function |
|---|---|---|
| adapter.ts | adapter | Stateless Claude EngineAdapter: session open, spec identity, resume target, process transport |
| engine.ts | engine | Claude EngineSession: RunEvent runs, steer acks, run-scoped cancel over one ClaudeSession |
| turn-machine.ts | core | drives one Claude turn: line handling, accounting, continuation and injection |
| transcript-path.ts | util | resolves the Claude jsonl transcript path and the --resume-vs-create decision |
| spawn-args.ts | core | Builds Claude args and bundled MCP selection, swapping native Agent for the MCP one, plus the sidecar's PI model catalog env |
| mcp-config.ts | core | Writes private MCP and proxy configs |
| browser-mcp.ts | core | Writes the Playwright MCP config bound to a session's browser |
| remote-mcp-proxy.ts | core | Proxies remote MCP without redirects |
| defaults.ts | config | Claude timeout, config paths, tool constants and always-stripped natives |
| hooks-builder.ts | core | selects and compiles Claude hooks from settings |
| event-parser.ts | parser | parses stream blocks, results and model fallbacks |
| event-translator.ts | translator | turns Claude turn callbacks and results into normalized events |
| tmux-control.ts | util | Runs tmux for the startup migration sweep of pre-D9 orphan sessions |
| bg-task-tracker.ts | core | tracks background tasks and routes continuation vs orphan-subagent lines |
| context-usage.ts | core | tracks context window usage per session |
| compact-window.ts | config | resolves the configured auto-compact window |
| tool-summarizers.ts | util | renders tool inputs for trace display |
