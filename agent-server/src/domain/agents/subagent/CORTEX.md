Please update me when files in this folder change

Backend-neutral subagent runs: one `agent` tool shape, one role table, one registry, whichever
backend the parent or the child happens to be on.
Entered from PI's in-process tool and from the `agent` MCP tool's webhook; dispatches to a nested
PI session or a frozen one-shot Claude run.
The contract itself (types, schema, catalog, orchestrate, attribution, usage) lives in
`core/agents/subagent/` — the adapter speaks it too.

| filename | role | function |
|---|---|---|
| runner.ts | core | Backend dispatch for one child: model resolution, routing, and the capability gate; the Claude child opens a startRun with its role/task config |
| service.ts | entry | Daemon-side entry: validates, resolves roles, and registers the run |
| registry.ts | state | Lifecycle of one `agent` call — wait slices, stop, abandonment sweep, TTL |
