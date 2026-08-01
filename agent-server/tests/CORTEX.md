Please update me when files in this folder change

Regression test suite for agent-server: agent adapters, task and thread orchestration, platform adapters, and stores.
Files here cover cross-cutting server behaviour; subdirectories group tests by the source layer they exercise.

| filename | role | function |
|---|---|---|
| _global-setup.ts | setup | allocates the run-scoped temp-home root and removes it after all workers finish |
| _shared-pool-manifest.ts | setup | lists tests safe for shared non-isolated forks |
| _test-home-root.ts | setup | Allocates test homes and sweeps stale leftovers |
| _test-home.ts | setup | isolates the data home per test process |
| _vitest-setup.ts | setup | isolates the data home per test file |
| agent-adapter/ | subdir | backend adapter and event normalizer tests |
| agent-adapter-claude.test.ts | test | Claude CLI, hooks, compact and settings |
| agent-adapter-pi-agent-dir.test.ts | test | PI provider config and auth dir setup |
| agent-adapter-pi-event-parser.test.ts | test | PI RPC events without invented model metadata |
| agent-adapter-pi-hook-bridge.test.ts | test | PI hook lifecycle and CORTEX injection |
| agent-adapter-pi-hook-registry.test.ts | test | PI hook contracts, interaction and task guards |
| agent-adapter-pi-mcp-bridge.test.ts | test | PI MCP surfaces, isolation and retry policy |
| agent-adapter-pi-streaming.test.ts | test | PI delta streaming with settings reset |
| agent-adapter-pi-subagent.test.ts | test | PI prompt roles, schema, isolation and usage |
| agent-adapter-pi-tool-shims.test.ts | test | PI shims, web tools and data-image stripping |
| agent-adapter-pi-web-search.test.ts | test | PI WebSearch dispatch, terminal and SSE decoding |
| agent-adapter-pi.test.ts | test | PI resume identity, cache, events and context |
| agent-adapter.test.ts | test | adapter dispatch, PI path wiring and capabilities |
| agent-retry-classification.test.ts | test | Retry, auth lifecycle and outage classification |
| app.test.ts | test | startup DM notification behaviour |
| auth-events.test.ts | test | auth case, boundary, privacy and recovery events |
| auth-watch.test.ts | test | auth notification routing, debounce and recovery |
| auto-compound.test.ts | test | compound trigger gating and output merge |
| claim-recovery.test.ts | test | Generation-fenced orphan claim recovery |
| cli-utils.test.ts | test | shared CLI help and error rendering |
| cli.test.ts | test | cortex CLI routing, output framing and size limit |
| client-hot-reload.test.ts | test | local cortex-client release update flow |
| client-manager.test.ts | test | client lifecycle hooks, auth and commands |
| command-handlers.test.ts | test | bang command routing including authentication |
| command-interactive.test.ts | test | interactive command router and handlers |
| composite-adapter-noop-fallback.test.ts | test | unknown conduit operations stay no-op |
| conversation-runner.test.ts | test | thread-free conversation prompt assembly |
| core/ | subdir | core primitives, auth and generator tests |
| cortex-client-config.test.ts | test | client server URL and access header rules |
| cortex-md-injector-hook.test.ts | test | CORTEX.md hook injection subprocess |
| cortex-md-injector.test.ts | test | CORTEX.md injection cache and dedup |
| cortex-md-scanner.test.ts | test | CORTEX.md ancestor chain scanning |
| cortex-run-callback-handler.test.ts | test | Remote callback generation and state-first fencing |
| cortex-run-cli-dispatch.test.ts | test | Cortex-run parsing and unowned linkage rejection |
| daemon.test.ts | test | daemon imports, rebuild order and abort notice |
| disk-monitor.test.ts | test | disk path, toggle, alerts and byte formatting |
| dispatch-utils.test.ts | test | device registry, task id and session names |
| domain/ | subdir | domain service, MCP tool and UI-service tests |
| entry/ | subdir | Runtime wiring and CLI entry-point tests |
| events/ | subdir | event bus tests |
| execution-lock-release.test.ts | test | task lock release on execution end |
| execution-log-tailer.test.ts | test | live execution log tailing and refcounts |
| facade-compact.test.ts | test | manual context compact via agent facade |
| facade-plugin-gating.test.ts | test | channel-scoped plugin directory filtering |
| facade.test.ts | test | provider identity and isolated pre-flight gates |
| feishu-adapter.test.ts | test | Feishu messages, persistence and nullable routing |
| feishu-client.test.ts | test | Feishu SDK logs stay off protocol stdout |
| feishu-device-login.test.ts | test | Feishu device authorization login flow |
| feishu-login-cli.test.ts | test | Feishu login CLI dispatch and gating |
| feishu-output-stream.test.ts | test | Feishu output stream coalescing |
| feishu-user-auth.test.ts | test | Feishu user token exchange and refresh |
| feishu-user-mode.test.ts | test | Feishu user-identity token injection |
| gateway-manager.test.ts | test | gateway port conflict reuse |
| gateway-per-request-mode.test.ts | test | isolated gateway mode prefix and cache cost |
| gpu-slot-scheduling.test.ts | test | per-GPU slot occupancy and scheduling |
| hook-ask-api.test.ts | test | askUser hook helper routing and errors |
| hook-bridge.test.ts | test | hook request publish and resolve chain |
| hook-bus-script-path.test.ts | test | runs registry scripts from paths containing spaces |
| hook-bus.test.ts | test | HookBus ordering, timeout and diagnostics |
| hook-callers.test.ts | test | Session timeout, diagnostics and injection |
| hook-exec.test.ts | test | Hook subprocess output, status and stdin |
| init.test.ts | test | cortex init path, env and MCP config generation |
| integration-init-startup.test.ts | e2e | init and server lifecycle hook behavior |
| integration-settings-hotreload.test.ts | e2e | Settings migration and live reload behavior |
| interaction-handlers.test.ts | test | modal submit publishes answered event |
| lang-command.test.ts | test | language switch command and persistence |
| machines-query.test.ts | test | machines list online/offline projection |
| manager-qa.test.ts | test | manager ask/answer channel resolution |
| manager-rotation.test.ts | test | live settings and task-artifact rehydration |
| manager-task-artifact.test.ts | test | task-keyed manager artifact placement |
| memory-index-regen.test.ts | test | memory index rebuild lifecycle sections |
| message-router.test.ts | test | message routing branches and edit handoff |
| mode-manager.test.ts | test | per-request mode routing and API key policy |
| module-loader.ts | helper | fresh ESM import and root path helpers |
| native/ | subdir | real Linux native process integration tests |
| orch/ | subdir | orchestration runtime and session flow tests |
| orchestration/ | subdir | session compact, rewind and coalescer tests |
| output-stream.test.ts | test | Slack, Feishu and mock output streams |
| pi-cost-record.test.ts | test | PI per-run cost recording end to end |
| platform/ | subdir | platform adapters and UI HTTP transport tests |
| platform-mock-adapter.test.ts | test | Mock contract and nullable admin routing |
| preferences.test.ts | test | operator display preferences store |
| project-store.test.ts | test | project lookup, scaffolding and cache |
| rate-limit-throttle.test.ts | test | committed views and queued expiry retries |
| rate-limiter.test.ts | test | token bucket rate limiter behaviour |
| recommendation-extractor.test.ts | test | recommendation extraction and dedup |
| restart-command.test.ts | test | server restart trigger and command route |
| resume-registry.test.ts | test | provider-ready drains and waiting counts |
| run-with-adapter.test.ts | test | event tee, required sinks and background policy |
| schedule-cli.test.ts | test | schedule API, CLI and fired lifecycle hooks |
| scheduled-runner-jobs.test.ts | test | scheduled job dispatch and isolation |
| scheduled-target-dispatch.test.ts | test | scheduled target and fallback decisions |
| scheduler-precheck.test.ts | test | preCheck exit codes and env passing |
| server-update-check.test.ts | test | CalVer compare and server update check |
| session-activity-tracker.test.ts | test | path-only tool activity logging hook |
| session-backup-async.test.ts | test | Claude async copy and failure contracts |
| session-backup-discovery.test.ts | test | PI filename lookup latency and body-read isolation |
| session-backup.test.ts | test | PI session file backup and restore |
| session-hooks-inject-isolation.test.ts | test | onNew hook injection session isolation |
| session-hooks-profile-resolution.test.ts | test | onNew hook profile lookup priority |
| session.test.ts | test | session CRUD and legacy key migration |
| skill-scanner.test.ts | test | plugin skill discovery and namespacing |
| slack-adapter-classification.test.ts | test | Slack subtype to message kind mapping |
| slack-adapter-prefix.test.ts | test | Slack conduit, persistence and nullable routing |
| slack-adapter-throttle.test.ts | test | Slack update throttle and 429 retry |
| slack-message.test.ts | test | substantial output merge logic |
| slack-output-stream.test.ts | test | Slack output stream emit, flush and tail |
| spawn-seam-direct.golden.json | golden | pins ordinary direct argv and environment |
| spawn-seam-thread.golden.json | golden | pins ordinary thread argv and environment |
| spawn-seam.test.ts | test | Proves task context, cwd and process spawn policy |
| status-helpers.test.ts | test | status sealing and reset-isolated buttons |
| store/ | subdir | JSON repository and store concurrency tests |
| task-abort-outcome.test.ts | test | aborted thread escalates to blocked task |
| task-archiver.test.ts | test | accepts precise task completion timestamps |
| task-completion.test.ts | test | Checks generation fencing, evidence and timestamps |
| task-dispatch-hooks.test.ts | test | Dispatch generations, limits, hooks and recovery |
| task-dispatcher.test.ts | test | dispatch pre-filter, guards and provider gating |
| task-file-input.test.ts | test | task-file CLI matrix, unique paths and literals |
| task-id-utils.test.ts | test | task hash generation, backfill and checks |
| task-lifecycle.test.ts | test | Task CLI ownership, guards and round-trips |
| task-lint.test.ts | test | Unknown template lint with complete task fixtures |
| task-mutations.test.ts | test | task add, batch edit and decompose |
| task-node-ledger.test.ts | test | task artifact paths and acceptance ledger |
| task-origin-wake.test.ts | test | origin wake precedence and notice framing |
| task-parent-split.test.ts | test | Task parent fields and owned split outcomes |
| task-parser.test.ts | test | Task schema round trips, query, lint and health |
| task-store.test.ts | test | task store exclusive mutex serialization |
| task-verdict-cli.test.ts | test | task verdict subcommand recording |
| template-resolver.test.ts | test | prompt template vars, blocks, conditionals |
| thread-abort.test.ts | test | thread abort control plane state |
| thread-benchmark-run.test.ts | test | benchmark isolation and resolved identity |
| thread-callback-tree.test.ts | test | safe child results and parent re-entry |
| thread-coder-review.e2e.test.ts | e2e | coder-review stages and commit evidence policy |
| thread-contract.test.ts | test | delegation contracts and budget breaker |
| thread-extra-hooks.test.ts | test | Covers lifecycle and per-call HookBus routing |
| thread-ledger-dedupe.test.ts | test | child result delivery dedupe across runs |
| thread-manager.test.ts | test | thread prompt variables and transitions |
| thread-resume-statusmsg.test.ts | test | Covers persisted thread resume options |
| thread-resume-task-loop.test.ts | test | Resumed task provenance and live sweep cadence |
| thread-runner.test.ts | test | thread runner lifecycle and wait control |
| thread-stages.test.ts | test | stage parsing and step prompt building |
| thread-statusmsg-seal.test.ts | test | stale suspended status message refresh |
| thread-task-bridge.test.ts | test | Generation-fenced results wake waiting managers |
| thread-tree.test.ts | test | thread tree traversal and spawn guards |
| thread-wait-checkpoint-gate.test.ts | test | wait rejected without an artifact edit |
| thread-wait-children.test.ts | test | parent suspension on child threads |
| thread-wait-deadlock.test.ts | test | stuck wait-set detection and wake |
| thread-wait-tasks.test.ts | test | manager suspension on child tasks |
| threads/ | subdir | thread config, template and transcript tests |
| tool-trace.test.ts | test | tool trace rendering with settings reset |
| tui/ | subdir | TUI rendering, hooks and protocol tests |
| ui-service-compact.test.ts | test | session compact mutation outcome mapping |
| update-prompt-slack.test.ts | test | Slack update prompt buttons and timeout |
| update-prompt.test.ts | test | update prompt buttons, stale and timeout |
| update-state.test.ts | test | update state file round-trip and errors |
| user-context.test.ts | test | reset-isolated USER.md conversation injection |
| webhook-ask-user.test.ts | test | ask endpoint level and channel resolution |
| webhook-auth.test.ts | test | webhook bearer token gate |
| webhook-manager-qa.test.ts | test | manager Q&A webhook ask, poll, answer |
| webhook-thread-control.test.ts | test | thread control webhook validation |
