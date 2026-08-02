Please update me when files in this folder change

MCP tool implementations — each module registers one group of Cortex tools onto an MCP server.

| filename | role | function |
|---|---|---|
| benchmark-thread-run.ts | tool | Admits one policy-bound benchmark thread |
| context.ts | tool | Reports the caller's current Cortex context |
| cortex-md.ts | util | Builds CORTEX.md blocks for tool replies |
| cost.ts | tool | Reports current cost and budget status |
| executions.ts | tool | Queries execution status records |
| manager-qa.ts | tool | Registers separate manager ask and answer tools |
| schedule.ts | tool | Creates and manages scheduled tasks |
| slack.ts | tool | Uploads files to Slack |
| task-monitor.ts | tool | Reads task status, result, and lists |
| task-ops.ts | tool | Runs file and shell operations on devices |
| thread-ops.ts | tool | Aborts, splits, or suspends the caller thread |
| time.ts | tool | Reports the current wall-clock time |
| tui-ask.ts | tool | Asks the user a question from TUI mode |
| tui-plan.ts | tool | Enters and exits TUI plan approval |
| ui-file.ts | tool | Sends a file into a Web UI chat |
