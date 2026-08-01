Please update me when files in this folder change

Agent-run domain tests cover identity hashes, durable journals, lifecycle manifests and process supervision.

| filename | role | function |
|---|---|---|
| agent-run-cli.test.ts | test | verifies required flags, stdin ownership and help |
| agent-run-e2e.test.ts | e2e | proves stdin, zero accounting and run completion |
| fake-supervisor.ts | fixture | emits lifecycle edges from a real process group |
| identity.test.ts | test | verifies deterministic run identity hashes |
| journal.test.ts | test | verifies journal durability and validation |
| manifest-contract.test.ts | test | verifies lifecycle and linkage contracts |
| role-surface.test.ts | test | verifies plugin hashing and argv alignment |
| run-config.test.ts | test | verifies non-empty roles, argv closure, and MCP inputs |
| supervisor.test.ts | test | verifies protocol, stdio, watchdog and taxonomy |
