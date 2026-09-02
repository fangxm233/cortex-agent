Please update me when files in this folder change

Claude backend adapter for print and interactive Cortex turns.
Translates Claude stream and transcript events into the normalized event schema.

| filename | role | function |
|---|---|---|
| adapter.ts | adapter | pools sessions and injects MCP composition |
| adapter-tui.ts | adapter | runs TUI sessions with bundled MCP scopes |
| spawn-args.ts | core | Builds Claude args and bundled MCP selection |
| mcp-config.ts | core | Writes private MCP and proxy configs |
| browser-mcp.ts | core | Writes the Playwright MCP config bound to a session's browser |
| remote-mcp-proxy.ts | core | Proxies remote MCP without redirects |
| defaults.ts | config | Claude timeout, config paths and tool constants |
| hooks-builder.ts | core | selects and compiles Claude hooks from settings |
| event-parser.ts | parser | parses stream blocks, results and model fallbacks |
| jsonl-tail.ts | core | normalizes transcript, plans and accounting |
| subagent-jsonl-mux.ts | core | multiplexes attributed TUI subagent sidecars |
| tmux-control.ts | util | Runs tmux with secure paste buffers and launchers |
| bg-task-tracker.ts | core | tracks background tasks and continuations |
| context-usage.ts | core | tracks context window usage per session |
| compact-window.ts | config | resolves the configured auto-compact window |
| cost-from-usage.ts | util | derives call cost from token counts |
| tool-summarizers.ts | util | renders tool inputs for trace display |
