Please update me when files in this folder change

Run-event consumers and the policies they carry. A run emits one event stream; everything that
reacts to a run without owning it lives here, so the reaction can be read without reading the run.

| filename | role | function |
|---|---|---|
| resume-recorder.ts | policy | recordDirectResume / recordThreadResume — the resume queue's only writers, and the throttle gate that decides what is worth queueing |

`resume-recorder.ts` is called imperatively today (five direct-path callers in `orchestration/`,
two thread-path callers). It sits here because the later P4.1 slices subscribe it as a
`RunObserver` on the rate-limited terminal event; the policy is already isolated so that move is a
wiring change, not a behaviour change.
