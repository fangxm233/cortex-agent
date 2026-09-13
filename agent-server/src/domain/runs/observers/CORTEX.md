Please update me when files in this folder change

Run-event consumers and the policies they carry: the resume recorder alongside the
production-attempt journal family that captures benchmark identity, ordered attempt journals and
terminal evidence. A run emits one event stream; everything that reacts to a run without owning it
lives here, so the reaction can be read without reading the run.

| filename | role | function |
|---|---|---|
| resume-recorder.ts | policy | recordDirectResume / recordThreadResume — the resume queue's only writers, and the throttle gate that decides what is worth queueing |
| atif.ts | format | Builds recursive ATIF trajectories |
| identity.ts | core | Hashes model, role and launcher identities |
| journal.ts | core | Writes ordered production attempt journals |
| manifest-contract.ts | types | Defines terminal lifecycle evidence |
| production-attempt-identity.ts | identity | Persists production spawn identities |
| production-attempt-journal.ts | journal | Persists normalized attempt journals |
| role-surface.ts | identity | Resolves production role capability surfaces |

`resume-recorder.ts` is called imperatively today (five direct-path callers in `orchestration/`,
two thread-path callers). It sits here because the later P4.1 slices subscribe it as a
`RunObserver` on the rate-limited terminal event; the policy is already isolated so that move is a
wiring change, not a behaviour change.

`atif.ts` bounds a tool-call batch by its first RESULT, never by adjacency. A `context_usage`
heartbeat fires every couple of seconds and lands between two calls of one batch as readily as
between a call and its result; when the call phase ended at the first non-call event, only the
calls before the heartbeat were registered and the rest of the batch's results were condemned as
`unpaired_tool_result`. That discarded whole journals — and, through the export path, whole
benchmark trials.
