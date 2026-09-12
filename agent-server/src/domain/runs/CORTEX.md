Please update me when files in this folder change

Run layer — the backend-neutral event vocabulary, the fully-resolved run request contract, the
run ownership object, and the legacy continuation-sink bridge the P1.5 background holds use.
`startRun` wraps today's facade and owns the execution/registry lifecycle; the conversation,
thread-step and hook-agent paths all build a `RunRequest` and open a run. Phases 2–4 replace the
engine path and migrate every remaining call site.

| filename | role | function |
|---|---|---|
| continuation-sink.ts | core | runToContinuationSink(run, sink) — replays a run's background events as legacy ContinuationSink callbacks |
| events.ts | core | RunPhase/RunEvent union plus NormalizedEvent and ContinuationSink translation |
| request.ts | core | RunRequest, AgentSpec, RunObserver and the RunResult alias (nullable session id, legacy useCoreMcp) |
| run.ts | core | AgentRun state machine wrapping facade.runAgent; phases, results, cancel, fan-out |
| service.ts | entry | startRun(request, observers) — opens the execution record and returns an AgentRun |
