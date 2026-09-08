Please update me when files in this folder change.

Tests cover the Python benchmark harness and current vendor CLI behavior.

| filename | role | function |
|---|---|---|
| capability_admission.py | fixture | Admits capability rows for isolated tests |
| current_vendor_cli.py | fixture | Queries current CLIs and isolates loopback tests |
| docker_gate.py | fixture | Gates opt-in container tests |
| fixtures/ | fixture | Stores historical redacted wire observations |
| full_suite/ | tests | Verifies isolated external suite execution |
| offline_package.py | fixture | Exposes the production artifact builder |
| runtime_image_builder_fixtures.py | fixture | Stages bounded fake tools and Python runtimes |
| vendor_wire_capture.py | fixture | Captures current Claude wire and runtime identity |
| launcher/ | tests | Verifies routing and credential projections |
| package/ | tests | Verifies package and current CLI contracts |
| proxy/ | tests | Proves credential and network containment |
| scan/ | tests | Proves leak detection and offline runs |
