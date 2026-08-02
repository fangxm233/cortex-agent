Please update me when files in this folder change

Agent-run primitives freeze identity, persist lifecycle truth and gate process containment.

| filename | role | function |
|---|---|---|
| access-probe-cli.ts | cli | runs a pinned Node syscall probe from flags |
| access-probe-policy.ts | policy | streams and classifies file and network traces |
| access-probe.ts | process | supervises strace and emits isolation verdicts |
| agent-run-cli.ts | cli | parses required file/stdin flags and runs a turn |
| atif.ts | format | converts journal fragments into ATIF trees |
| benchmark-local-thread-orchestrator.ts | runtime | finalizes one bounded, contained benchmark thread |
| benchmark-thread-identity.ts | identity | projects routed parent model and per-role C4 hashes |
| identity.ts | core | hashes routed model, role and bundle identities |
| journal.ts | core | appends durable run event journals with role identity |
| manifest-contract.ts | types | validates canonical-root terminal manifest inputs |
| manifest.ts | core | validates confined multi-role journals and lifecycle truth |
| pinned-node-process.ts | process | launches Node with canonical trial-pinned paths |
| role-surface.ts | identity | hashes exact spawn defaults and directives |
| run-config.ts | config | loads file/stdin config and validates inputs |
| runner.ts | core | coordinates lifecycle and reported accounting |
| supervisor.ts | core | gates lifecycle, stdio modes, watchdog and taxonomy |
| trajectory-merge-cli.ts | cli | publishes one merged trajectory with typed failures |
| trajectory-merge.ts | core | validates and atomically merges journal trees |
