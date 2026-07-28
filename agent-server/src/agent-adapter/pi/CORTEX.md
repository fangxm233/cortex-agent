Please update me when files in this folder change

PI backend adapter: runs Cortex turns through the PI CLI over its RPC protocol.
Extends PI with Cortex MCP tools, hooks, and interaction pseudo-tools.

| filename | role | function |
|---|---|---|
| adapter.ts | adapter | runs PI CLI sessions, turns, and steering |
| session-support.ts | core | PI session timers, queues, and probes |
| spawn-args.ts | core | builds PI CLI arguments and environment |
| defaults.ts | config | PI session and extension path defaults |
| agent-dir.ts | config | manages the private PI agent directory |
| discovery.ts | core | finds PI providers and session files |
| event-parser.ts | parser | translates PI events to normalized events |
| framing.ts | codec | encodes and splits PI newline JSON records |
| mcp-bridge.ts | bridge | composes privilege-scoped MCP tools in PI |
| mcp-bridge-logic.ts | core | decides server loading and maps tool content |
| hook-bridge.ts | bridge | forwards PI tool events into Cortex hooks |
| tool-shims.ts | bridge | adds interaction and todo pseudo-tools |
| pi-ext-types.ts | types | type stub for the PI extension API |
