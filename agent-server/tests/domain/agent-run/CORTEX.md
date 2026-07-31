Please update me when files in this folder change

Agent-run domain tests cover identity hashes, durable journals, lifecycle manifests and process supervision.

| filename | role | function |
|---|---|---|
| fake-supervisor.ts | fixture | emits supervisor records over a real control fd |
| identity.test.ts | test | verifies deterministic run identity hashes |
| journal.test.ts | test | verifies journal durability and validation |
| manifest-contract.test.ts | test | verifies lifecycle and linkage contracts |
| supervisor.test.ts | test | verifies supervisor parsing and shutdown gating |
