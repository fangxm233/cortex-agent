Update this file whenever this directory changes

Launcher tests cover arm routing, credential projections, and vendor isolation.

| filename | role | function |
|---|---|---|
| test_arm_resolution.py | test | Verifies seed parsing and frozen phase-A composition |
| test_arms.py | test | Verifies selection, seed binding, routing, and refusals |
| test_credential_capabilities.py | test | Verifies non-secret capability projections |
| test_independent_entry_parity.py | test | Second witness: shipped entry composes with no helper |
| test_public_entry_parity.py | test | Proves seed-only composition through the shipped loader |
| test_variant_role_sets.py | test | Verifies both coder-review variant role sets on both backends |
| test_vendor_baseline_isolation.py | test | Proves baselines never invoke Cortex installation |
