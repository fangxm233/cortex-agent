Please update me when files in this folder change

One bundled server exposes Cortex tools bound to a `CortexToolContext` (tools/context.ts).
Stdio entries build the context from their environment; an in-process host builds one per
session, so tools never read session scope from `process.env`.

| filename | role | function |
|---|---|---|
| bundled-server.ts | entry | Serves selected Cortex tool bundles against one tool context |
| core-server.ts | entry | Serves remote execution and time tools |
| feishu-server.ts | entry | Serves Feishu file tools |
| manager-qa-server.ts | entry | Serves subtask answer tools |
| server.ts | entry | Serves general Cortex tools |
| slack-server.ts | entry | Serves Slack file tools |
| tasks-server.ts | entry | Serves task monitoring tools |
| thread-server.ts | entry | Serves thread control tools |
| interaction-server.ts | entry | Serves bounded blocking interaction tools |
| web-server.ts | entry | Serves Web UI file tools |
| feishu/ | subdir | Implements Feishu MCP operations |
| tools/ | subdir | Implements shared MCP tools |
