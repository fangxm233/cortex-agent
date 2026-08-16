Please update me when files in this folder change

Agent-run domain tests cover identity hashes, durable journals, lifecycle manifests and process supervision.

| filename | role | function |
|---|---|---|
| access-probe-cli.test.ts | test | verifies help and dual-format probe output |
| atif-dag-fixtures.ts | fixture | writes v2 attempt DAGs with lifecycle pairs |
| atif-recursive-merge.test.ts | test | proves v2 recursive merge without attempt process claims |
| access-probe-fixture.mjs | fixture | emits tamper, timeout and forbidden syscalls |
| access-probe-policy.test.ts | test | proves path, root-metadata, count and stream policy |
| access-probe.test.ts | e2e | proves evidence isolation and containment |
| agent-run-cli.test.ts | test | verifies required flags, stdin ownership and help |
| agent-run-e2e-fixture.ts | fixture | builds and cleans process-level run fixtures |
| agent-run-e2e.test.ts | e2e | Covers lifecycle guards and production dispatch evidence |
| agent-run-protocol-e2e.test.ts | e2e | Covers protocol guards and production accounting evidence |
| benchmark-audit-retry.test.ts | test | proves audit-retry's own stage count, placement, convergence rule and proposal |
| benchmark-identity-of-record.test.ts | test | proves native role identity and pre-spawn drift refusal |
| benchmark-local-thread-entry.ts | fixture | bootstraps MCP and runs one pinned orchestrator |
| benchmark-local-thread-orchestrator.test.ts | test | proves bounds, identity and supervisor gating |
| benchmark-local-thread-process.test.ts | e2e | proves full-run journal and C8 confinement |
| benchmark-production-wiring.test.ts | test | proves the trial-adapter route is derived from the two request paths and that a divergent parent identity refuses before any spawn |
| benchmark-prompt-assets.test.ts | test | proves the extracted prompt files carry the removed bytes and that an unresolved ref fails closed |
| benchmark-reviewer-fix-template.test.ts | test | proves the reviewer-fix documents are authored, not copied, row by row |
| benchmark-reviewer-fix.test.ts | test | proves reviewer-fix's own stage count, shared placement, surviving fix and proposal |
| benchmark-reviewer-surface.test.ts | test | proves the snapshot reviewer holds no write tool and is told to write nothing |
| benchmark-shipped-prompts.ts | fixture | seeds the shipped prompts tree the benchmark agents' file refs resolve against |
| benchmark-thread-backend-neutral.test.ts | test | proves per-step trial adapters, widened pins and artifact convergence on both backends |
| benchmark-thread-workspace.test.ts | test | proves per-step placement, writer refusal, discard and append |
| fake-backend-cli.ts | fixture | answers, hangs on or prices one queued step per invocation in either backend's wire shape, recording its prompts, lifecycle and declared writes through baked-in paths |
| fake-manager-claude.mjs | fixture | drives packed Claude manager turns |
| fake-manager-pi.mjs | fixture | drives packed PI manager turns |
| fake-run-agent-loader.mjs | fixture | redirects current runtime agent imports to a fake |
| fake-run-agent-module.mjs | fixture | returns one deterministic no-model result |
| fake-run-agent-register.mjs | fixture | installs the fake agent loader before import |
| fake-supervisor.ts | fixture | emits lifecycle and ownership process edges |
| fake-thread-probe-entry.mjs | fixture | runs one current-runner step and flushes stores |
| full-benchmark-thread-probe-entry.mjs | fixture | bootstraps MCP and emits fake C4 events for C8 tracing |
| identity.test.ts | test | verifies model, gated role and bundle identity hashes |
| long-mcp-call-e2e.test.ts | e2e | Covers PI MCP duration and production MCP journals |
| long-mcp-claude-cli.mjs | fixture | answers one turn behind a real MCP client call |
| long-mcp-hold-server.mjs | fixture | holds one stdio MCP call for a chosen duration |
| long-mcp-trial-fixture.ts | fixture | compiles a trial whose declared MCP server holds |
| journal.test.ts | test | verifies durable events and v2 lifecycle paths |
| manifest-contract.test.ts | test | verifies supervisor-free terminal v2 evidence |
| pi-rpc-cli.mjs | fixture | answers one PI rpc turn and records its env |
| pinned-node-process.test.ts | test | proves module-load paths and env isolation |
| pinned-paths-child.ts | fixture | reports child-derived paths and env keys |
| production-attempt-identity.test.ts | test | proves pre-spawn root linkage, reload and drift refusal |
| production-attempt-journal.test.ts | test | proves spawn-linked normalized journals per attempt |
| production-evidence-boundary-fixture.ts | fixture | Builds durable production v2 evidence scenarios |
| production-benchmark-evidence-context.test.ts | test | proves context gating, spawn linkage and collision refusal |
| production-accounting-attribution.test.ts | test | proves concurrent spawn-linked request and token attribution |
| role-surface.test.ts | test | verifies prompt, plugin, skill, MCP and hook identity |
| run-config.test.ts | test | proves schema dispatch, roles, argv and MCP inputs |
| standalone-architecture.test.ts | test | rejects shared-state standalone composition |
| standalone-composition.test.ts | test | proves fresh roots and admission evidence |
| standalone-public-cli.test.ts | e2e | Covers packed guards and public v2 evidence export |
| supervisor.test.ts | test | verifies path resolution, protocol and watchdog |
| terminal-classification.test.ts | test | pins which terminal reason a failed run is recorded under |
| trial-run-pi.test.ts | test | Covers PI guards and production v2 evidence |
| trial-manager-runtime.test.ts | test | proves standalone nested manager lifecycle |
| trial-run.test.ts | test | Covers Claude guards and production v2 matrix |
| trajectory-merge-cli.test.ts | test | verifies v2 optional metrics and typed failures |
| transport-teardown-e2e.test.ts | e2e | Covers teardown refusal and atomic v2 publication |
| trajectory-merge-fixtures.ts | fixture | writes v2 accounted fragment events |
| trajectory-merge-subagent.test.ts | test | proves the native-subagent census key, the derived subagent turn total, the zero-census refusal, id-matched call/result pairing across interleaved events, and the surviving named refusals |
| trajectory-merge.test.ts | test | verifies v2 lifecycle merge and optional metrics |
