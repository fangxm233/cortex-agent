Update this file whenever this directory changes

Artifact scanning rejects leaks and inventory gaps across declared trial sources and roots.

| filename | role | function |
|---|---|---|
| __init__.py | export | Exposes scanner values and entry function |
| __main__.py | entry | Dispatches the scanner module command |
| cli.py | CLI | Parses core sources and emits redacted JSON |
| models.py | types | Defines named inventory, findings, and reports |
| scanner.py | core | Scans declared sources and closes root inventory |
