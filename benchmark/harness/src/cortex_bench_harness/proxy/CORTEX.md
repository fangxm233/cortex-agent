Update this file whenever this directory changes

Per-trial host proxy modules enforce credential, budget, deadline, and source boundaries.

| filename | role | function |
|---|---|---|
| __init__.py | export | Exposes the trial proxy API |
| models.py | types | Defines budgets, usage, and safe metadata |
| adapters/ | adapters | Carries one provider protocol per capability key |
| upstream.py | adapter | Forwards requests to one fixed upstream |
| server.py | core | Enforces admission and proxy lifecycle |
| lease.py | core | Arms, clamps and records the credential lease |
| export.py | core | Builds the proxy-authoritative accounting export |
| manifest.py | persistence | Fills the H3 proxy manifest block |
| cli.py | CLI | Runs one proxy from explicit host inputs |
| __main__.py | entry | Dispatches the Python module command |
