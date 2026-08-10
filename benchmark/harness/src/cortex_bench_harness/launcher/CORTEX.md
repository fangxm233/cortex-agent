Update this file whenever this directory changes

Host launcher modules select immutable arms and project non-secret trial configuration.

| filename | role | function |
|---|---|---|
| __init__.py | export | Lazily exposes launcher, seed, registry, and report APIs |
| arm_resolution.py | core | Composes and writes phase-A compiler input, thread policy and MCP config |
| arms.py | core | Builds isolated native or Cortex AgentConfig from selected arms |
| comparison_report.py | report | Pins campaign inputs and comparison semantics |
| credential_capabilities.py | registry | Projects host-authoritative capability metadata |
| lease_bound.py | policy | Computes the provisional credential-lease bound |
| trial_admission.py | boundary | Seals Harbor image/env/mount/network evidence |
| trial_admission_io.py | IO | Serializes env/image facts and admission evidence |
| trial_proxy.py | core | Arms, produces, declares and revokes the trial route |
