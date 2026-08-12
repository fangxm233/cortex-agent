Update this file whenever this directory changes

Host launcher modules select immutable arms and project non-secret trial configuration.

| filename | role | function |
|---|---|---|
| __init__.py | export | Lazily exposes launcher and paid-smoke APIs |
| arm_resolution.py | core | Composes and writes phase-A compiler input, thread policy and MCP config |
| arms.py | core | Builds isolated agents with host-only scan references |
| comparison_report.py | report | Pins campaign inputs and comparison semantics |
| capability_evidence.py | boundary | Validates capability promotion provenance |
| credential_capabilities.py | registry | Projects host-authoritative capability metadata |
| deepseek_paid_smoke.py | boundary | Runs the exact bounded DeepSeek paid contract |
| evidence/ | evidence | Binds immutable capability promotion records |
| host_credential_vault.py | boundary | Transfers one host credential by opaque handle |
| lease_bound.py | policy | Computes the provisional credential-lease bound |
| trial_admission.py | boundary | Seals launch evidence, mounts and proxy egress |
| trial_admission_io.py | IO | Pins pull, external network and endpoint policy |
| trial_proxy.py | core | Freezes final usage and proves trial route revocation |
