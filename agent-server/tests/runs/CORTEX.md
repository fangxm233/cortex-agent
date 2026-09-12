Please update me when files in this folder change

Run layer tests: RunEvent translation, the continuation-sink adapter, the RunRegistry, startRun, config
resolution, spec and prompt composition, the EngineSpec builder, the engine pool and the run
observers' policies.

| filename | role | function |
|---|---|---|
| config-resolver.test.ts | test | resolveRunConfig/resolveProfileName/resolveRunBackend across D5's five priority layers |
| continuation-sink.test.ts | test | runToContinuationSink replays background RunEvents as legacy ContinuationSink callbacks |
| engine-spec.test.ts | test | buildEngineSpec exact captured-output assertions, and engineIdentity key-order stability plus its three exclusions |
| engines.test.ts | test | SessionEngines pool ownership: reuse, retirement, synchronous eviction on close, and the detached registerSessionPath reference |
| events.test.ts | test | every NormalizedEvent translation and phase tag, and every ContinuationSink callback |
| prompt.test.ts | test | composeSystemPrompt / composeUserPrompt pinned byte-for-byte against the pre-P3.3b builders |
| registry.test.ts | test | RunRegistry.sessionState combinations and the background-hold lifecycle |
| resume-recorder.test.ts | test | recordDirectResume's throttle gate (and why an un-throttled 429 is terminal) vs recordThreadResume's unconditional record |
| spec-loader.test.ts | test | bareSpec / fromAgentSlot / fromRole field by field, incl. the Claude MCP tool-name prefixing |
| service.test.ts | test | startRun event order/phases, foreground→background→done, bookkeeping, cancel, observer safety |
