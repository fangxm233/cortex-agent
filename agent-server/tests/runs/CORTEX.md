Please update me when files in this folder change

Run layer tests: RunEvent translation, the continuation-sink adapter, the RunRegistry, startRun, the EngineSpec builder and the engine pool.

| filename | role | function |
|---|---|---|
| continuation-sink.test.ts | test | runToContinuationSink replays background RunEvents as legacy ContinuationSink callbacks |
| engine-spec.test.ts | test | buildEngineSpec exact captured-output assertions, and engineIdentity key-order stability plus its three exclusions |
| engines.test.ts | test | SessionEngines pool ownership: reuse, retirement, synchronous eviction on close, and the detached registerSessionPath reference |
| events.test.ts | test | every NormalizedEvent translation and phase tag, and every ContinuationSink callback |
| registry.test.ts | test | RunRegistry.sessionState combinations and the background-hold lifecycle |
| service.test.ts | test | startRun event order/phases, foreground→background→done, bookkeeping, cancel, observer safety |
