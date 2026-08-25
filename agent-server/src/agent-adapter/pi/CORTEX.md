Please update me when files in this folder change

PI backend adapter: runs Cortex turns through the PI CLI over RPC.
Adds Cortex MCP tools, hooks, subagents, shims, and web tools.

| filename | role | function |
|---|---|---|
| adapter.ts | adapter | Pools sessions by spawn identity and coordinates interaction eligibility |
| session-support.ts | core | PI session timers, queues, and probes |
| spawn-args.ts | core | Builds PI args and sanitized interaction env |
| defaults.ts | config | PI agent, session and extension path defaults |
| agent-dir.ts | config | manages the private PI agent directory |
| discovery.ts | core | refreshes the host provider cache |
| session-files.ts | core | Resolves an isolated PI transcript path |
| providers-config.ts | config | writes routed PI catalogs with frozen compatibility |
| custom-catalog.ts | config | Reads custom provider catalog entries |
| mcp-config.ts | config | Writes and reloads private plugin MCP config |
| event-parser.ts | parser | translates tool, dialog, lifecycle and usage events |
| framing.ts | codec | encodes and splits PI newline JSON records |
| mcp-bridge.ts | bridge | Loads gated MCP tools concurrently |
| mcp-bridge-logic.ts | core | decides server loading and maps tool content |
| hook-bridge.ts | bridge | preserves native PI hook results and mutations |
| web-fetch.ts | tool | fetches bounded HTTP(S) and strips data images |
| web-search.ts | tool | routes and decodes provider-side search responses |
| subagent.ts | tool | runs isolated role-scoped PI children |
| subagent-notice.ts | codec | carries a child's events out to the server for attribution |
| tool-shims.ts | bridge | gates PI-local Agent, todo, and web tools |
| quota-probe.ts | bridge | reports provider quota read off response headers |
| quota-sink.ts | core | persists labeled quota under routed provider keys and feeds throttle |
| pi-ext-types.ts | types | types PI extension events, models, and tools |
