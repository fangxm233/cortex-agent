Please update me when files in this folder change

Claude backend adapter for print and interactive Cortex turns.
Translates Claude stream and transcript events into the normalized event schema.

| filename | role | function |
|---|---|---|
| adapter.ts | adapter | emits cache-inclusive prompt accounting |
| adapter-tui.ts | adapter | runs declared Claude TUI sessions under tmux |
| spawn-args.ts | core | Builds isolated Claude args and environment |
| mcp-config.ts | core | Writes private supplemental MCP configs |
| defaults.ts | config | Claude timeout, MCP composition and tool constants |
| hooks-builder.ts | core | selects and compiles Claude hooks from settings |
| event-parser.ts | parser | tracks Claude stream blocks and reported models |
| jsonl-tail.ts | core | normalizes transcript events and cache reads |
| tmux-control.ts | util | Runs tmux with secure paste buffers and launchers |
| bg-task-tracker.ts | core | tracks background tasks and continuations |
| context-usage.ts | core | tracks context window usage per session |
| compact-window.ts | config | resolves the configured auto-compact window |
| cost-from-usage.ts | util | derives call cost from token counts |
| tool-summarizers.ts | util | renders tool inputs for trace display |
