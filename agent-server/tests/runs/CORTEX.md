Please update me when files in this folder change

Run layer tests: RunEvent translation, the RunRegistry, startRun, config
resolution, spec and prompt composition, the EngineSpec builder, the engine pool, the attempt-chain
policies (what a run tries and what it says about it) and the run observers' policies.

| filename | role | function |
|---|---|---|
| compact.test.ts | test | compactAgentContext support gating, same-session resume, no-turn compact and the recorded cost row (real PI engine, fake runtime) |
| config-resolver.test.ts | test | resolveRunConfig/resolveProfileName/resolveRunBackend across D5's five priority layers |
| fallback.test.ts | test | planAttempts chain order, and allConfigsRateLimited's all-blocked gate (fails open on an unknown profile) |
| notices.test.ts | test | the held rate-limit card (auto-resume vs failure), fallback warnings and per-attempt dedupe, subagent attribution, and the web-only synthesis gate |
| throttle-fixture.ts | fixture | loadThrottleHome — the private CORTEX_HOME + seeded profiles + armed throttle both attempt-policy suites need |
| engine-spec.test.ts | test | buildEngineSpec exact captured-output assertions, and engineIdentity key-order stability plus its three exclusions |
| engines.test.ts | test | SessionEngines pool ownership: reuse, retirement, synchronous eviction on close, and the detached registerSessionPath reference |
| events.test.ts | test | every NormalizedEvent translation and phase tag, and every ContinuationSink callback |
| prompt.test.ts | test | composeSystemPrompt / composeUserPrompt pinned byte-for-byte against the pre-P3.3b builders |
| registry.test.ts | test | RunRegistry.sessionState combinations and the background-hold lifecycle |
| resume-recorder.test.ts | test | recordDirectResume's throttle gate (and why an un-throttled 429 is terminal) vs recordThreadResume's unconditional record |
| spec-loader.test.ts | test | bareSpec / fromAgentSlot / fromRole field by field, incl. the Claude MCP tool-name prefixing |
| service.test.ts | test | startRun event order/phases, foreground→background→done, the background watchdog (grace finalizes, the cap does not), bookkeeping, cancel, observer safety |
