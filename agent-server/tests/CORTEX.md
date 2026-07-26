Please update me when files in this folder change

agent-server TypeScript ESM regression tests. Reference production code from here via ../src/*.js.
Runs under **vitest** (`vitest.config.ts`): one shared Vite server transpiles each module once
and caches it, so the suite no longer pays a per-file `tsx` cold-start. A `.js`→`.ts` pre-resolver
(config) lets NodeNext `../src/foo.js` imports resolve to `foo.ts`; `tests/_vitest-setup.ts` gives
each test file its own temp `CORTEX_HOME`; `tests/module-loader.ts` `importFresh` re-imports a single
module fresh (query-string cache-bust) while keeping transitive singletons shared.

Test API is vitest's: `import { test, describe, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'`
(no default `test` export; node:test `before`/`after` → `beforeAll`/`afterAll`). `node:assert/strict`
still works and is used throughout. Fake timers use `vi.useFakeTimers`/`advanceTimersByTime`; spies use
`vi.spyOn` (auto-restored via `restoreMocks: true`).

## Cleanup Discipline: register cleanup for long-lived resources, don't write it at the end of the test body

If the module under test holds long-lived resources such as timer/interval/listener/child process (typical examples:
`rate-limit-throttle._resumeTimer`, `disk-monitor._timer`),
the test **must** register cleanup with `t.onTestFinished(() => mod._testReset())` (the vitest context
teardown; the node:test `t.after()` equivalent) instead of writing `mod._testReset()` at the end of each test body.

Reason: when an assertion fails, code at the end of the test body does not execute; residual `setTimeout`/`setInterval` will cause the Node event loop
to refuse to exit, and the suite hangs after the last test. `t.onTestFinished()` runs in all three cases (pass/fail/throw)
and is the only safe cleanup location. The `afterEach` global hook or `try/finally` also work — choose any of the three.

Reference implementation: the `freshModuleWithCleanup(t)` helper in `tests/rate-limit-throttle.test.ts`.

## Note: Tests must not modify files actually in production use, must not actually send content, to avoid issues

### Isolation is enforced (tripwire), not just convention
`atomicWrite` (the primitive every JSON store writes through) **throws** if a test process
(`NODE_TEST_CONTEXT` set) attempts to write under the real `~/.cortex`. This turns silent
production pollution into an immediate failure. Production is unaffected (guard is no-op when
`NODE_TEST_CONTEXT` is unset). Regression: `tests/core/atomic-write-guard.test.ts`.

How to run tests without tripping it (`_vitest-setup.ts` sets `NODE_TEST_CONTEXT` so the guard stays armed):
- Full suite: `npm test` (run-tests.sh seeds an isolated CORTEX_HOME; the vitest setupFile clones it
  per test file).
- One file: `npm run test:file tests/path/to/x.test.ts` (`vitest run <file>`; the setupFile repoints
  CORTEX_HOME at a per-file temp before `paths.ts` binds).
- Integration (forked servers): `npm run test:integration` (`vitest.integration.config.ts`, 120s timeout, serial).
- If you see `atomicWrite blocked: …`, a file wrote to production without isolating — run it via `test:file`
  so the setupFile applies, rather than a raw `vitest`/`tsx` invocation that skips it.

| filename | role | function |
|---|---|---|
| `agent-adapter/` | Subdirectory | Three-backend fixture-replay tests |
| `orch/` | Subdirectory | Orch orchestration layer (running-executions / conduit-queue / superseded-edits / plan-approvals / ask-user-question-pi) regression tests |
| `orchestration/` | Subdirectory | Orchestration units tested in isolation: `agent-file-send` (agent-produced file → workspace copy + transcript message), `session-rewind` (message edit rollback), `delta-coalescer` (token-level streaming: window/char-cap batching, per-block `seq`, the pre-finalize drain, and `createSessionDeltaStream` — the gate proving Slack / Feishu / Ink-TUI / thread channels never stream) |
| `threads/` | Subdirectory | domain/threads/ domain layer regression tests ([S7]) |
| `agent-adapter.test.ts` | Test | getAdapter/Capability/tool-names contract |
| `agent-adapter-claude.test.ts` | Test | Claude buildSpawnArgs/hooks/summarizer |
| `agent-adapter-pi.test.ts` | Test | PI framing/spawn-args/bootstrap/close |
| `agent-adapter-pi-event-parser.test.ts` | Test | piRpcLineToNormalized full coverage |
| `agent-adapter-pi-streaming.test.ts` | Test | PI assistant_delta streaming: per-delta emission, blockId shared with the finalizing assistant_text, CORTEX_STREAM_DELTAS kill switch |
| `agent-adapter-pi-hook-bridge.test.ts` | Test | PI hook-bridge toClaude/normalize |
| `agent-adapter-pi-mcp-bridge.test.ts` | Test | PI mcp-bridge content mapping and integration |
| `agent-adapter-pi-tool-shims.test.ts` | Test | PI tool-shims + extension_ui |
| `pi-cost-record.test.ts` | Test | PI agent_end produces cost integration |
| `run-with-adapter.test.ts` | Test | mode-manager event to callback drive + thread-turn inline bg-continuation wait (threadId gate: thread holds+merges, interactive resolves immediately) |
| `facade-plugin-gating.test.ts` | Test | filterChannelScopedPlugins: cortex-feishu plugin gated to feishu: channels (exact basename match) |
| `app.test.ts` | Test | Startup DM + scheduled success flow |
| `auto-compound.test.ts` | Test | Compound skip conditions and concatenation |
| `codex-bridge.test.ts` | Test | Codex MCP config tsx loader |
| `codex-event-parser.test.ts` | Test | codexEventToNormalized pure function |
| `command-handlers.test.ts` | Test | !cancel/!cost/!status/!schedule/!nvtop |
| `restart-command.test.ts` | Test | `triggerServerRestart` daemon-alive/missing-pid/dead-process branches + `!restart` routing posts a reply |
| `cortex-run-cli-dispatch.test.ts` | Test | cortex-run.ts CLI dispatch (sendCommand pathway) |
| `daemon.test.ts` | Test | Import has no side effects |
| `core/status-format.test.ts` | Test | buildThreadStatusMessage: task-info lead format / thread-only fallback / text+thread-id truncation / turn count |
| `core/singleton-lock.test.ts` | Test | tryAcquireSingletonLock/releaseSingletonLock/isProcessAlive against a temp pidfile (fresh/live-holder/stale/corrupt) |
| `core/auth.test.ts` | Test | core/auth.ts: timingSafeEqualStr (fail-closed) + ensureAuthTokens generation/idempotency/partial/append-to-.env |
| `core/bg-held-sessions.test.ts` | Test | BgHeldSessions registry (web bg-hold snapshot): mark on running+backgroundRunning, clear on seal / plain turn start / turn end, re-arm keeps held, per-session independence, singleton; + the Stop-path additions — channel index (`sessionsOnChannel`) and single-fire `setAbort`/`abort` with handles dropped on seal and on clear |
| `webhook-auth.test.ts` | Test | webhook bearer-token gate: 401 without/with-wrong token, pass with token, /webhook/github exempt (HMAC) |
| `project-store.test.ts` | Test | ProjectStore list/get/exists/getDefault/resolveFromMessage + scaffolding + cache refresh |
| `dispatch-utils.test.ts` | Test | Task dispatch commands and env injection |
| `execution-lock-release.test.ts` | Test | Auto lock-release on terminal execution transitions (complete/fail/cancel/stale) |
| `task-dispatcher.test.ts` | Test | Pre-filter + schedule guard + dispatch gate (incl. per-task template-profile rate-limit filtering) |
| `task-store.test.ts` | Test | runExclusive serialization and error propagation (verified through re-export path) |
| `store/task-repo.test.ts` | Test | TaskRepo concurrent add, state serialization, flush draining |
| `store/plugin-sync.test.ts` | Test | syncManagedPlugins/parsePluginVersion: new-plugin deploy / version-newer skill refresh / legacy-unversioned adoption / same-version no-write / no-downgrade / unversioned-default skip / user-added-file preservation |
| `gpu-slot-scheduling.test.ts` | Test | Per-GPU slot scheduling |
| `task-parser.test.ts` | Test | Task CLI read path query/lint/health |
| `task-lint.test.ts` | Test | lintTasks unknown-template error unit coverage |
| `task-lifecycle.test.ts` | Test | Task CLI write path lifecycle |
| `task-id-utils.test.ts` | Test | Hash generation/backfill/collision check |
| `task-state.test.ts` | Test | Claim/pause/approve state transitions |
| `task-completion.test.ts` | Test | complete/uncomplete + done-when validation |
| `task-mutations.test.ts` | Test | addTask/batchEdit/decompose |
| `thread-manager.test.ts` | Test | resolveSystemVars/evaluateTransitions |
| `thread-runner.test.ts` | Test | buildThreadSummary/initThreadContext |
| `threads/thread-transcript.test.ts` | Test | createStepTranscriptRecorder: incremental in-order appends keyed by the track sessionId (summarized tool input), shared ts between history entry and live publish (web de-dup contract), synchronous emission-order publishes under slow writes, settle() never rejects + failed append skipped |
| `threads/thread-live-step-ids.test.ts` | Test | beginStepSession (fresh mint persisted + resume null / legacy migration keeps one id as both keys / settled slot resumes backendSessionId / non-persist fresh per step / thread.step.started) + recordStepResult track/backend decoupling (step + persist-slot fields, thread.step.finished truncation) + thread.created/completed/failed(+cancel→failed) publishes + resolveTargetResumeId (slot/step, new/legacy forms, never a track id) |
| `conversation-runner.test.ts` | Test | buildConversationPrompt golden-prompt fidelity vs legacy default-thread prompt + `[Session Project]` block injection (project opt) + resolveConversationProject gating (web-only / fresh-only / non-general / unknown-id) |
| `user-context.test.ts` | Test | loadUserContext env-gate/file-present/absent + USER.md injected into buildConversationPrompt, never into thread steps |
| `thread-abort.test.ts` | Test | DR-0015 control plane: peekPendingControl/clearPendingControl(abort)/abortThread + THREAD_PROTOCOL_PREAMBLE (tool-based) + regression (artifact "[ABORT]" prose must NOT trigger) |
| `thread-tree.test.ts` | Test | DR-0014 tree: getRootThreadId/getTreeThreads/summarizeTree/checkSpawnGuards/buildThreadTree/registerChildSpawn |
| `thread-wait-children.test.ts` | Test | DR-0014/0015 suspend: pendingControl(wait)/tryEnterWaiting/detectSplitFromControl + restart/cleanup semantics |
| `webhook-thread-control.test.ts` | Test | DR-0015: /webhook/thread-op `control` action — abort/split/wait validation + pendingControl persistence + reject-second/terminal/unknown |
| `manager-qa.test.ts` | Test | DR-0016 up-ask channel: askManager manager-resolution (thread-parent + task-tree) / deliver→resume / top-of-tree origin-session wake (origin agent answers via answer_subtask) + human backstop (tryAnswerFromHuman) / submitAnswer + getAnswer round-trip / buildQuestionNotice / buildOriginSessionNotice |
| `webhook-manager-qa.test.ts` | Test | DR-0016: /webhook/manager-qa `ask`/`poll`/`answer` HTTP round-trip + unknown thread/question/action validation |
| `thread-callback-tree.test.ts` | Test | DR-0014 re-entry: notifyThreadParent idempotency+resume / recoverWaitingThreads / buildChildResultNotice |
| `thread-contract.test.ts` | Test | DR-0014 contracts: buildContractPrompt/buildMissionChain/checkContractBudget |
| `task-parent-split.test.ts` | Test | DR-0014 task tree: Task.parent round-trip / decompose keepParent / lint parent rules / processSplitOutcome |
| `thread-wait-tasks.test.ts` | Test | DR-0014 §8: tryEnterWaiting task-children snapshot / restart preservation / cleanup orphan detection |
| `task-node-ledger.test.ts` | Test | DR-0017 W1: core/task-node path helpers + ensureTaskArtifact never-truncate + acceptance-ledger verdict lifecycle (pending re-delivers / accepted blocks / rejected re-opens with rework_round) |
| `manager-task-artifact.test.ts` | Test | DR-0017 W1: createThread task-keyed artifact for manager-template dispatch threads (placement / pre-existing checkpoint preserved / non-manager & ad-hoc unaffected / cleanupWorkspace spares it) |
| `task-verdict-cli.test.ts` | Test | DR-0017: `cortex-task verdict` subcommand — accepted/rejected recording + rework_round, --child/--verdict/parent validation, help entry; atomicWriteSync tripwire (real-home refusal + tmp write) |
| `manager-rotation.test.ts` | Test | DR-0017 W3: step-count rotation — threshold/base semantics, non-manager exempt, slot session cleared, rehydration notice (artifact path + cortex-task tree + ledger pendings, accepted excluded), resume-path integration (rotate-then-resume / below-threshold untouched) |
| `thread-wait-checkpoint-gate.test.ts` | Test | DR-0017 W2: checkpoint gate — createThread/recordStepResult baseline recording / isArtifactUnchangedSinceStepStart fail-open cases / webhook wait rejected-with-hint vs accepted-after-edit / abort exempt / legacy no-baseline passes |
| `thread-ledger-dedupe.test.ts` | Test | DR-0017 W1: notifyTaskParentThreads × acceptance-ledger — pending ledger entry on delivery / accepted child not re-delivered to a new incarnation (but un-waited + resume) / un-verdicted re-delivers / same-incarnation dedupe intact / no-taskId legacy path |
| `thread-task-bridge.test.ts` | Test | DR-0014 §8: notifyTaskParentThreads / reconcileWaitingTasks race closer / recovery keeps open task children |
| `thread-wait-deadlock.test.ts` | Test | Wait-set deadlock guard: computeStuckWaitSet (direct/transitive blocked deps, runnable/in-flight/terminal/missing escapes, cycle termination) + buildDeadlockNotice + integration (blocked child among stuck siblings wakes with deadlock notice; persistent stuckWakeKey dedup across restart; distinct stall re-wakes; sweep covers pre-suspend blocked deps; normal resume clears marker) |
| `claim-recovery.test.ts` | Test | recoverOrphanedClaims policy: dispatcher-claim orphan unclaimed / manual claims + done/pending/blocked skipped / waiting+rate_limited thread protects claim, failed does not / remote-tracked skipped / fail-soft sweep |
| `thread-resume-task-loop.test.ts` | Test | 2026-06-29 fix: closeResumedTaskLoop re-emits task.completed/task.blocked when a task-dispatch thread re-enters via a resume path (rate-limit or DR-0014) that bypasses the dispatch cycle — terminal+done→completed, terminal+blocked→blocked, no-op for non-terminal / non-dispatch / still-open; + sweepWaitingManagers periodic disk-driven backstop (delivers an already-done child the fast paths missed and resumes; keeps waiting on still-open) |
| `task-origin-wake.test.ts` | Test | Problem 1: notifyTaskOriginSession wakes the origin channel on task complete/blocked; defers to thread-parent path; single-fire |
| `task-abort-outcome.test.ts` | Test | DR-0014 §8: processAbortOutcome worker escalation (aborted thread → block task; fixes aborted-as-success bug) |
| `thread-statusmsg-seal.test.ts` | Test | DR-0014 §8: sealSuspendedStatusMsg refreshes the stale "suspended" status message after resume |
| `thread-resume-statusmsg.test.ts` | Test | buildResumeOptions restores statusMsg from metadata.statusMsgRef (2026-06-23 fix: rate-limit/suspended resume kept updating the live status message instead of freezing at "Paused — rate limited") |
| `thread-stages.test.ts` | Test | Thread step stage progression |
| `thread-coder-review.e2e.test.ts` | Test | coder/reviewer two-stage e2e |
| `thread-extra-hooks.test.ts` | Test | per-call extraHooks serial injection |
| `interaction-handlers.test.ts` | Test | handleModalSubmit -> bus.publish('ask-user.answered') BLK-1 regression |
| `orch/interaction-records.test.ts` | Test | InteractionRecords entity service (web-interactions-redesign): create persists+publishes session.interaction pending / resolve first-writer-wins (resolved→already-resolved) / unknown-after-restart / getPendingByChannel payload+TTL scoping / resolvePendingByChannel (!new cancel) / uninitialised fail-soft |
| `orch/hook-bridge-subscribers-web.test.ts` | Test | web: conduit branch creates interaction entities (plan-approval with FULL planContent snapshot + planApprovals live-resolver kept; ask-user normalized questions); non-web channels create none |
| `domain/ui-service/mutate-sessions-interactions.test.ts` | Test | handleAnswerQuestion/handleRespondPlan three-way outcome: resolved/already-resolved → ok{outcome}, not-found → err, invalid-args, not-available |
| `platform-mock-adapter.test.ts` | Test | MockAdapter 17 method coverage |
| `output-stream.test.ts` | Test | SlackOutputStream/FeishuOutputStream/MockOutputStream unit tests (46 cases) |
| `feishu-client.test.ts` | Test | stderrLogger routes all lark SDK logs to stderr (MCP stdout protocol safety) |
| `composite-adapter.test.ts` | Test | CompositeAdapter fan-out routing, interactive-reply isolation, capability merging, extractTuiAdapter, FanOutOutputStream, project-report all-primary fan-out + per-platform DM fallback (18 cases) |
| `platform/ui-http-lazy-load.test.ts` | Test | Runtime guard (plan §11 single-package merge): with `CORTEX_UI_HTTP` unset, loading + invoking the gate (`entry/ui-http-gate.ts`) must NOT eager-load `@trpc/server` or `jose`. A child process registers a `module.register` resolve hook (`ui-http-lazy-hooks.mjs`, driven by `ui-http-lazy-driver.mjs`) that records resolved specifiers; the positive control (`LAZY_MODE=load`) proves the hook records trpc/jose when the transport IS loaded. Replaces the old `no-trpc-dep.test.ts` (now void — trpc/jose are legitimate core deps) |
| `platform/ui-http-app-router.test.ts` | Test | tRPC AppRouter routing (every query/mutation → correct scope/op, Result unwrap) + Err→TRPCError mapping + subscription passthrough over a FAKE UiService (migrated from the ui-server package) |
| `platform/ui-http-server.test.ts` | Test | Transport-host: 127.0.0.1 bind, x-cortex-token 401 gate, HTTP query roundtrip, SSE one-event, SPA stub (present/absent/traversal/malformed-URL→400), clean close(), CORS allow-list — FAKE tRPC router, ephemeral port |
| `platform/ui-http-access-jwt.test.ts` | Test | Dual-path auth gate: valid x-cortex-token; valid RS256 + ES256 Cloudflare Access JWT; bad-sig/wrong-aud/wrong-iss/expired/no-creds → 401; `accessVerifierFromEnv` secure-degrade — synthetic jose keypairs + local JWKS |
| `platform/ui-http-wiring.test.ts` | Test | `startUiHttpServer` wiring: env gate (null when off), default port 3004, token 401, HTTP query/mutate roundtrip, SSE, close, CORS via `CORTEX_UI_CORS_ORIGINS`, frontend OTA routes mounted (manifest/bundle reachable + token-gated 401) — FAKE UiService |
| `platform/zip-writer.test.ts` | Test | Dependency-free ZIP encoder (desktop OTA unit A): crc32 known-answer vectors, LFH/CDH/EOCD signatures, per-entry DEFLATE round-trip, entry count, determinism, name-sort, empty-file/nested-path |
| `platform/ui-ota.test.ts` | Test | `createOtaRoutes` (desktop OTA unit A): no-SPA→no routes, manifest shape (version/sha256/size/url) + content-type, bundle application/zip matching manifest size+sha256, content-addressed version (stable/changes), 405 method guard |
| `platform/ui-http-same-origin-spa.test.ts` | Test | Single port serves index.html (from `CORTEX_UI_SPA_DIR` default-spaDir resolution) AND the token-gated `/trpc` — FAKE UiService |
| `message-router.test.ts` | Test | Message routing branches |
| `session.test.ts` | Test | session.ts backend:channel CRUD |
| `session-hooks-profile-resolution.test.ts` | Test | resolveOnNewProfileName priority (registry > ledger) — regression for "Invalid signature in thinking block" caused by thread vs user session profile mismatch |
| `domain/agents/profile-thinking.test.ts` | Test | Profile `thinking` field: per-backend value validation (claude --effort / pi --thinking / codex unsupported), resolveProfileConfig propagation (no fallback inheritance), buildSpawnConfig passthrough |
| `session-hooks-inject-isolation.test.ts` | Test | onNewInjectSessionKey isolation + runHookInjection: onNew pre-close turn runs on an isolated pool key (≠ channel) and is closed after (incl. on failure); onMessageEnd stays on the channel live slot — regression for the `!new` + onNew memory-hook session-resurrection race |
| `client-manager.test.ts` | Test | client-manager handshake/sendCommand + WS bearer-token verifyClient (reject no/wrong token, accept valid) + `buildRemoteSpawnCommand` cmd.exe-wrap + token-injection + retry-on-spawn-failure regressions + `buildRemoteInstallCommand` (dev hot-reload install cmd: default `npm install -g <tgz>` / `{tgz}` placeholder substitution / no-placeholder append / blank-fallback) |
| `machines-query.test.ts` | Test | machines.list handler: online/offline/liveRuns/windows-os/empty-registry (5 cases) |
| `domain/ui-service/mutate-sessions-markread.test.ts` | Test | sessions.markRead handler: stamps sessionStore.markRead + ok; unknown session → not-found, no write |
| `domain/ui-service/query-skills.test.ts` | Test | skills.list handler: returns empty array / user-owned group (plugin=null) with sorted skill names / plugin groups / independent copy guarantee (4 cases; uses clearSkillScanCache to bust 60s in-process cache) |
| `client-hot-reload.test.ts` | Test | `updateClientReleaseLocal` (release-mode local same-machine client update): already-at-latest no-op, kill→npmUpdate→restart ordering, unknown installed version, npmUpdate-throws error capture, restart-fail partial |
| `cortex-run-callback-handler.test.ts` | Test | task-callback handler (DR-0011 §4.4): idempotency, skipVerify, ghost callback, blockTask note |
| `mcp-server.test.ts` | Test | Import safety and startup hints |
| `domain/mcp/tools-registration.test.ts` | Test | All MCP tool names registered (ext: 9; core: 6 remote_* + current_time + thread_abort/split/wait + task_status/result/list) |
| `domain/mcp/time-tool.test.ts` | Test | current_time handler: valid tz payload, default tz, invalid-tz error |
| `domain/mcp/task-monitor-tool.test.ts` | Test | task_status/task_result/task_list handlers read TASKS.yaml (status/terminal/parent filter) |
| `domain/mcp/server.test.ts` | Test | Server module loads without Slack env + no wildcard registration ([S10-A]) |
| `domain/mcp/cortex-schedule.test.ts` | Test | resolveTargetShorthand: __current__ to concrete ID 12-way resolution and error paths |
| `scheduled-target-dispatch.test.ts` | Test | planScheduledDispatch: fresh/channel/session/thread + fallback decision tree |
| `claude-md-scanner.test.ts` | Test | scanClaudeMDChain ancestor scanning |
| `claude-md-injector.test.ts` | Test | ClaudeMDInjector dedup and caching |
| `mode-manager.test.ts` | Test | Per-request mode URL routing + per-mode ANTHROPIC_API_KEY retention (plan deletes for OAuth; non-plan keeps key/placeholder so CC starts without login) + config.js import is side-effect free (no env mutation in CLI processes) |
| `gateway-per-request-mode.test.ts` | Test | Gateway /m/{mode}/ prefix and token |
| `memory-index-regen.test.ts` | Test | Index rebuild lifecycle partitioning |
| `session-activity-tracker.test.ts` | Test | sideband diff + inline marker fallback |
| `recommendation-extractor.test.ts` | Test | Recommendation extraction and dedup |
| `skill-scanner.test.ts` | Test | Plugin skill discovery and namespacing |
| `schedule-cli.test.ts` | Test | scheduler API + schedule CLI |
| `slack-message.test.ts` | Test | mergeSubstantialOutput merging |
| `slack-adapter-throttle.test.ts` | Test | SlackAdapter.updateMessage per-message throttle + 429 retry-after |
| `status-helpers.test.ts` | Test | writeStatus/sealStatus serialization + status button payloads (cancel/newq env-gate) |
| `tool-trace.test.ts` | Test | Tool lines merge via OutputStream mutable region |
| `update-prompt.test.ts` | Test | 8-path coverage: 3-button registration, click paths, stale, re-prompt, timeout ([DR-0013]) |
| `update-state.test.ts` | Test | update-state.ts round-trip / missing-file / malformed-json coverage ([DR-0013]) |
| `server-update-check.test.ts` | Test | compareCalVer (4 CalVer + suffix + cross-digit), isUpdateDevMode (3 cases), checkServerUpdate (11 branches, all deps injectable) ([DR-0013]) |
| `store/execution-repo.test.ts` | Test | ExecutionRepo concurrent mutate, index consistency, flush draining (Pattern B) |
| `store/schedule-repo.test.ts` | Test | ScheduleRepo concurrent mutate, flush ordering, CRUD, rateLimitThrottle |
| `store/cost-repo.test.ts` | Test | CostRepo concurrent recordEntry, 90-day prune, flush ordering, budget roundtrip |
| `store/profile-repo.test.ts` | Test | ProfileRepo concurrent mutate, flush ordering, readSync cache, save/read roundtrip |
| `store/session-registry-repo.test.ts` | Test | SessionRegistryRepo concurrent mutate, flush ordering, cache consistency (Pattern A) |
| `gateway-manager.test.ts` | Test | Gateway port conflict reuse |
| `disk-monitor.test.ts` | Test | shouldAlert decision coverage |
| `rate-limit-throttle.test.ts` | Test | Throttle activation/cross-restart/beforeRun + onResume hook (timer-clear / expired-recovery / active-recovery / backward-compat) |
| `resume-registry.test.ts` | Test | Rate-limit resume registry: dedupe (direct→channel, thread→threadId), drain, persistence roundtrip/hydrate |
| `orch/resume-dispatcher.test.ts` | Test | Auto-resume dispatch: direct→route (serial, channelBusy skip) / thread→continueThread (concurrent, only skip on live direct session; multiple threads same channel all resume) + settleResumedThread fires once AFTER each resumed run returns (seals the frozen status message; never fires for guard-skipped threads) + guards (stale/missing/terminal) + CORTEX_AUTO_RESUME flag/drain + busy-gate bracket (2026-07-09 regression: track +1 sync at fire / -1 after run AND settle, leak-free on rejection, no track for guard-skipped or direct entries, balanced across concurrent resumes) |
| `orch/lifecycle-rate-limit.test.ts` | Test | handleAgentError thrown-rate-limit pause branch: throttled + rate-limit error + userMessage → recordResume(direct) + seal, no error post; falls through to normal error path when not throttled / no userMessage / non-rate-limit error |
| `scheduler-precheck.test.ts` | Test | preCheck exit code and env |
| `cli-utils.test.ts` | Test | formatHelp/formatError |
| `domain/system/doctor.test.ts` | Test | doctor engine: runDiagnostics section/check statuses + gateway in-use-vs-idle logic + applySafeFixes idempotent actuation |
| `entry/doctor-cli.test.ts` | Test | `cortex doctor` CLI: help/text/json output, exit-code mapping, --fix re-run |
| `template-resolver.test.ts` | Test | Template variables/block/conditional |
| `threads/domain-threads-smoke.test.ts` | Test | domain/threads/ import smoke: parseTarget / resolveStageName / resolveSystemVars / THREAD_PROTOCOL_PREAMBLE |
| `threads/resolve-template-profiles.test.ts` | Test | resolveTemplateProfiles: hardcoded profiles, `__active__` mapping, dedup, unknown template fail-open |
| `threads/shell-template.test.ts` | Test | DR-0017 D6 Phase 2.5: isShellBinding + generic expandShell interpolation (golden equivalence for doc/execute, structural for analyst/surveyor/writer), maxTotalSteps override, default description, all 7 validation error branches |
| `threads/thread-config-dir.test.ts` | Test | DR-0017 D6 Phase 2.5: loadConfig directory form — golden equivalence (dir ≡ same-content single file), dir-over-file precedence, fail-soft (name≠filename / broken or unknown shell binding), migrateThreadTemplatesToDir (split + `.migrated-bak` + idempotent), mergeThreadTemplates per-file copy-if-missing |
| `threads/template-merge.test.ts` | Test | DR-0017 D6 Phase 2.5: mergeThreadTemplates directory form — per-file copy-if-missing (defaults dir → user dir), preserves existing user files, no-op when complete / when defaults dir absent |
| `threads/thread-rate-limit-resume.test.ts` | Test | rate-limit thread pause/resume contract: recordStepOutcome records resume + pauses (rate_limited) without advancing the step; markThreadRateLimited; buildThreadSummary paused headline; markRunningAsFailedOnStartup/cleanup treatment of rate_limited |
| `module-loader.ts` | Utility | ESM fresh import + root path helper |
