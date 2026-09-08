Please update me when files in this folder change

MCP tool modules register one Cortex capability group each; every registrar takes the
session's `CortexToolContext` instead of reading `process.env`.

| filename | role | function |
|---|---|---|
| context.ts | tool | Defines CortexToolContext, builds it from env, reports caller context |
| cortex-md.ts | util | Builds CORTEX.md response blocks |
| cost.ts | tool | Reports cost and budget status |
| executions.ts | tool | Queries execution records |
| manager-qa.ts | tool | Runs manager questions over bounded loopback |
| schedule.ts | tool | Manages scheduled tasks |
| slack.ts | tool | Uploads files to Slack |
| task-monitor.ts | tool | Reads task lifecycle state |
| task-ops.ts | tool | Runs remote operations over bounded loopback |
| thread-ops.ts | tool | Controls caller threads over bounded loopback |
| time.ts | tool | Reports wall-clock time |
| interaction-ask.ts | tool | Handles shared blocking and non-blocking user questions |
| interaction-plan.ts | tool | Handles shared plan approval |
| commission-tools.ts | tool | Carries the commission creation protocol, contract approval and landing |
| ui-file.ts | tool | Sends Web UI files over bounded loopback |
| ui-view.ts | tool | Renders Web UI HTML views over bounded loopback |
| ui-decision.ts | tool | Records agent decisions over bounded loopback |
