Please update me when files in this folder change

Run layer — the backend-neutral event vocabulary, the fully-resolved run request contract, the
run ownership object, spec and prompt composition, and the legacy continuation-sink bridge the P1.5 background holds use.
`startRun` wraps today's facade and owns the execution/registry lifecycle; the conversation,
thread-step, hook-agent, edit-retry, ask-user-resume, scheduled auto-compound and Claude-subagent
paths all build a `RunRequest` and open a run. Phases 2–4 replace the engine path underneath.

| filename | role | function |
|---|---|---|
| config-resolver.ts | core | resolveRunConfig — D5's five-layer profile priority plus the channel model override |
| continuation-sink.ts | core | runToContinuationSink(run, sink, waits) — replays a run's background events as legacy ContinuationSink callbacks, and delivers the run's grace/max-wait verdict |
| events.ts | core | re-exports RunPhase/RunEvent/toRunEvent from agent-adapter and translates ContinuationSink callbacks into them |
| engine-spec.ts | core | buildEngineSpec + engineIdentity(); owns the scoped-plugin gate and PI gateway-path derivation |
| adapters.ts | entry | builds the daemon's Claude and PI engine adapters, injecting the collaborators the adapter may not import (usage store, rate-limit throttle, PI home) — getAdapter/getEngineAdapter |
| engines.ts | core | SessionEngines — the one owner of pooled engine sessions for both backends (acquire/close/kill/closeByPrefix/closeAll/registerSessionPath); module singleton `engines` + transitional PI and Claude run adapters |
| prompt.ts | core | composeSystemPrompt / composeUserPrompt — the one place a run's system and user prompts are assembled, plus the rules and USER.md block loaders |
| request.ts | core | RunRequest, RunObserver and the RunResult alias (nullable session id, legacy useCoreMcp); re-exports AgentSpec from spec-loader |
| run.ts | core | AgentRun state machine wrapping facade.runAgent directly; phases, results, cancel, steer (mid-turn injection + ack events), the background grace/max-wait watchdog, fan-out |
| spec-loader.ts | core | AgentSpec + the three loaders that build one: bareSpec / fromAgentSlot / fromRole |
| service.ts | entry | startRun(request, observers) — opens the execution record and returns an AgentRun |
| observers/ | dir | run-event consumers and the policies they carry (see its own CORTEX.md) |
