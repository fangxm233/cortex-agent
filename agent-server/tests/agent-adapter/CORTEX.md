Please update me when files in this folder change

Agent adapter tests: Claude and PI streams normalized into shared events, plus session behaviour.

| filename | role | function |
|---|---|---|
| bg-wait.test.ts | test | remaining-background arithmetic and legacy inline-wait eligibility predicates |
| claude-adapter.test.ts | test | Claude stream-json to normalized event replay |
| claude-bg-continuation.test.ts | test | tests continuation routing, rate limits and cursor |
| claude-bg-task-tracker.test.ts | test | background task running and delivery tracking |
| claude-compact-window.test.ts | test | Claude auto-compact window settings lookup |
| claude-context-usage.test.ts | test | Claude context and four-way result accounting |
| claude-engine.test.ts | test | Claude EngineSession parity with spawn(): events, result, steer acks, run-scoped cancel, pool identity |
| claude-mid-turn-inject.test.ts | test | Claude mid-turn user message injection |
| claude-pool-fixture.ts | helper | per-adapter SessionEngines exposing the pre-P2.3c Claude pool ergonomics |
| claude-print-resume.test.ts | test | print-mode resume guard on fresh sessions |
| claude-run-phases.test.ts | test | Claude run phases: background continuation, mid-turn injection fold-in and post-result, orphan subagent, resume notification turn |
| claude-stream-deltas.test.ts | test | Claude delta and reported model parsing |
| claude-subagent-activity.test.ts | test | proves the native-subagent census event and that a subagent line still reaches every handler it reaches today |
| claude-subagent-orphan.test.ts | test | proves a backgrounded subagent's lines still reach the run's background stream after its parent turn closed |
| claude-tmux-control.test.ts | test | tmux argv, secure buffers, and tempfiles for the startup orphan sweep |
| claude-transcript-path.test.ts | test | transcript-path resume/create guard (survived the D9 TUI retirement) |
| fixtures/ | subdir | recorded backend streams and golden outputs |
| fixtures/runs/ | subdir | Claude run scripts (stream lines plus `$cortex` actions) replayed into run-phase traces |
| commission-tools.test.ts | test | commission tools are additive and hidden from every other session |
| normalize-assistant-delta.test.ts | test | delta event union and backend capability |
| normalize.test.ts | test | normalized event parser edge cases |
| pi-adapter.test.ts | test | PI session event to normalized event replay |
| pi-browser-mcp.test.ts | test | PI browser opt-in, plugin server list and pool identity |
| pi-discovery.test.ts | test | forced PI provider refresh and retry policy |
| pi-engine.test.ts | test | PI EngineSession parity with spawn(): events, result, steer acks, run-scoped cancel |
| pi-fake-runtime.ts | helper | in-memory PI runtime double for adapter and session tests |
| pi-mid-turn-inject.test.ts | test | PI switch guard and mid-turn steering: RunEvent injection_delivered/injection_rejected on the engine seam |
| pi-run-phases.test.ts | test | PI run phases: steer form per loop state, deferred turn_complete, refusal acks, session_started placement |
| pi-usage.test.ts | test | PI cached Codex usage without provider traffic |
| replay-harness.ts | helper | fixture replay, golden comparison and Claude run-phase trace helpers |
