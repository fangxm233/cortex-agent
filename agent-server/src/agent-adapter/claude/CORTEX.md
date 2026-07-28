Please update me when files in this folder change

Claude Code process control, event parsing, and session adaptation.

| filename | role | function |
|---|---|---|
| adapter-tui.ts | adapter | Runs Claude through an interactive tmux session |
| adapter.ts | adapter | Adapts Claude to shared contracts |
| bg-task-tracker.ts | tracker | Tracks bg task state |
| context-usage.ts | module | Tracks context usage |
| cost-from-usage.ts | module | Tracks cost from usage |
| defaults.ts | config | Defines Claude defaults |
| event-parser.ts | parser | Parses event data |
| hooks-builder.ts | builder | Builds Claude hook configuration |
| jsonl-tail.ts | stream | Tails Claude session events from JSONL |
| spawn-args.ts | module | Builds spawn arguments |
| tmux-control.ts | control | Controls tmux processes |
| tool-summarizers.ts | format | Summarizes tool inputs |
