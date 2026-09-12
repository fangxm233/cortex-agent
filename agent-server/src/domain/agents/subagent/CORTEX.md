Please update me when files in this folder change

Backend-neutral subagent runs: one `agent` tool shape, one role table, one registry, whichever
backend the parent or the child happens to be on.
Entered from PI's in-process tool and from the `agent` MCP tool's webhook; dispatches to a nested
PI session or a frozen one-shot Claude run.

| filename | role | function |
|---|---|---|
| types.ts | types | Task, result, usage and child-forwarder vocabulary |
| schema.ts | contract | Validates raw tool params into one Invocation; owns the task and concurrency caps |
| catalog.ts | core | Renders the `agent` field descriptions from the live role table and backend models |
| orchestrate.ts | core | Runs single / parallel / chain and builds the tool result both entries return |
| runner.ts | core | Backend dispatch for one child: model resolution, routing, and the capability gate; the Claude child opens a startRun with its role/task config |
| service.ts | entry | Daemon-side entry: validates, resolves roles, and registers the run |
| registry.ts | state | Lifecycle of one `agent` call — wait slices, stop, abandonment sweep, TTL |
| attribution.ts | core | Translates a child notice into the parent transcript's own events |
| usage.ts | util | Empty and aggregated subagent usage |
