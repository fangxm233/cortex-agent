Please update me when files in this folder change

Agent-run primitives freeze identity, persist lifecycle truth and gate process containment.

| filename | role | function |
|---|---|---|
| access-probe-cli.ts | cli | runs a pinned Node syscall probe from flags |
| access-probe-policy.ts | policy | streams and classifies file and network traces |
| access-probe.ts | process | probes through the fail-closed supervisor path |
| agent-run-cli.ts | cli | parses flags and resolves the supervisor path |
| atif.ts | format | converts print-mode fragment batches and metrics to ATIF |
| benchmark-local-thread-orchestrator.ts | runtime | fails closed or runs one bounded supervised thread |
| benchmark-thread-identity.ts | identity | projects parent, role and prompt hashes |
| identity.ts | core | hashes routed model, guarded role and bundle identities |
| journal.ts | core | appends durable run event journals with role identity |
| manifest-contract.ts | types | serializes root-relative terminal journal paths |
| manifest.ts | core | validates relocatable lifecycle truth and events |
| pinned-node-process.ts | process | launches Node with canonical trial-pinned paths |
| role-surface.ts | identity | hashes exact spawn defaults, directives and guards |
| run-config.ts | config | dispatches legacy and benchmark run configs |
| runner.ts | core | coordinates policy-held lifecycle and accounting |
| supervisor.ts | core | resolves the binary and gates process containment |
| trajectory-merge-cli.ts | cli | publishes one merged trajectory with typed failures |
| trajectory-merge.ts | core | fails closed and publishes accounted journal metrics |
