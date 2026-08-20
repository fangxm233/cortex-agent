Update this file whenever this directory changes

Package tests cover build reproducibility and the production Harbor wrapper.

| filename | role | function |
|---|---|---|
| test_artifact_build.py | test | Verifies deterministic artifacts |
| test_artifact_provenance.py | test | Verifies build staleness refusal |
| test_build_wheel.py | test | Verifies wheel bundle contents |
| test_claude_code_vendor_wire.py | test | Verifies Claude artifact and real wire capture |
| test_codex_vendor_wire.py | test | Verifies current and historical native Codex wire evidence |
| test_cwd.py | test | Verifies container cwd resolution |
| test_harbor_agent.py | test | Verifies offline setup and production Harbor lifecycle |
| test_manifest.py | test | Verifies harness manifest records |
| test_pi_vendor_wire.py | test | Verifies the real PI loopback wire fixture |
| test_runtime_image_builder.py | test | Verifies selected vendor isolation and Cortex-smoke images |
| test_synthetic_deepseek.py | test | Verifies synthetic DeepSeek turns |
| test_vendor_model_freeze.py | test | Proves current real vendor CLIs preserve frozen models |
