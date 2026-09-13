Please update me when files in this folder change

PI backend adapter: runs Cortex turns on in-process PI SDK sessions.
Adds Cortex MCP tools, hooks, subagents, shims, and web tools as inline extensions.

| filename | role | function |
|---|---|---|
| adapter.ts | adapter | Stateless PI EngineAdapter: spec identity, session open, usage and transcript registry |
| engine.ts | adapter | PIEngineSession over one PISession: one RunEvent stream per run |
| pi-session.ts | core | One pooled in-process PI session: turns, steering, compaction, lifecycle |
| runtime.ts | core | Creates and owns the PI SDK session runtime behind a PISession |
| child-session.ts | core | Builds the nested in-memory PI sessions subagents run on |
| extensions.ts | core | Assembles Cortex's inline PI extensions for one session |
| ui-context.ts | bridge | Host side of PI's extension UI protocol for in-process sessions |
| session-options.ts | core | Resolves spawn configuration into PI session inputs, CORTEX_* env and identity |
| session-support.ts | core | PI session timers, queues, and turn types |
| defaults.ts | config | PI agent and session path defaults |
| agent-dir.ts | config | manages the private PI agent directory |
| discovery.ts | core | refreshes the host provider/model-pair cache from the SDK model scan |
| session-files.ts | core | Resolves an isolated PI transcript path |
| providers-config.ts | config | writes routed PI catalogs with frozen compatibility |
| custom-catalog.ts | config | Reads custom provider catalog entries |
| event-parser.ts | parser | Translates PI session events and forwarded subagent events |
| mcp-bridge.ts | bridge | Hosts the injected Cortex bundle server plus plugin MCP tools, gating the tools PI supplies natively |
| mcp-bridge-logic.ts | core | decides server loading and maps tool content |
| hook-bridge.ts | bridge | runs registry hooks in-process when they expose an entry point, otherwise as scripts |
| web-fetch.ts | tool | fetches bounded HTTP(S) and strips data images |
| web-search.ts | tool | routes and decodes provider-side search responses |
| subagent.ts | tool | The PI `agent` / `agent_stop` tools: role resolution, modes, backgrounding |
| child-runner.ts | core | Runs one nested PI child to completion, for either backend's parent |
| child-events.ts | parser | Turns a nested child's raw session records into parent-transcript notices |
| background-subagent.ts | contract | Port types for a backgrounded PI run; orchestration/pi-background-subagent.ts implements it |
| subagent-bridge.ts | contract | PiSubagentBridge — the daemon collaborators the `agent` tool needs, injected by the host |
| tool-shims.ts | bridge | gates PI-local agent/agent_stop, todo, and web tools |
| quota-probe.ts | bridge | hands provider quota read off response headers to the host |
| quota-sink.ts | core | persists labeled quota under routed provider keys and feeds throttle |
