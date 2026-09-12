Please update me when files in this folder change

Run layer — the backend-neutral event vocabulary, the fully-resolved run request contract, and the
run ownership object. P1.3 wraps today's facade behind `startRun`; Phases 2–4 replace the engine
path and migrate every call site.

| filename | role | function |
|---|---|---|
| events.ts | core | RunPhase/RunEvent union plus NormalizedEvent and ContinuationSink translation |
| request.ts | core | RunRequest, AgentSpec, RunObserver and the RunResult alias |
| run.ts | core | AgentRun state machine wrapping facade.runAgent; phases, results, cancel, fan-out |
| service.ts | entry | startRun(request, observers) — opens the execution record and returns an AgentRun |
