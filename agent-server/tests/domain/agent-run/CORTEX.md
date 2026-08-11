Please update me when files in this folder change

Agent-run domain tests cover identity hashes, durable journals, lifecycle manifests and process supervision.

| filename | role | function |
|---|---|---|
| access-probe-cli.test.ts | test | verifies help and dual-format probe output |
| atif-dag-fixtures.ts | fixture | writes manager- and coder-review-shaped attempt DAGs with their lifecycle pairs |
| atif-recursive-merge.test.ts | test | proves recursion past one level, role-indexed identity, DAG partition and named refusals |
| access-probe-fixture.mjs | fixture | emits tamper, timeout and forbidden syscalls |
| access-probe-policy.test.ts | test | proves path, root-metadata, count and stream policy |
| access-probe.test.ts | e2e | proves evidence isolation and containment |
| agent-run-cli.test.ts | test | verifies required flags, stdin ownership and help |
| agent-run-e2e-fixture.ts | fixture | builds and cleans process-level run fixtures |
| agent-run-e2e.test.ts | e2e | proves containment, cleanup and completion |
| agent-run-protocol-e2e.test.ts | e2e | proves stdin, cache-inclusive accounting and failures |
| benchmark-audit-retry.test.ts | test | proves audit-retry's own stage count, placement, convergence rule and proposal |
| benchmark-identity-of-record.test.ts | test | proves the compiled policy role is the recorded identity and that a diverging template refuses before any spawn |
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
| fake-run-agent-loader.mjs | fixture | redirects current runtime agent imports to a fake |
| fake-run-agent-module.mjs | fixture | returns one deterministic no-model result |
| fake-run-agent-register.mjs | fixture | installs the fake agent loader before import |
| fake-supervisor.ts | fixture | emits lifecycle and ownership process edges |
| fake-thread-probe-entry.mjs | fixture | runs one current-runner step and flushes stores |
| full-benchmark-thread-probe-entry.mjs | fixture | bootstraps MCP and emits fake C4 events for C8 tracing |
| identity.test.ts | test | verifies deterministic run and guard identity hashes |
| long-mcp-call-e2e.test.ts | e2e | holds a real MCP call past 60s on both backends |
| long-mcp-claude-cli.mjs | fixture | answers one turn behind a real MCP client call |
| long-mcp-hold-server.mjs | fixture | holds one stdio MCP call for a chosen duration |
| long-mcp-trial-fixture.ts | fixture | compiles a trial whose declared MCP server holds |
| journal.test.ts | test | verifies durable events and relocatable lifecycle paths |
| manifest-contract.test.ts | test | verifies lifecycle and required parent state admission |
| pi-rpc-cli.mjs | fixture | answers one PI rpc turn and records its env |
| pinned-node-process.test.ts | test | proves module-load paths and env isolation |
| pinned-paths-child.ts | fixture | reports child-derived paths and env keys |
| role-surface.test.ts | test | verifies directives, guards, tools and argv alignment |
| run-config.test.ts | test | proves schema dispatch, roles, argv and MCP inputs |
| standalone-architecture.test.ts | test | rejects shared-state standalone composition |
| standalone-composition.test.ts | test | proves fresh roots and admission evidence |
| standalone-public-cli.test.ts | e2e | proves packed state handoff and process containment |
| supervisor.test.ts | test | verifies path resolution, protocol and watchdog |
| trial-run-pi.test.ts | test | proves PI state admission, supervision and run identity |
| trial-run.test.ts | test | proves Claude state admission, swaps and publication gates |
| trajectory-merge-cli.test.ts | test | verifies context-free accounting and typed failures |
| transport-teardown-e2e.test.ts | e2e | proves journal-linked finalization survives teardown |
| trajectory-merge-fixtures.ts | fixture | writes print-mode accounted fragment events |
| trajectory-merge-subagent.test.ts | test | proves the native-subagent census key, the derived subagent turn total, the zero-census refusal and the surviving named refusals |
| trajectory-merge.test.ts | test | verifies standalone admission and aggregate ATIF output |
