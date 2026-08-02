Update this file whenever this directory changes

Harbor adapter modules resolve container paths and emit reproducibility metadata.

| filename | role | function |
|---|---|---|
| __init__.py | export | Exposes the Harbor wrapper class |
| cwd.py | core | Resolves the live container workdir |
| manifest.py | core | Records harness and Cortex artifact digests |
| harbor_agent.py | adapter | Installs and runs Cortex through Harbor APIs |
| proxy/ | network | Injects credentials through a bounded trial route |
| scan/ | audit | Detects credentials and host identities in artifacts |
