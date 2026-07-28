Please update me when files in this folder change

Behavioral server regressions for runtime, state, protocols, and failures.

| filename | role | function |
|---|---|---|
| _combined-debug.test.ts | test | Tests combined debug behavior |
| _plan-debug.test.ts | test | Tests plan debug behavior |
| _test-home.ts | helper | Creates isolated test home directories |
| _vitest-setup.ts | setup | Configures per-test runtime isolation |
| agent-adapter-claude.test.ts | test | Tests agent adapter Claude behavior |
| agent-adapter-pi-agent-dir.test.ts | test | Tests agent adapter PI agent dir behavior |
| agent-adapter-pi-event-parser.test.ts | test | Tests agent adapter PI event behavior |
| agent-adapter-pi-hook-bridge.test.ts | test | Tests agent adapter PI hook behavior |
| agent-adapter-pi-mcp-bridge.test.ts | test | Tests agent adapter PI MCP behavior |
| agent-adapter-pi-streaming.test.ts | test | Tests agent adapter PI streaming behavior |
| agent-adapter-pi-tool-shims.test.ts | test | Tests agent adapter PI tool behavior |
| agent-adapter-pi.test.ts | test | Tests agent adapter PI behavior |
| agent-adapter.test.ts | test | Tests agent behavior |
| agent-retry-classification.test.ts | test | Tests agent retry classification behavior |
| app.test.ts | test | Tests app behavior |
| auto-compound.test.ts | test | Tests auto compound behavior |
| claim-recovery.test.ts | test | Tests claim behavior |
| cli-utils.test.ts | test | Tests CLI behavior |
| cli.test.ts | test | Tests CLI behavior |
| client-hot-reload.test.ts | test | Tests client hot reload behavior |
| client-manager.test.ts | test | Tests client behavior |
| codex-bridge.test.ts | test | Tests Codex behavior |
| codex-event-parser.test.ts | test | Tests Codex event behavior |
| codex-spawn-args.test.ts | test | Tests Codex spawn behavior |
| command-handlers.test.ts | test | Tests command behavior |
| command-interactive.test.ts | test | Tests command interactive behavior |
| composite-adapter-noop-fallback.test.ts | test | Tests composite adapter noop fallback behavior |
| conversation-runner.test.ts | test | Tests conversation behavior |
| cortex-client-config.test.ts | test | Tests cortex client behavior |
| cortex-md-injector-hook.test.ts | test | Tests CORTEX.md injector hook behavior |
| cortex-md-injector.test.ts | test | Tests CORTEX.md behavior |
| cortex-md-scanner.test.ts | test | Tests CORTEX.md behavior |
| cortex-run-callback-handler.test.ts | test | Tests cortex run callback behavior |
| cortex-run-cli-dispatch.test.ts | test | Tests cortex run CLI behavior |
| daemon.test.ts | test | Tests daemon behavior |
| disk-monitor.test.ts | test | Tests disk behavior |
| dispatch-utils.test.ts | test | Tests dispatch behavior |
| execution-lock-release.test.ts | test | Tests execution lock behavior |
| execution-log-tailer.test.ts | test | Tests execution log behavior |
| facade-compact.test.ts | test | Tests facade compact behavior |
| facade-plugin-gating.test.ts | test | Tests facade plugin gating behavior |
| facade.test.ts | test | Tests facade behavior |
| feishu-adapter.test.ts | test | Tests Feishu behavior |
| feishu-client.test.ts | test | Tests Feishu behavior |
| feishu-device-login.test.ts | test | Tests Feishu device login behavior |
| feishu-login-cli.test.ts | test | Tests Feishu login behavior |
| feishu-output-stream.test.ts | test | Tests Feishu output behavior |
| feishu-user-auth.test.ts | test | Tests Feishu user behavior |
| feishu-user-mode.test.ts | test | Tests Feishu user mode behavior |
| gateway-manager.test.ts | test | Tests gateway behavior |
| gateway-per-request-mode.test.ts | test | Tests gateway per request mode behavior |
| gpu-slot-scheduling.test.ts | test | Tests GPU slot scheduling behavior |
| hook-bridge.test.ts | test | Tests hook behavior |
| init.test.ts | test | Tests init behavior |
| integration-init-startup.test.ts | test | Tests integration init startup behavior |
| interaction-handlers.test.ts | test | Tests interaction behavior |
| lang-command.test.ts | test | Tests lang behavior |
| machines-query.test.ts | test | Tests machines query behavior |
| manager-qa.test.ts | test | Tests manager qa behavior |
| manager-rotation.test.ts | test | Tests manager rotation behavior |
| manager-task-artifact.test.ts | test | Tests manager task artifact behavior |
| memory-index-regen.test.ts | test | Tests memory index behavior |
| message-router.test.ts | test | Tests message behavior |
| mode-manager.test.ts | test | Tests mode behavior |
| module-loader.ts | loader | Provides module test support |
| output-stream.test.ts | test | Tests output behavior |
| pi-cost-record.test.ts | test | Tests PI cost record behavior |
| platform-mock-adapter.test.ts | test | Tests platform mock behavior |
| preferences.test.ts | test | Tests preferences behavior |
| project-store.test.ts | test | Tests project behavior |
| rate-limit-throttle.test.ts | test | Tests rate limit behavior |
| rate-limiter.test.ts | test | Tests rate behavior |
| recommendation-extractor.test.ts | test | Tests recommendation behavior |
| restart-command.test.ts | test | Tests restart behavior |
| resume-registry.test.ts | test | Tests resume behavior |
| run-with-adapter.test.ts | test | Tests run with behavior |
| schedule-cli.test.ts | test | Tests schedule behavior |
| scheduled-runner-jobs.test.ts | test | Tests scheduled runner jobs behavior |
| scheduled-target-dispatch.test.ts | test | Tests scheduled target behavior |
| scheduler-precheck.test.ts | test | Tests scheduler precheck behavior |
| server-update-check.test.ts | test | Tests server update behavior |
| session-activity-tracker.test.ts | test | Tests session activity behavior |
| session-backup.test.ts | test | Tests session behavior |
| session-hooks-inject-isolation.test.ts | test | Tests session hooks inject isolation behavior |
| session-hooks-profile-resolution.test.ts | test | Tests session hooks profile resolution behavior |
| session.test.ts | test | Tests session behavior |
| skill-scanner.test.ts | test | Tests skill behavior |
| slack-adapter-classification.test.ts | test | Tests Slack adapter classification behavior |
| slack-adapter-prefix.test.ts | test | Tests Slack adapter prefix behavior |
| slack-adapter-throttle.test.ts | test | Tests Slack adapter behavior |
| slack-message.test.ts | test | Tests Slack message behavior |
| slack-output-stream.test.ts | test | Tests Slack output behavior |
| status-helpers.test.ts | test | Tests status behavior |
| task-abort-outcome.test.ts | test | Tests task abort outcome behavior |
| task-completion.test.ts | test | Tests task behavior |
| task-dispatcher.test.ts | test | Tests task behavior |
| task-id-utils.test.ts | test | Tests task id behavior |
| task-lifecycle.test.ts | test | Tests task behavior |
| task-lint.test.ts | test | Tests task behavior |
| task-mutations.test.ts | test | Tests task mutations behavior |
| task-node-ledger.test.ts | test | Tests task node behavior |
| task-origin-wake.test.ts | test | Tests task origin wake behavior |
| task-parent-split.test.ts | test | Tests task parent split behavior |
| task-parser.test.ts | test | Tests task behavior |
| task-state.test.ts | test | Tests task behavior |
| task-store.test.ts | test | Tests task behavior |
| task-verdict-cli.test.ts | test | Tests task verdict behavior |
| template-resolver.test.ts | test | Tests template behavior |
| thread-abort.test.ts | test | Tests thread abort behavior |
| thread-callback-tree.test.ts | test | Tests thread callback behavior |
| thread-coder-review.e2e.test.ts | test | Tests the coder-review end-to-end flow |
| thread-contract.test.ts | test | Tests thread contract behavior |
| thread-extra-hooks.test.ts | test | Tests thread extra behavior |
| thread-ledger-dedupe.test.ts | test | Tests thread ledger dedupe behavior |
| thread-manager.test.ts | test | Tests thread behavior |
| thread-resume-statusmsg.test.ts | test | Tests thread resume statusmsg behavior |
| thread-resume-task-loop.test.ts | test | Tests thread resume task loop behavior |
| thread-runner.test.ts | test | Tests thread behavior |
| thread-stages.test.ts | test | Tests thread stages behavior |
| thread-statusmsg-seal.test.ts | test | Tests thread statusmsg seal behavior |
| thread-task-bridge.test.ts | test | Tests thread task behavior |
| thread-tree.test.ts | test | Tests thread behavior |
| thread-wait-checkpoint-gate.test.ts | test | Tests thread wait checkpoint gate behavior |
| thread-wait-children.test.ts | test | Tests thread wait children behavior |
| thread-wait-deadlock.test.ts | test | Tests thread wait deadlock behavior |
| thread-wait-tasks.test.ts | test | Tests thread wait tasks behavior |
| tool-trace.test.ts | test | Tests tool behavior |
| ui-service-compact.test.ts | test | Tests UI service compact behavior |
| update-prompt-slack.test.ts | test | Tests update prompt Slack behavior |
| update-prompt.test.ts | test | Tests update behavior |
| update-state.test.ts | test | Tests update behavior |
| user-context.test.ts | test | Tests user behavior |
| webhook-auth.test.ts | test | Tests webhook behavior |
| webhook-manager-qa.test.ts | test | Tests webhook manager qa behavior |
| webhook-thread-control.test.ts | test | Tests webhook thread behavior |
| agent-adapter/ | directory | Contains agent adapter modules |
| core/ | directory | Contains core modules |
| domain/ | directory | Contains domain modules |
| entry/ | directory | Contains entry modules |
| events/ | directory | Contains events modules |
| orch/ | directory | Contains orch modules |
| orchestration/ | directory | Contains orchestration modules |
| platform/ | directory | Contains platform modules |
| store/ | directory | Contains store modules |
| threads/ | directory | Contains threads modules |
| tui/ | directory | Contains tui modules |
