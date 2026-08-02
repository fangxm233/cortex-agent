Please update me when files in this folder change

MCP domain — one stdio server per privilege or platform surface, composed by the agent backends.

| filename | role | function |
|---|---|---|
| benchmark-thread-server.ts | entry | Serves one bounded benchmark thread tool |
| core-server.ts | entry | Serves remote execution and time tools |
| feishu-server.ts | entry | Serves Feishu file tools |
| manager-qa-server.ts | entry | Serves shared subtask-answer tools |
| server.ts | entry | Serves cost, execution, context, schedule tools |
| slack-server.ts | entry | Serves Slack file tools |
| tasks-server.ts | entry | Serves read-only task monitoring tools |
| thread-server.ts | entry | Serves thread control and upward questions |
| tui-server.ts | entry | Serves Claude TUI plan and ask tools |
| web-server.ts | entry | Serves Web UI file tools |
| feishu/ | subdir | Feishu API client and tool registration |
| tools/ | subdir | Tool implementations used by the servers |
