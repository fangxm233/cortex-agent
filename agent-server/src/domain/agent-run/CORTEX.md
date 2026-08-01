Please update me when files in this folder change

Agent-run primitives freeze identity, persist lifecycle truth and gate process containment.

| filename | role | function |
|---|---|---|
| access-probe-cli.ts | cli | runs a pinned Node syscall probe from flags |
| access-probe-policy.ts | policy | parses and classifies file and network traces |
| access-probe.ts | process | executes strace and emits isolation verdicts |
| agent-run-cli.ts | cli | parses required file/stdin flags and runs a turn |
| atif.ts | format | converts journal fragments into ATIF trees |
| identity.ts | core | freezes deterministic run identity hashes |
| journal.ts | core | appends durable run event journals |
| manifest-contract.ts | types | validates terminal manifest values |
| manifest.ts | core | validates journals and publishes lifecycle truth |
| pinned-node-process.ts | process | launches Node with trial-pinned paths and env |
| role-surface.ts | identity | hashes the exact resolved spawn role surface |
| run-config.ts | config | loads file/stdin config and validates inputs |
| runner.ts | core | coordinates lifecycle and reported accounting |
| supervisor.ts | core | gates lifecycle, stdio, watchdog and exit taxonomy |
| trajectory-merge-cli.ts | cli | publishes one merged trajectory with typed failures |
| trajectory-merge.ts | core | validates and atomically merges journal trees |
