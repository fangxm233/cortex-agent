Update this file whenever this directory changes

Launcher tests cover arm routing, credential projections, and vendor isolation.

| filename | role | function |
|---|---|---|
| test_arm_resolution.py | test | Verifies phase-A document emission and inventory |
| test_arms.py | test | Verifies selection and Harbor AgentConfig routing |
| test_credential_capabilities.py | test | Verifies non-secret capability projections |
| test_public_entry_parity.py | test | Proves public run-config composition and vendor isolation |
| test_vendor_baseline_isolation.py | test | Proves baselines never invoke Cortex installation |
