Please update me when files in this folder change

Adapter layer for Cortex turns through Claude and PI backend CLIs.
Defines shared contracts, capabilities, and normalized backend events.

| filename | role | function |
|---|---|---|
| index.ts | entry | selects daemon adapters and injects PI usage state |
| types.ts | types | Shared adapter, usage, tool-gate and plugin contracts |
| mcp-private-dir.ts | util | Guards private physical MCP directories |
| mcp-remote-fetch.ts | util | Rejects remote MCP HTTP redirects |
| capabilities.ts | core | Declares backend feature capabilities |
| bg-wait.ts | core | emits exact continuation request accounting |
| event-tee.ts | core | fans out run events and enforces required sinks |
| claude/ | subdir | Claude Code backend adapter |
| normalize/ | subdir | backend-neutral events, accounting and tool schema |
| pi/ | subdir | PI backend adapter |
