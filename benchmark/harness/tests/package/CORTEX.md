Update this file whenever this directory changes

Package tests cover cwd resolution, manifests, and Harbor adapter behavior.

| filename | role | function |
|---|---|---|
| fake_claude_mcp_cli.mjs | fixture | Drives Claude direct and coder-review turns |
| fake_pi_mcp_cli.mjs | fixture | Drives PI direct and coder-review turns |
| test_build_wheel.py | test | Verifies the fixed build epoch ignores ambient input |
| test_cwd.py | test | Verifies dynamic container cwd resolution |
| test_manifest.py | test | Verifies H3 digests and installed CLI version |
| test_harbor_agent.py | test | Verifies admission, identity binding, and run argv |
| test_install.py | integration | Proves every installed Cortex arm and corrupt abort |
