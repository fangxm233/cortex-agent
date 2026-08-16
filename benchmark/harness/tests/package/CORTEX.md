Update this file whenever this directory changes

Package tests cover cwd resolution, manifests, and Harbor adapter behavior.

| filename | role | function |
|---|---|---|
| fake_claude_mcp_cli.mjs | fixture | Drives Claude direct and coder-review turns |
| fake_pi_mcp_cli.mjs | fixture | Drives PI direct and coder-review turns |
| test_artifact_provenance.py | test | Proves the staleness gate refuses an artifact that no longer matches its source |
| test_build_wheel.py | test | Verifies deterministic builds include the direct bundle |
| test_cwd.py | test | Verifies dynamic container cwd resolution |
| test_manifest.py | test | Verifies H3 digests and installed CLI version |
| test_harbor_agent.py | test | Verifies admission, identity binding, run argv, and the terminal-marker bound on the inner run |
| test_install.py | integration | Proves every installed Cortex arm and corrupt abort |
| test_runtime_image_builder.py | test | Verifies offline runtime and Terminal-Bench image builds |
| test_synthetic_deepseek.py | test | Verifies deterministic loopback tool turns |
