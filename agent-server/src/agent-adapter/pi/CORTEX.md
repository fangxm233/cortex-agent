Please update me when files in this folder change

PI backend adapter: runs Cortex turns through the PI CLI over RPC.
Adds Cortex MCP tools, hooks, subagents, shims, and web tools.

| filename | role | function |
|---|---|---|
| adapter.ts | adapter | Coordinates PI sessions and benchmark policy |
| session-support.ts | core | PI session timers, queues, and probes |
| spawn-args.ts | core | Builds isolated PI args and policy environment |
| defaults.ts | config | PI agent, session and extension path defaults |
| agent-dir.ts | config | manages the private PI agent directory |
| discovery.ts | core | refreshes the host provider cache |
| session-files.ts | core | Resolves an isolated PI transcript path |
| providers-config.ts | config | writes the PI provider catalog at an explicit path |
| custom-catalog.ts | config | Reads custom provider catalog entries |
| policy-guard.ts | core | Guards PI tool dispatch fail-closed |
| mcp-config.ts | config | Writes and reloads private plugin MCP config |
| mcp-duration.ts | core | Bounds MCP calls by trial deadlines |
| event-parser.ts | parser | translates PI events with nullable accounting |
| framing.ts | codec | encodes and splits PI newline JSON records |
| mcp-bridge.ts | bridge | Composes MCP tools from the selected process env |
| mcp-bridge-logic.ts | core | decides server loading and maps tool content |
| hook-bridge.ts | bridge | preserves native PI hook results and mutations |
| web-fetch.ts | tool | fetches bounded HTTP(S) and strips data images |
| web-search.ts | tool | routes and decodes provider-side search responses |
| subagent.ts | tool | describes role names and runs scoped PI children |
| tool-shims.ts | bridge | gates Agent, interaction, todo, and web tools |
| quota-probe.ts | bridge | reports provider quota read off response headers |
| quota-sink.ts | core | files quota readings into the rate-limit throttle |
| pi-ext-types.ts | types | types PI extension events, models, and tools |
