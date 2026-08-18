Please update me when files in this folder change

PI backend adapter: runs Cortex turns through the PI CLI over RPC.
Adds Cortex MCP tools, hooks, subagents, shims, and web tools.

| filename | role | function |
|---|---|---|
| adapter.ts | adapter | Coordinates PI sessions, routing and cached usage |
| session-support.ts | core | PI session timers, queues, and probes |
| spawn-args.ts | core | Builds PI args and scrubs trial controls from child environments |
| defaults.ts | config | PI agent, session and extension path defaults |
| agent-dir.ts | config | manages the private PI agent directory |
| discovery.ts | core | refreshes the host provider cache |
| session-files.ts | core | Resolves an isolated PI transcript path |
| providers-config.ts | config | writes the PI provider catalog at an explicit path |
| custom-catalog.ts | config | Reads custom provider catalog entries |
| mcp-config.ts | config | Writes and reloads private plugin MCP config |
| event-parser.ts | parser | translates PI events with exact nullable token splits |
| framing.ts | codec | encodes and splits PI newline JSON records |
| mcp-bridge.ts | bridge | Composes and validates gated MCP tools from process env |
| mcp-bridge-logic.ts | core | decides server loading and maps tool content |
| hook-bridge.ts | bridge | preserves native PI hook results and mutations |
| web-fetch.ts | tool | fetches bounded HTTP(S) and strips data images |
| web-search.ts | tool | routes and decodes provider-side search responses |
| subagent.ts | tool | describes role names and runs scoped PI children |
| tool-shims.ts | bridge | gates Agent, interaction, todo, and web tools |
| quota-probe.ts | bridge | reports provider quota read off response headers |
| quota-sink.ts | core | persists quota usage and preserves throttle submissions |
| pi-ext-types.ts | types | types PI extension events, models, and tools |
