Please update me when files in this folder change

Agent-run primitives freeze identity, persist lifecycle truth and gate process containment.

| filename | role | function |
|---|---|---|
| access-probe-cli.ts | cli | runs a pinned Node syscall probe from flags |
| access-probe-policy.ts | policy | streams and classifies file and network traces |
| access-probe.ts | process | supervises strace and emits isolation verdicts |
| agent-run-cli.ts | cli | parses required file/stdin flags and runs a turn |
| atif.ts | format | converts journal fragments into ATIF trees |
| benchmark-local-thread-orchestrator.ts | runtime | finalizes durable benchmark thread results |
| benchmark-thread-identity.ts | identity | freezes routed model and per-role identities |
| identity.ts | core | freezes deterministic run identity hashes |
| journal.ts | core | appends journals with optional per-event identities |
| manifest-contract.ts | types | types canonical-root terminal manifest inputs |
| manifest.ts | core | validates per-role journals and lifecycle truth |
| pinned-node-process.ts | process | launches Node with canonical trial-pinned paths |
| role-surface.ts | identity | hashes resolved spawn defaults and directives |
| run-config.ts | config | loads file/stdin config and validates inputs |
| runner.ts | core | coordinates lifecycle and reported accounting |
| supervisor.ts | core | gates lifecycle, stdio modes, watchdog and taxonomy |
| trajectory-merge-cli.ts | cli | publishes one merged trajectory with typed failures |
| trajectory-merge.ts | core | validates and atomically merges journal trees |
