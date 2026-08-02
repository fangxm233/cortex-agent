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
| agent-run-protocol-e2e.test.ts | e2e | proves stdin, nullable accounting and failures |
| benchmark-local-thread-entry.ts | fixture | runs one orchestrator in a pinned child |
| benchmark-local-thread-orchestrator.test.ts | test | proves C9.2 bounds and C4 prelaunch identity checks |
| benchmark-local-thread-process.test.ts | e2e | proves full-run journal and C8 confinement |
| fake-run-agent-loader.mjs | fixture | redirects thread-runtime agent imports to a fake |
| fake-run-agent-module.mjs | fixture | returns one deterministic no-model result |
| fake-run-agent-register.mjs | fixture | installs the fake agent loader before import |
| fake-supervisor.ts | fixture | emits lifecycle and ownership process edges |
| fake-thread-probe-entry.mjs | fixture | runs one current-runner step and flushes stores |
| full-benchmark-thread-probe-entry.mjs | fixture | emits complete fake C4 events for C8 tracing |
| identity.test.ts | test | verifies deterministic run identity hashes |
| journal.test.ts | test | verifies durable events and per-role identities |
| manifest-contract.test.ts | test | verifies lifecycle, linkage and child identity contracts |
| pinned-node-process.test.ts | test | proves module-load paths and env isolation |
| pinned-paths-child.ts | fixture | reports child-derived paths and env keys |
| role-surface.test.ts | test | verifies directives, default tools and argv alignment |
| run-config.test.ts | test | verifies non-empty roles, argv closure, and MCP inputs |
| supervisor.test.ts | test | verifies path resolution, protocol and watchdog |
| trajectory-merge-cli.test.ts | test | verifies additive fields and fail-closed cleanup |
| trajectory-merge-fixtures.ts | fixture | writes and mutates accounted fragments |
| trajectory-merge.test.ts | test | verifies documented aggregate ATIF conversion |
