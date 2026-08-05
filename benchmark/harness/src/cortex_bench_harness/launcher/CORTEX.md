Update this file whenever this directory changes

Host launcher modules select immutable arms and project non-secret trial configuration.

| filename | role | function |
|---|---|---|
| __init__.py | export | Exposes launcher construction, seed and registry values |
| arm_resolution.py | core | Composes and writes phase-A compiler input, thread policy and MCP config |
| arms.py | core | Binds selected arms to seeds and builds AgentConfig |
| credential_capabilities.py | registry | Projects host-authoritative capability metadata |
| lease_bound.py | policy | Computes the provisional credential-lease bound |
| trial_proxy.py | core | Arms, produces, declares and revokes the trial route |
