Please update me when files in this folder change

Adapter layer for Cortex turns through Claude and PI backend CLIs.
Defines shared contracts, capabilities, and normalized backend events.

| filename | role | function |
|---|---|---|
| index.ts | entry | re-exports the shared adapter contract (types, capabilities, events, hooks); the daemon assembly lives in domain/runs/adapters.ts |
| types.ts | types | Shared engine/session contracts (EngineSpec, EngineRun, EngineSession, EngineAdapter), usage, tool-gate, MCP and the two session ports (BackgroundTurnSink, InjectionAckSink) |
| run-events.ts | types | RunPhase/RunEvent vocabulary, the NormalizedEvent → RunEvent translation and the RunEventQueue backing EngineRun.events |
| mcp-private-dir.ts | util | Guards private physical MCP directories |
| mcp-remote-fetch.ts | util | Rejects remote MCP HTTP redirects |
| browser-mcp-server.ts | core | Defines the Playwright MCP server every backend uses for browser control |
| capabilities.ts | core | Declares shared interaction and subagent-hosting backend capabilities |
| bg-wait.ts | core | background-continuation policy knobs: settings gate, grace/max-wait bounds, remaining-work arithmetic |
| continuation-phase.ts | core | the background phase of one engine run: RunEvents for continuation turns, the merged result, and the grace/max-wait watchdog |
| claude/ | subdir | Claude Code backend adapter |
| normalize/ | subdir | backend-neutral events, accounting and tool schema |
| pi/ | subdir | PI backend adapter |
