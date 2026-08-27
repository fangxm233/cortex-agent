Please update me when files in this folder change

Production benchmark identity, journal and evidence-format primitives.

| filename | role | function |
|---|---|---|
| atif.ts | format | Builds recursive ATIF trajectories |
| identity.ts | core | Hashes model, role and launcher identities |
| journal.ts | core | Writes ordered production attempt journals |
| manifest-contract.ts | types | Defines terminal lifecycle evidence |
| production-attempt-identity.ts | identity | Persists production spawn identities |
| production-attempt-journal.ts | journal | Persists normalized attempt journals |
| role-surface.ts | identity | Resolves production role capability surfaces |

`atif.ts` bounds a tool-call batch by its first RESULT, never by adjacency. A `context_usage`
heartbeat fires every couple of seconds and lands between two calls of one batch as readily as
between a call and its result; when the call phase ended at the first non-call event, only the
calls before the heartbeat were registered and the rest of the batch's results were condemned as
`unpaired_tool_result`. That discarded whole journals — and, through the export path, whole
benchmark trials.
