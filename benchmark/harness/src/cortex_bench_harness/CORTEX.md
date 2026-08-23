Update this file whenever this directory changes

Harbor adapter modules resolve container paths and emit reproducibility metadata.

| filename | role | function |
|---|---|---|
| __init__.py | export | Lazily exposes the Harbor wrapper class |
| artifact_build.py | build | Serializes checkout packing and builds both trial artifacts |
| artifact_provenance.py | boundary | Binds each built artifact to the source it came from, and refuses one that no longer matches the checkout |
| campaign.py | CLI | Persists campaign results, reports and sanitized summaries |
| campaign_config.py | boundary | Reads Cortex and vendor campaigns and scopes trial addresses |
| container_boundary.py | boundary | Records post-stop container exit and process census |
| cwd.py | core | Resolves the live container workdir |
| manifest.py | core | Records artifacts and the installed CLI version |
| harbor_agent.py | adapter | Runs production and finalizes terminal deadline evidence |
| host_finalization.py | boundary | Publishes trial evidence and deadline outcomes |
| full_suite/ | launch | Runs external tasks with one isolated proxy each |
| outcome.py | boundary | Classifies result, thread failure, deadline and verifier state |
| launcher/ | core | Selects arms and builds non-secret Harbor inputs |
| proxy/ | network | Injects credentials through a bounded trial route |
| result_summary.py | report | Projects path-safe results and resolved thinking |
| scan/ | audit | Finds credential and host-identity leaks |
| synthetic_deepseek.py | fixture | Serves deterministic loopback tool and review turns |
| trial_assets.py | collect | Lifts model-visible prompts from the arm home and plugins from the pinned bundle |
| vendor_agents.py | adapter | Runs sealed vendor CLIs with process-group containment |
