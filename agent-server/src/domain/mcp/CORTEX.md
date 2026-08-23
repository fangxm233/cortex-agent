Please update me when files in this folder change

Gated MCP stdio servers expose Cortex tools by privilege and platform.

| filename | role | function |
|---|---|---|
| core-server.ts | entry | Serves remote execution and time tools |
| feishu-server.ts | entry | Serves Feishu file tools |
| manager-qa-server.ts | entry | Serves subtask answer tools |
| server.ts | entry | Serves general Cortex tools |
| slack-server.ts | entry | Serves Slack file tools |
| tasks-server.ts | entry | Serves task monitoring tools |
| thread-server.ts | entry | Serves thread control tools |
| tui-server.ts | entry | Serves shared blocking interaction tools |
| web-server.ts | entry | Serves Web UI file tools |
| feishu/ | subdir | Implements Feishu MCP operations |
| tools/ | subdir | Implements shared MCP tools |
