Update this file whenever this directory changes

Harbor adapter modules resolve container paths and emit reproducibility metadata.

| filename | role | function |
|---|---|---|
| __init__.py | export | Lazily exposes the Harbor wrapper class |
| artifact_build.py | build | Builds the harness wheel and the packed agent-server a trial installs |
| artifact_provenance.py | boundary | Binds each built artifact to the source it came from, and refuses one that no longer matches the checkout |
| campaign.py | CLI | Runs one campaign's trials concurrently across its address slots, accounts every trial's spend whether or not it published, and writes the report |
| campaign_config.py | boundary | Reads campaign input, carves the concurrency slots' address space, scopes each trial proxy host and refuses a cost pair that funds too few requests |
| cwd.py | core | Resolves the live container workdir |
| manifest.py | core | Records artifacts and the installed CLI version |
| harbor_agent.py | adapter | Runs the production Harbor lifecycle and admission gate, bounded by the inner run's terminal marker |
| host_evidence_validation.py | boundary | Validates host-owned evidence identity |
| host_finalization.py | boundary | Validates host attestations and publishes the outer envelope |
| inner_validation.py | boundary | Validates production-ledger evidence v2 edges |
| launcher/ | core | Selects arms and builds non-secret Harbor inputs |
| proxy/ | network | Injects credentials through a bounded trial route |
| scan/ | audit | Finds credential and host-identity leaks |
| synthetic_deepseek.py | fixture | Serves deterministic loopback tool turns |
| trial_assets.py | boundary | Lifts the model-visible assets one trial used out of the pinned bundle and holds them against the run's own header |
