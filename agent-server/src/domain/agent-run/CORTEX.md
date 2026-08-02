Please update me when files in this folder change

Agent-run primitives freeze identity, persist lifecycle truth and gate process containment.

| filename | role | function |
|---|---|---|
| access-probe-cli.ts | cli | runs a pinned Node syscall probe from flags |
| access-probe-policy.ts | policy | streams and classifies file and network traces |
| access-probe.ts | process | probes through the fail-closed supervisor path |
| agent-run-cli.ts | cli | parses flags and resolves the supervisor path |
| atif.ts | format | converts fragments and aggregates into ATIF trees |
| benchmark-local-thread-orchestrator.ts | runtime | runs one bounded thread through the resolved supervisor |
| benchmark-thread-identity.ts | identity | projects parent, role and prompt hashes |
| identity.ts | core | hashes routed model, role and bundle identities |
| journal.ts | core | appends durable run event journals with role identity |
| manifest-contract.ts | types | validates canonical-root terminal manifest inputs |
| manifest.ts | core | validates lifecycle truth and accounting events |
| pinned-node-process.ts | process | launches Node with canonical trial-pinned paths |
| role-surface.ts | identity | hashes exact spawn defaults and directives |
| run-config.ts | config | loads file/stdin config and validates inputs |
| runner.ts | core | coordinates lifecycle and reported accounting |
| supervisor.ts | core | resolves the binary and gates process containment |
| trajectory-merge-cli.ts | cli | publishes one merged trajectory with typed failures |
| trajectory-merge.ts | core | validates and merges accounted journal trees |
