Please update me when files in this folder change

Agent-run domain tests cover identity hashes, durable journals, lifecycle manifests and process supervision.

| filename | role | function |
|---|---|---|
| access-probe-cli.test.ts | test | verifies help and dual-format probe output |
| access-probe-fixture.mjs | fixture | emits tamper, timeout and forbidden syscalls |
| access-probe-policy.test.ts | test | proves process, path, count and stream policy |
| access-probe.test.ts | e2e | proves evidence isolation and containment |
| agent-run-cli.test.ts | test | verifies required flags, stdin ownership and help |
| agent-run-e2e-fixture.ts | fixture | builds and cleans process-level run fixtures |
| agent-run-e2e.test.ts | e2e | proves containment, cleanup and completion |
| agent-run-protocol-e2e.test.ts | e2e | proves stdin, accounting and trajectory failures |
| benchmark-local-thread-entry.ts | fixture | runs one orchestrator in a pinned child |
| benchmark-local-thread-orchestrator.test.ts | test | proves C9 lifecycle ordering and isolation |
| benchmark-local-thread-process.test.ts | e2e | proves fresh-process local thread confinement |
| fake-run-agent-loader.mjs | fixture | redirects runner agent imports to a fake |
| fake-run-agent-module.mjs | fixture | returns one deterministic no-model result |
| fake-run-agent-register.mjs | fixture | installs the fake agent loader before import |
| fake-supervisor.ts | fixture | emits lifecycle and ownership process edges |
| fake-thread-probe-entry.mjs | fixture | runs one current-runner step and flushes stores |
| identity.test.ts | test | verifies deterministic run identity hashes |
| journal.test.ts | test | verifies journal durability and validation |
| manifest-contract.test.ts | test | verifies lifecycle and linkage contracts |
| pinned-node-process.test.ts | test | proves module-load paths and env isolation |
| pinned-paths-child.ts | fixture | reports child-derived paths and env keys |
| role-surface.test.ts | test | verifies plugin hashing and argv alignment |
| run-config.test.ts | test | verifies non-empty roles, argv closure, and MCP inputs |
| supervisor.test.ts | test | verifies protocol, stdio, watchdog and taxonomy |
| trajectory-merge-cli.test.ts | test | verifies reason codes and fail-closed cleanup |
| trajectory-merge-fixtures.ts | fixture | writes literal parent and child lifecycle records |
| trajectory-merge.test.ts | test | verifies exact-once ATIF tree conversion |
