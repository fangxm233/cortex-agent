Update this file whenever this directory changes

Package tests cover build reproducibility and the production Harbor wrapper.

| filename | role | function |
|---|---|---|
| test_artifact_build.py | test | Verifies deterministic artifacts |
| test_artifact_provenance.py | test | Verifies build staleness refusal |
| test_build_wheel.py | test | Verifies wheel bundle contents |
| test_codex_vendor_wire.py | test | Verifies the pinned native Codex wire capture |
| test_cwd.py | test | Verifies container cwd resolution |
| test_harbor_agent.py | test | Verifies production Harbor lifecycle |
| test_manifest.py | test | Verifies harness manifest records |
| test_runtime_image_builder.py | test | Verifies offline runtime image builds |
| test_synthetic_deepseek.py | test | Verifies synthetic DeepSeek turns |
