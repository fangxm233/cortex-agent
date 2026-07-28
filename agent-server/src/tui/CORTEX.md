Please update me when files in this folder change

Ink terminal client, dashboard, input, transcript, and WebSocket state.

| filename | role | function |
|---|---|---|
| App.tsx | component | Composes the terminal interface |
| RENDER-PERF-PLAN.md | docs | Documents terminal rendering performance design |
| index.tsx | entry | Exports the directory public API |
| logic.ts | logic | Provides testable terminal interaction logic |
| raf-batch.ts | render | Batches terminal renders per animation frame |
| render-output.ts | render | Coalesces terminal output rendering |
| slash-commands.ts | commands | Defines terminal slash command registry |
| turn-status.ts | format | Parses and formats terminal turn status |
| ws-client.ts | client | Maintains the terminal WebSocket connection |
| components/ | directory | Contains terminal UI components |
| hooks/ | directory | Contains terminal React hooks |
| render/ | directory | Contains terminal rendering modules |
