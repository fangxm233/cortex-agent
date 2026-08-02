Update this file whenever this directory changes

Package tests cover cwd resolution, manifests, and Harbor adapter behavior.

| filename | role | function |
|---|---|---|
| test_build_wheel.py | test | Verifies the fixed build epoch ignores ambient input |
| test_cwd.py | test | Verifies dynamic container cwd resolution |
| test_manifest.py | test | Verifies H3 artifact digest serialization |
| test_harbor_agent.py | test | Verifies fail-closed install and run argv |
| test_install.py | integration | Proves real bundle install and corrupt abort |
