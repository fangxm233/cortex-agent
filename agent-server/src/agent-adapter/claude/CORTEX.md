Please update me when files in this folder change

Claude Code backend adapter: runs Cortex turns through the Claude CLI in print or interactive mode.
Translates Claude stream and transcript events into the normalized event schema.

| filename | role | function |
|---|---|---|
| adapter.ts | adapter | runs Claude sessions with scoped MCP layers |
| adapter-tui.ts | adapter | runs interactive Claude sessions under tmux |
| spawn-args.ts | core | composes Claude CLI and MCP layer arguments |
| defaults.ts | config | Claude timeout, MCP path, and tool constants |
| hooks-builder.ts | core | compiles the hook registry into Claude settings |
| event-parser.ts | parser | parses Claude stream events and plan files |
| jsonl-tail.ts | core | tails a Claude transcript into events |
| tmux-control.ts | util | wraps the tmux command line |
| bg-task-tracker.ts | core | tracks background tasks and continuations |
| context-usage.ts | core | tracks context window usage per session |
| compact-window.ts | config | resolves the configured auto-compact window |
| cost-from-usage.ts | util | derives call cost from token counts |
| tool-summarizers.ts | util | renders tool inputs for trace display |
