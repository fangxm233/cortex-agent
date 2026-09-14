Please update me when files in this folder change

Run-event consumers and the policies they carry. A run emits one event stream; everything that
reacts to a run without owning it lives here, so the reaction can be read without reading the run.

| filename | role | policy |
|---|---|---|
| resume-recorder.ts | policy | recordDirectResume / recordThreadResume — the resume queue's only writers, and the throttle gate that decides what is worth queueing |

`resume-recorder.ts` is called imperatively today (five direct-path callers in `orchestration/`,
two thread-path callers). It sits here because the P4.1 slices subscribe it as a `RunObserver` on
the rate-limited terminal event; the policy is already isolated so that move is a wiring change,
not a behaviour change.

The production-benchmark identity/journal/ATIF family used to live here too. It is not a run
observer — it is the benchmark evidence schema, and it is read by `domain/benchmark/`'s exporter
and by `attempt.ts`'s journal sink, not by the run's other observers — so it now sits with the rest
of that schema in `domain/benchmark/`.
