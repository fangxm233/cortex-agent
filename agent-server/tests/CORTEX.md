Please update me when files in this folder change

Regression test suite for agent-server: agent adapters, task and thread orchestration, platform adapters, and stores.
Files here cover cross-cutting server behaviour; subdirectories group tests by the source layer they exercise.

| filename | role | function |
|---|---|---|
| _test-home.ts | setup | isolates the data home per test process |
| _vitest-setup.ts | setup | isolates the data home per test file |
| agent-adapter/ | subdir | backend adapter and event normalizer tests |
| agent-adapter-claude.test.ts | test | Claude CLI, registry hook parity, and compact |
| agent-adapter-pi-agent-dir.test.ts | test | PI provider config and auth dir setup |
| agent-adapter-pi-event-parser.test.ts | test | PI RPC to normalized event translation |
| agent-adapter-pi-hook-bridge.test.ts | test | PI hook lifecycle and CORTEX injection |
| agent-adapter-pi-hook-registry.test.ts | test | PI registry mapping and data-driven dispatch |
| agent-adapter-pi-mcp-bridge.test.ts | test | PI MCP surfaces, isolation and retry policy |
| agent-adapter-pi-streaming.test.ts | test | PI assistant delta streaming emission |
| agent-adapter-pi-subagent.test.ts | test | PI prompt roles, schema, isolation and usage |
| agent-adapter-pi-tool-shims.test.ts | test | PI shims, web tools and data-image stripping |
| agent-adapter-pi-web-search.test.ts | test | PI WebSearch dispatch, terminal and SSE decoding |
| agent-adapter-pi.test.ts | test | PI framing, spawn, context and compact |
| agent-adapter.test.ts | test | adapter dispatch, capability and tool names |
| agent-retry-classification.test.ts | test | retry classification and auto-resume notices |
| app.test.ts | test | startup DM notification behaviour |
| auto-compound.test.ts | test | compound trigger gating and output merge |
| claim-recovery.test.ts | test | orphaned task claim recovery policy |
| cli-utils.test.ts | test | shared CLI help and error rendering |
| cli.test.ts | test | cortex CLI help text and subcommand routing |
| client-hot-reload.test.ts | test | local cortex-client release update flow |
| client-manager.test.ts | test | remote client handshake, auth and commands |
| command-handlers.test.ts | test | !cost, !cancel, !status and other bang commands |
| command-interactive.test.ts | test | interactive command router and handlers |
| composite-adapter-noop-fallback.test.ts | test | unknown conduit operations stay no-op |
| conversation-runner.test.ts | test | thread-free conversation prompt assembly |
| core/ | subdir | core primitives, auth and generator tests |
| cortex-client-config.test.ts | test | client server URL and access header rules |
| cortex-md-injector-hook.test.ts | test | CORTEX.md hook injection subprocess |
| cortex-md-injector.test.ts | test | CORTEX.md injection cache and dedup |
| cortex-md-scanner.test.ts | test | CORTEX.md ancestor chain scanning |
| cortex-run-callback-handler.test.ts | test | task callback idempotency and ghost cases |
| cortex-run-cli-dispatch.test.ts | test | cortex-run CLI flags and dispatch |
| daemon.test.ts | test | daemon import has no side effects |
| disk-monitor.test.ts | test | disk alert decisions and byte formatting |
| dispatch-utils.test.ts | test | device registry, task id and session names |
| domain/ | subdir | domain service, MCP tool and UI-service tests |
| entry/ | subdir | CLI entry-point subcommand tests |
| events/ | subdir | event bus tests |
| execution-lock-release.test.ts | test | task lock release on execution end |
| execution-log-tailer.test.ts | test | live execution log tailing and refcounts |
| facade-compact.test.ts | test | manual context compact via agent facade |
| facade-plugin-gating.test.ts | test | channel-scoped plugin directory filtering |
| facade.test.ts | test | provider identity and exact pre-flight gates |
| feishu-adapter.test.ts | test | Feishu message, card and reaction mapping |
| feishu-client.test.ts | test | Feishu SDK logs stay off protocol stdout |
| feishu-device-login.test.ts | test | Feishu device authorization login flow |
| feishu-login-cli.test.ts | test | Feishu login CLI dispatch and gating |
| feishu-output-stream.test.ts | test | Feishu output stream coalescing |
| feishu-user-auth.test.ts | test | Feishu user token exchange and refresh |
| feishu-user-mode.test.ts | test | Feishu user-identity token injection |
| gateway-manager.test.ts | test | gateway port conflict reuse |
| gateway-per-request-mode.test.ts | test | gateway per-request mode prefix and cost |
| gpu-slot-scheduling.test.ts | test | per-GPU slot occupancy and scheduling |
| hook-bridge.test.ts | test | hook request publish and resolve chain |
| init.test.ts | test | cortex init path, env and MCP config generation |
| integration-init-startup.test.ts | e2e | init, startup, and config regeneration |
| interaction-handlers.test.ts | test | modal submit publishes answered event |
| lang-command.test.ts | test | language switch command and persistence |
| machines-query.test.ts | test | machines list online/offline projection |
| manager-qa.test.ts | test | manager ask/answer channel resolution |
| manager-rotation.test.ts | test | manager session rotation and rehydration |
| manager-task-artifact.test.ts | test | task-keyed manager artifact placement |
| memory-index-regen.test.ts | test | memory index rebuild lifecycle sections |
| message-router.test.ts | test | message routing branches and edit handoff |
| mode-manager.test.ts | test | per-request mode routing and API key policy |
| module-loader.ts | helper | fresh ESM import and root path helpers |
| orch/ | subdir | orchestration runtime and session flow tests |
| orchestration/ | subdir | session compact, rewind and coalescer tests |
| output-stream.test.ts | test | Slack, Feishu and mock output streams |
| pi-cost-record.test.ts | test | PI per-run cost recording end to end |
| platform/ | subdir | platform adapters and UI HTTP transport tests |
| platform-mock-adapter.test.ts | test | mock adapter platform contract coverage |
| preferences.test.ts | test | operator display preferences store |
| project-store.test.ts | test | project lookup, scaffolding and cache |
| rate-limit-throttle.test.ts | test | provider windows, gates and clear callbacks |
| rate-limiter.test.ts | test | token bucket rate limiter behaviour |
| recommendation-extractor.test.ts | test | recommendation extraction and dedup |
| restart-command.test.ts | test | server restart trigger and command route |
| resume-registry.test.ts | test | provider-ready drains and waiting counts |
| run-with-adapter.test.ts | test | normalized event dispatch and callbacks |
| schedule-cli.test.ts | test | schedule API and CLI mutations |
| scheduled-runner-jobs.test.ts | test | scheduled job dispatch and isolation |
| scheduled-target-dispatch.test.ts | test | scheduled target and fallback decisions |
| scheduler-precheck.test.ts | test | preCheck exit codes and env passing |
| server-update-check.test.ts | test | CalVer compare and server update check |
| session-activity-tracker.test.ts | test | path-only tool activity logging hook |
| session-backup.test.ts | test | PI session file backup and restore |
| session-hooks-inject-isolation.test.ts | test | onNew hook injection session isolation |
| session-hooks-profile-resolution.test.ts | test | onNew hook profile lookup priority |
| session.test.ts | test | session CRUD and legacy key migration |
| skill-scanner.test.ts | test | plugin skill discovery and namespacing |
| slack-adapter-classification.test.ts | test | Slack subtype to message kind mapping |
| slack-adapter-prefix.test.ts | test | Slack conduit prefix and queue markers |
| slack-adapter-throttle.test.ts | test | Slack update throttle and 429 retry |
| slack-message.test.ts | test | substantial output merge logic |
| slack-output-stream.test.ts | test | Slack output stream emit, flush and tail |
| status-helpers.test.ts | test | status message serialization and buttons |
| store/ | subdir | JSON repository and store concurrency tests |
| task-abort-outcome.test.ts | test | aborted thread escalates to blocked task |
| task-completion.test.ts | test | task complete and uncomplete API |
| task-dispatcher.test.ts | test | dispatch pre-filter, guards and gating |
| task-id-utils.test.ts | test | task hash generation, backfill and checks |
| task-lifecycle.test.ts | test | task CLI write-path lifecycle |
| task-lint.test.ts | test | unknown template lint error gating |
| task-mutations.test.ts | test | task add, batch edit and decompose |
| task-node-ledger.test.ts | test | task artifact paths and acceptance ledger |
| task-origin-wake.test.ts | test | origin session wake on task terminal |
| task-parent-split.test.ts | test | task parent field and split outcome |
| task-parser.test.ts | test | task CLI read path query, lint and health |
| task-state.test.ts | test | claim, pause, approve, block transitions |
| task-store.test.ts | test | task store exclusive mutex serialization |
| task-verdict-cli.test.ts | test | task verdict subcommand recording |
| template-resolver.test.ts | test | prompt template vars, blocks, conditionals |
| thread-abort.test.ts | test | thread abort control plane state |
| thread-callback-tree.test.ts | test | child to parent thread result delivery |
| thread-coder-review.e2e.test.ts | e2e | coder and reviewer stage transition graph |
| thread-contract.test.ts | test | delegation contracts and budget breaker |
| thread-extra-hooks.test.ts | test | per-call extra hook serial injection |
| thread-ledger-dedupe.test.ts | test | child result delivery dedupe across runs |
| thread-manager.test.ts | test | thread prompt variables and transitions |
| thread-resume-statusmsg.test.ts | test | status message restore on thread resume |
| thread-resume-task-loop.test.ts | test | task events re-emitted on resumed threads |
| thread-runner.test.ts | test | thread runner lifecycle and wait control |
| thread-stages.test.ts | test | stage parsing and step prompt building |
| thread-statusmsg-seal.test.ts | test | stale suspended status message refresh |
| thread-task-bridge.test.ts | test | task terminal events wake waiting threads |
| thread-tree.test.ts | test | thread tree traversal and spawn guards |
| thread-wait-checkpoint-gate.test.ts | test | wait rejected without an artifact edit |
| thread-wait-children.test.ts | test | parent suspension on child threads |
| thread-wait-deadlock.test.ts | test | stuck wait-set detection and wake |
| thread-wait-tasks.test.ts | test | manager suspension on child tasks |
| threads/ | subdir | thread config, template and transcript tests |
| tool-trace.test.ts | test | tool trace tail merge and env toggle |
| tui/ | subdir | TUI rendering, hooks and protocol tests |
| ui-service-compact.test.ts | test | session compact mutation outcome mapping |
| update-prompt-slack.test.ts | test | Slack update prompt buttons and timeout |
| update-prompt.test.ts | test | update prompt buttons, stale and timeout |
| update-state.test.ts | test | update state file round-trip and errors |
| user-context.test.ts | test | USER.md injection into conversations only |
| webhook-auth.test.ts | test | webhook bearer token gate |
| webhook-manager-qa.test.ts | test | manager Q&A webhook ask, poll, answer |
| webhook-thread-control.test.ts | test | thread control webhook validation |
