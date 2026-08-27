Update this file whenever this directory changes

Artifact scanning finds leaks in collected files and their recorded relative paths.

| filename | role | function |
|---|---|---|
| __init__.py | export | Exposes scanner values and entry function |
| __main__.py | entry | Dispatches the scanner module command |
| cli.py | CLI | Parses core sources and emits redacted JSON |
| models.py | types | Defines mapped inventories and leak policies |
| scanner.py | core | Scans files and confines aliases to one root |

The `host:home_path` rule is checked against the accounts that really exist on this host, not
against the `/home/<name>` shape. The shape belongs to third-party content as much as to us —
`pyknotid` hardcodes its author's `/home/asandy/knotcatalogue/...`, pip's cached `appdirs` README
quotes `/home/trentm` — and treating that as a host disclosure refused fifteen trials that had
solved their task on 2026-08-27. `host_finalization._host_home_names` reads the sibling directories
of the runner's own home and puts them in `ScanPolicy.host_home_names`; a policy that names no
account keeps only the exact `home_path` literal, which is the rule that matters most.
