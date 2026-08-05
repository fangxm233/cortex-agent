Update this file whenever this directory changes

Tests for the Python benchmark harness distribution.

| filename | role | function |
|---|---|---|
| capability_admission.py | fixture | Admits or refuses capability rows for one test without writing the registry |
| docker_gate.py | fixture | Gates container tests behind an opt-in variable |
| launcher/ | tests | Verifies arm routing and credential projections |
| package/ | tests | Verifies package-level contracts |
| proxy/ | tests | Proves credential and network containment |
| scan/ | tests | Proves leak detection and real offline agent runs |
