Update this file whenever this directory changes

Artifact scanning rejects credential and host-identity leaks across five required trial sources.

| filename | role | function |
|---|---|---|
| __init__.py | export | Exposes scanner values and entry function |
| __main__.py | entry | Dispatches the scanner module command |
| cli.py | CLI | Parses five sources and emits redacted JSON |
| models.py | types | Defines scan inputs, findings, and reports |
| scanner.py | core | Scans every required artifact source |
