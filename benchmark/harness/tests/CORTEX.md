Update this file whenever this directory changes

Tests for the Python benchmark harness distribution.

| filename | role | function |
|---|---|---|
| capability_admission.py | fixture | Admits or refuses capability rows for one test without writing the registry |
| docker_gate.py | fixture | Skips container modules unless explicitly opted in |
| fixtures/ | fixture | Stores redacted reproducible vendor wire captures |
| offline_package.py | fixture | Test-side alias for the production package builder in cortex_bench_harness.artifact_build |
| launcher/ | tests | Verifies arm routing and credential projections |
| package/ | tests | Verifies package-level contracts |
| proxy/ | tests | Proves credential and network containment |
| scan/ | tests | Proves leak detection and real offline agent runs |
