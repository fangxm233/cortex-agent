Please update me when files in this folder change

Run layer — the backend-neutral event vocabulary and the fully-resolved run request contract.
Pure types and pure translation; the run state machine, engine pool and service land in P1.2/P1.3.

| filename | role | function |
|---|---|---|
| events.ts | core | RunPhase/RunEvent union plus NormalizedEvent and ContinuationSink translation |
| request.ts | core | RunRequest, AgentSpec, RunObserver and the RunResult alias |
