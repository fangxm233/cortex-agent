Please update me when files in this folder change

C modules for CLI parsing, NDJSON reporting, Linux process discovery, and containment.

| filename | role | function |
|---|---|---|
| cli.c | cli | Parses pinned supervisor arguments |
| cli.h | header | Declares supervisor CLI options |
| main.c | entry | Configures platform support and runs supervisor |
| process-tree.c | core | Discovers, signals, and reaps descendants |
| process-tree.h | header | Declares process-tree operations |
| protocol.c | protocol | Emits pinned NDJSON control records |
| protocol.h | header | Declares control protocol writers |
| supervisor.c | core | Contains child trees and control transport loss |
| supervisor.h | header | Declares the supervisor runtime |
