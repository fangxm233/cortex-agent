# input:  production Cortex package tree and already-local dependencies
# output: unmodified production npm artifact for offline container install
# pos:    Shared production package builder for offline tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

import os
import subprocess
from pathlib import Path


def build_offline_npm_artifact(repo_root: Path, output_dir: Path) -> Path:
    server_root = repo_root / "agent-server"
    environment = {**os.environ, "npm_config_offline": "true",
                   "npm_config_update_notifier": "false"}
    environment.pop("PYTHONPATH", None)
    subprocess.run(
        ["pnpm", "--filter", "@cortex-agent/web...", "run", "build"],
        cwd=repo_root, env=environment, check=True, capture_output=True, text=True,
    )
    subprocess.run(
        ["npm", "pack", "--offline", "--pack-destination", str(output_dir)],
        cwd=server_root, env=environment, check=True, capture_output=True, text=True,
    )
    artifacts = list(output_dir.glob("cortex-agent-server-*.tgz"))
    assert len(artifacts) == 1
    return artifacts[0]
