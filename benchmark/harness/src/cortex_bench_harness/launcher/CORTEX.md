Update this file whenever this directory changes

Host launcher modules select immutable arms and project non-secret trial configuration.

| filename | role | function |
|---|---|---|
| __init__.py | export | Lazily exposes launcher, seed, registry, and report APIs |
| arm_resolution.py | core | Composes and writes phase-A compiler input, thread policy and MCP config |
| arms.py | core | Builds isolated agents with host-only scan references |
| comparison_report.py | report | Pins campaign inputs and comparison semantics |
| credential_capabilities.py | registry | Projects host-authoritative capability metadata |
| lease_bound.py | policy | Computes the provisional credential-lease bound |
| trial_admission.py | boundary | Seals launch, scan references, and proxy endpoint egress |
| trial_admission_io.py | IO | Enforces pull and proxy endpoint Docker policy |
| trial_proxy.py | core | Freezes final usage and proves trial route revocation |
