Update this file whenever this directory changes

Package tests cover cwd resolution, manifests, and Harbor adapter behavior.

| filename | role | function |
|---|---|---|
| test_build_wheel.py | test | Verifies the fixed build epoch ignores ambient input |
| test_cwd.py | test | Verifies dynamic container cwd resolution |
| test_manifest.py | test | Verifies harness manifest serialization |
| test_harbor_agent.py | test | Verifies Harbor lifecycle and run argv |
| install_only_run.py | integration | Proves setup in a real Harbor container |
