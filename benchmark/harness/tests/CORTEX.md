Update this file whenever this directory changes

Tests for the Python benchmark harness distribution.

| filename | role | function |
|---|---|---|
| capability_admission.py | fixture | Admits or refuses capability rows for one test without writing the registry |
| docker_gate.py | fixture | Skips container modules unless explicitly opted in |
| fixtures/ | fixture | Stores committed redacted vendor wire observations |
| full_suite/ | tests | Verifies isolated external full-suite execution |
| offline_package.py | fixture | Test-side alias for the production package builder in cortex_bench_harness.artifact_build |
| vendor_wire_capture.py | fixture | Captures isolated real Claude wire behavior |
| launcher/ | tests | Verifies arm routing and credential projections |
| package/ | tests | Verifies package-level contracts |
| proxy/ | tests | Proves credential and network containment |
| scan/ | tests | Proves leak detection and real offline agent runs |
