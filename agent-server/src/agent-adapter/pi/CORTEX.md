Please update me when files in this folder change

PI backend adapter: runs Cortex turns through the PI CLI over its RPC protocol.
Extends PI with Cortex MCP tools, hooks, subagents, interaction shims, WebFetch, and provider-side WebSearch.

| filename | role | function |
|---|---|---|
| adapter.ts | adapter | runs PI sessions with authoritative resume paths |
| session-support.ts | core | PI session timers, queues, and probes |
| spawn-args.ts | core | Builds PI arguments and isolated task-aware environment |
| defaults.ts | config | PI session and extension path defaults |
| agent-dir.ts | config | manages the private PI agent directory |
| discovery.ts | core | refreshes provider cache and finds filename sessions |
| event-parser.ts | parser | translates PI events to normalized events |
| framing.ts | codec | encodes and splits PI newline JSON records |
| mcp-bridge.ts | bridge | composes shared and privilege-scoped MCP tools |
| mcp-bridge-logic.ts | core | decides server loading and maps tool content |
| hook-bridge.ts | bridge | preserves native PI hook results and mutations |
| web-fetch.ts | tool | fetches bounded HTTP(S) and strips data images |
| web-search.ts | tool | decodes search responses from the active model API |
| subagent.ts | tool | describes role names and runs scoped PI children |
| tool-shims.ts | bridge | gates Agent, interaction, todo, and web tools |
| pi-ext-types.ts | types | types PI extension events, models, and tools |
