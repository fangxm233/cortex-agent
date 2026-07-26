Please update me when files in this folder change

DR-0008 §4.5 fixture-replay tests. Lock down three-backend NormalizedEvent sequences.

| filename | role | function |
|---|---|---|
| `replay-harness.ts` | Utility | parseClaudeLine/parseCodexRpc/replayPi + golden |
| `normalize.test.ts` | Test | Edge cases: parse failure, unknown type, event dispatch |
| `claude-adapter.test.ts` | Test | Claude fixture replay + shape invariant |
| `codex-adapter.test.ts` | Test | Codex fixture replay |
| `pi-adapter.test.ts` | Test | PI fixture replay |
| `claude-tmux-control.test.ts` | Test | DR-0012 TmuxControl argv + tempfile spec (mock exec injection) |
| `claude-cost-from-usage.test.ts` | Test | DR-0012 usageToCost pricing math + model normalization |
| `claude-jsonl-tail.test.ts` | Test | DR-0012 JsonlEventNormalizer + JsonlTail file watcher |
| `claude-adapter-tui.test.ts` | Test | DR-0012 ClaudeTuiSession turn lifecycle + cancel + cost (mocked tmux/tail) |
| `bg-wait.test.ts` | Test | waitForBgContinuation merge/chain/interrupted/rate-limit/grace/cap + shouldAwaitBgInline gates + shared env-gate sources (thread inline bg wait) |
| `claude-bg-task-tracker.test.ts` | Test | BgTaskTracker running/undelivered dual-set semantics (updated{completed/failed}→undelivered, killed→dropped, notification clears) + routeLine + isContinuationResult |
| `claude-bg-continuation.test.ts` | Test | ClaudeSession handleLine wiring: pending/undelivered counts on result + spontaneous continuation routing to sink + handleProcessClose → backgroundInterrupted sink delivery (waiting window / mid-continuation crash, single-fire) + compact_boundary → onCompact (no child process) |
| `claude-stream-deltas.test.ts` | Test | Token-level streaming (`--include-partial-messages`): parseStreamEvent / takeTextBlockId against the shapes captured from a live CLI run, plus the handleLine wiring — delta emission, the blockId shared with the finalizing message, deltas summing to the final text, throwing-callback containment, and `stream_event` lines staying out of the raw jsonl |
| `normalize-assistant-delta.test.ts` | Test | `assistant_delta` union membership + `Capability.StreamingDeltas` per backend |
| `claude-mid-turn-inject.test.ts` | Test | ClaudeSession mid-turn injection: `injectUserMessage` guard rails (no process / no turn / failing stdin write → false, nothing written) + writes one NDJSON user line registering NO turn + the two landing outcomes (fold-in — echo while the turn is live acks `foldedIntoTurn:true`, opens no continuation, the turn promise resolves exactly ONCE; post-result — echo after the result acks `foldedIntoTurn:false` and the next assistant line opens a spontaneous turn routed to the continuation sink) + replay-echo hygiene (the turn's own prompt never acks, an echo alone never opens a continuation, no turn-count/finalOutput/bg-tracker contamination, pre-existing tool_result `user` carriers unaffected) + process death with an injection outstanding seals the sink (no child process) |
| `fixtures/claude/` | Data | 5 Claude stream-json fixtures + golden |
| `fixtures/codex/` | Data | 2 Codex JSON-RPC fixtures + golden |
| `fixtures/pi/` | Data | 3 PI RPC fixtures + golden |
