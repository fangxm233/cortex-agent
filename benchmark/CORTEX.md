Update this file whenever this directory changes

Benchmark integrations isolate external harness adapters and container proofs.

| filename | role | function |
|---|---|---|
| campaigns/ | config | Declares the committed campaigns the public runner executes |
| external-suites/ | config | Pins large externally staged benchmark suites |
| harness/ | package | Provides and validates the Harbor adapter |
| policy/ | policy | Declares the committed ceilings a run envelope is validated against |

## Network

A trial's network is decided by the `network` block in its campaign document and by nothing else:
the task files declare the widest plan and admission narrows it. Modes, the best-effort character
of a denylist, and what an open network costs a score are documented in `campaigns/CORTEX.md`;
the resolution logic is `harness/src/cortex_bench_harness/launcher/network_policy.py`.
