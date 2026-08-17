Update this file whenever this directory changes

Host launcher modules select immutable arms and project non-secret trial configuration.

| filename | role | function |
|---|---|---|
| __init__.py | export | Lazily exposes launcher and paid-smoke APIs |
| arm_resolution.py | core | Composes and writes phase-A compiler input, thread policy and MCP config |
| arms.py | core | Builds isolated agents with host-only scan references |
| bundles/ | config | Holds immutable production arm input bundles |
| capability_ceilings.py | policy | Reads the committed per-capability envelope ceilings |
| comparison_report.py | report | Pins campaign inputs and comparison semantics |
| capability_evidence.py | boundary | Validates schema-v2 promotion provenance and its mutation manifest |
| credential_capabilities.py | registry | Projects host-authoritative capability metadata |
| deepseek_paid_smoke.py | boundary | Runs the exact bounded DeepSeek paid contract |
| evidence/ | evidence | Binds immutable capability promotion records |
| host_credential_vault.py | boundary | Transfers one host credential by opaque handle |
| lease_bound.py | policy | Computes the provisional credential-lease bound |
| production_arms.py | registry | Resolves a campaign arm to its committed bundle, profile, root template and evidence shape |
| production_home.py | boundary | Materializes and attests an arm's production home with isolated server auth, and reads back that bundle's committed input file list |
| production_session.py | lifecycle | Injects each arm root and follows its current dispatched attempt |
| trial_admission.py | boundary | Seals launch inputs and owns post-stop finalization |
| trial_admission_io.py | IO | Pins service-aware pull, external network and endpoint policy |
| trial_proxy.py | core | Validates the declared paid envelope, freezes final usage and proves trial route revocation |
