Please update me when files in this folder change

PI backend adapter: runs Cortex turns on in-process PI SDK sessions.
Adds Cortex MCP tools, hooks, subagents, shims, and web tools as inline extensions.

| filename | role | function |
|---|---|---|
| adapter.ts | adapter | Pools sessions by request identity and coordinates interaction eligibility |
| pi-session.ts | core | One pooled in-process PI session: turns, steering, compaction, lifecycle |
| runtime.ts | core | Creates and owns the PI SDK session runtime behind a PISession |
| extensions.ts | core | Assembles Cortex's inline PI extensions for one session |
| ui-context.ts | bridge | Host side of PI's extension UI protocol for in-process sessions |
| session-options.ts | core | Resolves spawn configuration into PI session inputs and identity |
| session-support.ts | core | PI session timers, queues, and turn types |
| spawn-args.ts | core | Builds the sanitized CORTEX_* session env |
| defaults.ts | config | PI agent, session and extension path defaults |
| agent-dir.ts | config | manages the private PI agent directory |
| discovery.ts | core | refreshes the host provider cache from the SDK model scan |
| session-files.ts | core | Resolves an isolated PI transcript path |
| providers-config.ts | config | writes routed PI catalogs with frozen compatibility |
| custom-catalog.ts | config | Reads custom provider catalog entries |
| mcp-config.ts | config | Writes and reloads private plugin MCP config |
| event-parser.ts | parser | Translates PI session events and child prompt attribution |
| framing.ts | codec | encodes and splits PI newline JSON records |
| mcp-bridge.ts | bridge | Loads the in-memory Cortex bundle plus plugin MCP tools |
| mcp-bridge-logic.ts | core | decides server loading and maps tool content |
| hook-bridge.ts | bridge | runs registry hook scripts asynchronously with native PI results |
| web-fetch.ts | tool | fetches bounded HTTP(S) and strips data images |
| web-search.ts | tool | routes and decodes provider-side search responses |
| subagent.ts | tool | Runs isolated PI children and chain prompt notices |
| subagent-notice.ts | codec | Carries child events and runtime prompts to the server |
| tool-shims.ts | bridge | gates PI-local Agent, todo, and web tools |
| quota-probe.ts | bridge | hands provider quota read off response headers to the host |
| quota-sink.ts | core | persists labeled quota under routed provider keys and feeds throttle |
| pi-ext-types.ts | types | types PI extension events, models, and tools |
