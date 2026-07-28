Please update me when files in this folder change

MCP domain — one stdio MCP server per surface (core, ext, Slack, Feishu, Web, TUI) exposing Cortex tools to agents.

| filename | role | function |
|---|---|---|
| core-server.ts | entry | Serves task, thread, time, and Q&A tools |
| feishu-server.ts | entry | Serves Feishu file tools |
| server.ts | entry | Serves cost, execution, context, schedule tools |
| slack-server.ts | entry | Serves Slack file tools |
| tui-server.ts | entry | Serves Claude TUI plan and ask tools |
| web-server.ts | entry | Serves Web UI file tools |
| feishu/ | subdir | Feishu API client and tool registration |
| tools/ | subdir | Tool implementations used by the servers |
