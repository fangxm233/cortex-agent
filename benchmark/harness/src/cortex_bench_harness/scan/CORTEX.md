Update this file whenever this directory changes

Artifact scanning finds leaks in collected files and their recorded relative paths.

| filename | role | function |
|---|---|---|
| __init__.py | export | Exposes scanner values and entry function |
| __main__.py | entry | Dispatches the scanner module command |
| cli.py | CLI | Parses core sources and emits redacted JSON |
| models.py | types | Defines inventory and redacted host leak policies |
| scanner.py | core | Scans collected files and path text for sensitive values |
