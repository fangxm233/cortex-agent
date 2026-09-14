Please update me when files in this folder change

Run layer — the backend-neutral event vocabulary, the fully-resolved run request contract, the
run ownership object, and spec and prompt composition.
`startRun` owns the execution/registry lifecycle and hands back the `AgentRun`, which walks its
profile's attempt chain over pooled engine sessions. The conversation, thread-step, hook-agent,
edit-retry, ask-user-resume, scheduled auto-compound and Claude-subagent paths all build a
`RunRequest` and open a run — there is no other way to start one.

| filename | role | function |
|---|---|---|
| config-resolver.ts | core | resolveRunConfig / resolveRunRoute — D5's five-layer profile priority, the channel model override, and the per-attempt mode route |
| attempt.ts | core | startAttempt — one link of the chain: acquire the pooled engine, open a run on it, freeze the identity, attribute the cost. Two results: `foreground` and `settled` |
| compact.ts | core | compactAgentContext / isSessionCompactionSupported — compaction is a command on a session's pooled engine, not a run |
| fallback.ts | core | planAttempts / attemptLabel / allConfigsRateLimited — the ordered attempt chain a run walks and the gate that skips a blocked attempt |
| notices.ts | core | AttemptNoticeTracker + assistantNoticeLevel — the only place run lifecycle becomes prose; holds a 429 card until the outcome is known |
| events.ts | core | re-exports RunPhase/RunEvent/toRunEvent from agent-adapter — the run layer's name for the event vocabulary |
| engine-spec.ts | core | buildEngineSpec + engineIdentity(); owns the scoped-plugin gate and PI gateway-path derivation |
| adapters.ts | entry | builds the daemon's Claude and PI engine adapters, injecting the collaborators the adapter may not import (usage store, rate-limit throttle, PI home) — getClaudeEngineAdapter / getPiEngineAdapter |
| engines.ts | core | SessionEngines — the one owner of pooled engine sessions for both backends (acquire/close/kill/closeByPrefix/closeAll/registerSessionPath); module singleton `engines` |
| prompt.ts | core | composeSystemPrompt / composeUserPrompt — the one place a run's system and user prompts are assembled, plus the rules and USER.md block loaders |
| request.ts | core | RunRequest, RunObserver and the RunResult alias (nullable session id, legacy useCoreMcp); re-exports AgentSpec from spec-loader |
| run.ts | core | AgentRun state machine: walks the attempt chain, runs the notice stage, phases, results, cancel, steer (mid-turn injection + ack events), provider/auth attribution, fan-out |
| spec-loader.ts | core | AgentSpec + the three loaders that build one: bareSpec / fromAgentSlot / fromRole |
| service.ts | entry | startRun(request, observers) — opens the execution record and returns an AgentRun |
| observers/ | dir | run-event consumers and the policies they carry (see its own CORTEX.md) |
