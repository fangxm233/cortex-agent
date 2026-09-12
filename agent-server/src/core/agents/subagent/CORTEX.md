Please update me when files in this folder change

The backend-neutral subagent vocabulary: the task/result types, the invocation contract, the
rendered `agent` field descriptions, the run orchestration, the parent-transcript attribution and
the usage arithmetic.
Pure — no store, no registry, no I/O. It lives in core because both sides of the boundary speak it:
the PI adapter builds the in-process `agent` tool from it, and `domain/agents/subagent` builds the
daemon-side entry, dispatch and lifecycle on top of it.

| filename | role | function |
|---|---|---|
| types.ts | types | Task, result, usage and child-forwarder vocabulary |
| schema.ts | contract | Validates raw tool params into one Invocation; owns the task and concurrency caps |
| catalog.ts | core | Renders the `agent` field descriptions from the live role table and backend models |
| orchestrate.ts | core | Runs single / parallel / chain and builds the tool result both entries return |
| attribution.ts | core | Translates a child notice into the parent transcript's own events |
| usage.ts | util | Empty and aggregated subagent usage |
