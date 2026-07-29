Please update me when files in this folder change

PI backend adapter: runs Cortex turns through the PI CLI over its RPC protocol.
Extends PI with Cortex MCP tools, hooks, subagents, interaction shims, WebFetch, and provider-side WebSearch.

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
| mcp-bridge.ts | bridge | retries and composes privilege-scoped MCP tools |
| mcp-bridge-logic.ts | core | decides server loading and maps tool content |
| hook-bridge.ts | bridge | forwards PI tool events into Cortex hooks |
| web-fetch.ts | tool | fetches bounded HTTP(S) text and cleans redirects |
| web-search.ts | tool | validates search via the active model API |
| subagent.ts | tool | runs privilege-scoped PI child agents |
| tool-shims.ts | bridge | gates delegation, interaction, todo, and web tools |
| pi-ext-types.ts | types | type stub for the PI extension API |
