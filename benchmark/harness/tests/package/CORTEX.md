Update this file whenever this directory changes

Package tests cover build reproducibility and the production Harbor wrapper.

| filename | role | function |
|---|---|---|
| test_artifact_build.py | test | Verifies deterministic artifacts |
| test_artifact_provenance.py | test | Verifies build staleness refusal |
| test_build_wheel.py | test | Verifies wheel bundle contents |
| test_claude_code_vendor_wire.py | test | Verifies historical and current Claude wire |
| test_codex_vendor_wire.py | test | Verifies current and historical native Codex wire evidence |
| test_current_vendor_cli.py | test | Checks CLI discovery, version, and isolation |
| test_cwd.py | test | Verifies container cwd resolution |
| test_harbor_agent.py | test | Verifies offline setup and production Harbor lifecycle |
| test_manifest.py | test | Verifies harness manifest records |
| test_pi_vendor_wire.py | test | Checks bounded PI capture and runtime identity |
| test_runtime_image_builder.py | test | Verifies role-safe images with bounded fixtures |
| test_runtime_image_builder_fixtures.py | test | Checks fake Python staging and tool contracts |
| test_synthetic_deepseek.py | test | Verifies synthetic DeepSeek turns |
| test_vendor_model_freeze.py | test | Checks current CLI models and proxy refusals |
