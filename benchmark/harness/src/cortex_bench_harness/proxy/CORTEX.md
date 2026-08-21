Update this file whenever this directory changes

Per-trial host proxy modules enforce credential, request-count, deadline, and source boundaries.

| filename | role | function |
|---|---|---|
| __init__.py | export | Exposes the trial proxy API |
| models.py | types | Defines the route's request cap, measured usage, content-free diagnostics, and the declared-envelope manifest block |
| adapters/ | adapters | Carries one provider protocol per capability key |
| upstream.py | adapter | Relays one fixed upstream and detects incomplete responses |
| server.py | core | Enforces request/retry admission, relays responses, and freezes usage, diagnostics, and revocation |
| lease.py | core | Arms, clamps and records the credential lease |
| export.py | core | Builds the proxy-authoritative accounting export and tallies what went wrong |
| manifest.py | persistence | Fills the H3 proxy manifest block |
| cli.py | CLI | Runs one proxy from explicit host inputs |
| __main__.py | entry | Dispatches the Python module command |
