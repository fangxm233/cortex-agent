Please update me when files in this folder change

Agent adapter tests: Claude and PI streams normalized into shared events, plus session behaviour.

| filename | role | function |
|---|---|---|
| bg-wait.test.ts | test | bounded, completion-only, and legacy background wait policy |
| claude-adapter.test.ts | test | Claude stream-json to normalized event replay |
| claude-adapter-tui.test.ts | test | Claude TUI session turn lifecycle and cost |
| claude-bg-continuation.test.ts | test | tests continuation routing and cumulative cursor |
| claude-bg-task-tracker.test.ts | test | background task running and delivery tracking |
| claude-compact-window.test.ts | test | Claude auto-compact window settings lookup |
| claude-context-usage.test.ts | test | Claude context and cache-read accounting |
| claude-cost-from-usage.test.ts | test | Claude TUI cost reconstruction from usage |
| claude-jsonl-tail.test.ts | test | Claude transcript and cache-read events |
| claude-mid-turn-inject.test.ts | test | Claude mid-turn user message injection |
| claude-print-resume.test.ts | test | print-mode resume guard on fresh sessions |
| claude-stream-deltas.test.ts | test | Claude delta and reported model parsing |
| claude-subagent-activity.test.ts | test | proves the native-subagent census event and that a subagent line still reaches every handler it reaches today |
| claude-tmux-control.test.ts | test | tmux argv, secure buffers, and tempfiles |
| claude-tui-resume.test.ts | test | TUI first-turn resume guard |
| fixtures/ | subdir | recorded backend streams and golden outputs |
| normalize-assistant-delta.test.ts | test | delta event union and backend capability |
| normalize.test.ts | test | normalized event parser edge cases |
| pi-adapter.test.ts | test | PI RPC to normalized event replay |
| pi-context-usage-probe.test.ts | test | PI end-of-turn context usage probe |
| pi-discovery.test.ts | test | forced PI provider refresh and retry policy |
| pi-mcp-duration.test.ts | test | PI MCP call bounded by the trial deadline |
| pi-mid-turn-inject.test.ts | test | PI switch guard and mid-turn prompt steering |
| pi-policy-guard.test.ts | test | fail-closed benchmark guard decisions for PI |
| pi-supervision.test.ts | test | PI spawns through the injected supervisor |
| pi-tool-shims-guard.test.ts | test | guarded PI tool dispatch and shim registration |
| replay-harness.ts | helper | fixture replay and golden comparison helpers |
