Please update me when files in this folder change

Adapter layer for Cortex turns through Claude and PI backend CLIs.
Defines shared contracts, capabilities, and normalized backend events.

| filename | role | function |
|---|---|---|
| index.ts | entry | selects adapters and pins PI transcript paths |
| types.ts | types | Shared adapter and plugin runtime contracts |
| mcp-private-dir.ts | util | Guards private physical MCP directories |
| capabilities.ts | core | Declares backend capabilities |
| bg-wait.ts | core | emits cache-inclusive continuation input totals |
| event-tee.ts | core | fans out run events and enforces required sinks |
| claude/ | subdir | Claude Code backend adapter |
| normalize/ | subdir | backend-neutral events, accounting and tool schema |
| pi/ | subdir | PI backend adapter |
