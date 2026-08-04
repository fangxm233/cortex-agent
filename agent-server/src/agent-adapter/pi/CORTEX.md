Please update me when files in this folder change

PI backend adapter: runs Cortex turns through the PI CLI over its RPC protocol.
Extends PI with Cortex MCP tools, hooks, subagents, interaction shims, WebFetch, and provider-side WebSearch.

| filename | role | function |
|---|---|---|
| adapter.ts | adapter | runs supervised PI sessions from injected collaborators |
| session-support.ts | core | PI session timers, queues, and probes |
| spawn-args.ts | core | Builds PI arguments and isolated task-aware environment |
| defaults.ts | config | PI agent, session and extension path defaults |
| agent-dir.ts | config | manages the private PI agent directory |
| discovery.ts | core | refreshes the host provider cache |
| session-files.ts | core | resolves a PI transcript path without ambient reach |
| providers-config.ts | config | writes the PI provider catalog at an explicit path |
| custom-catalog.ts | config | reads user-defined provider blocks from a catalog file |
| policy-guard.ts | core | decides PI tool dispatch fail-closed from the compiled guard |
| mcp-duration.ts | core | bounds an MCP call by the trial deadline plus cleanup grace |
| event-parser.ts | parser | translates PI events with nullable accounting |
| framing.ts | codec | encodes and splits PI newline JSON records |
| mcp-bridge.ts | bridge | composes shared and privilege-scoped MCP tools |
| mcp-bridge-logic.ts | core | decides server loading and maps tool content |
| hook-bridge.ts | bridge | preserves native PI hook results and mutations |
| web-fetch.ts | tool | fetches bounded HTTP(S) and strips data images |
| web-search.ts | tool | decodes search responses from the active model API |
| subagent.ts | tool | describes role names and runs scoped PI children |
| tool-shims.ts | bridge | gates Agent, interaction, todo, and web tools |
| quota-probe.ts | bridge | reports provider quota read off response headers |
| quota-sink.ts | core | files quota readings into the rate-limit throttle |
| pi-ext-types.ts | types | types PI extension events, models, and tools |
