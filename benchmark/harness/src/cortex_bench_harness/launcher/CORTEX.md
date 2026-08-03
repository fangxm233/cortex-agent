Update this file whenever this directory changes

Host launcher modules select immutable arms and project non-secret trial configuration.

| filename | role | function |
|---|---|---|
| __init__.py | export | Exposes launcher construction, seed and registry values |
| arm_resolution.py | core | Composes and writes phase-A compiler input from the seed |
| arms.py | core | Selects arms, refuses uncomposable pairs, builds AgentConfig |
| credential_capabilities.py | registry | Projects host-authoritative capability metadata |
