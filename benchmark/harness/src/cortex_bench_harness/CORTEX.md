Update this file whenever this directory changes

Harbor adapter modules resolve container paths and emit reproducibility metadata.

| filename | role | function |
|---|---|---|
| __init__.py | export | Lazily exposes the Harbor wrapper class |
| cwd.py | core | Resolves the live container workdir |
| manifest.py | core | Records artifacts and the installed CLI version |
| harbor_agent.py | adapter | Runs the production Harbor lifecycle and admission gate |
| host_evidence_validation.py | boundary | Validates host-owned evidence identity |
| host_finalization.py | boundary | Validates and publishes the outer grader envelope |
| inner_validation.py | boundary | Validates the inner composite wire contract |
| launcher/ | core | Selects arms and builds non-secret Harbor inputs |
| proxy/ | network | Injects credentials through a bounded trial route |
| scan/ | audit | Finds credential and host-identity leaks |
