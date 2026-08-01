Please update me when files in this folder change

Agent-run primitives freeze identity, persist lifecycle truth and gate process containment.

| filename | role | function |
|---|---|---|
| agent-run-cli.ts | cli | parses required flags and runs one Claude turn |
| identity.ts | core | freezes deterministic run identity hashes |
| journal.ts | core | appends durable run event journals |
| manifest-contract.ts | types | validates terminal manifest values |
| manifest.ts | core | publishes and locates lifecycle truth |
| role-surface.ts | identity | hashes the exact resolved spawn role surface |
| run-config.ts | config | rejects ambient argv extras and validates frozen one-shot inputs |
| runner.ts | core | coordinates a completion-only supervised one-shot lifecycle |
| supervisor.ts | core | gates lifecycle, stdio, watchdog and exit taxonomy |
