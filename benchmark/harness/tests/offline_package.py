# input:  built Cortex tree and already-local dependency directories
# output: self-contained Cortex npm artifact for offline container install
# pos:    Shared offline package fixture builder
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
import os
import shutil
import subprocess
from pathlib import Path


def _copy_package_inputs(server_root: Path, stage: Path) -> None:
    files = ("package.json", "package-lock.json", "README.md")
    directories = ("dist", "defaults", "native/cortex-supervisor/dist", "web/dist")
    for relative in files:
        shutil.copy2(server_root / relative, stage / relative)
    package = json.loads((stage / "package.json").read_text())
    package["scripts"].pop("prepare", None)
    package["scripts"].pop("prepack", None)
    package["bundleDependencies"] = True
    (stage / "package.json").write_text(json.dumps(package, indent=2) + "\n")
    for relative in directories:
        shutil.copytree(server_root / relative, stage / relative, symlinks=True)
    script = "scripts/postinstall-restart-trigger.mjs"
    (stage / "scripts").mkdir()
    shutil.copy2(server_root / script, stage / script)


def _merge_dependency_tree(source: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for entry in os.scandir(source):
        target = destination / entry.name
        if target.exists() or target.is_symlink():
            if entry.is_dir(follow_symlinks=False) and target.is_dir() and not target.is_symlink():
                _merge_dependency_tree(Path(entry.path), target)
            continue
        if entry.is_symlink():
            target.symlink_to(os.readlink(entry.path), target_is_directory=entry.is_dir())
        elif entry.is_dir(follow_symlinks=False):
            shutil.copytree(entry.path, target, copy_function=shutil.copy2, symlinks=True)
        else:
            shutil.copy2(entry.path, target)


def _copy_local_dependencies(repo_root: Path, stage: Path) -> None:
    destination = stage / "node_modules"
    shutil.copytree(
        repo_root / "agent-server/node_modules", destination,
        copy_function=shutil.copy2, symlinks=True,
    )
    _merge_dependency_tree(repo_root / "node_modules", destination)


def build_offline_npm_artifact(repo_root: Path, output_dir: Path) -> Path:
    server_root = repo_root / "agent-server"
    environment = {**os.environ, "npm_config_offline": "true",
                   "npm_config_update_notifier": "false"}
    environment.pop("PYTHONPATH", None)
    for command in (
        ["pnpm", "--filter", "@cortex-agent/web...", "run", "build"],
        ["npm", "run", "build:supervisor"],
        ["node", "scripts/copy-web-dist.js"],
    ):
        cwd = repo_root if command[0] == "pnpm" else server_root
        subprocess.run(command, cwd=cwd, env=environment, check=True,
                       capture_output=True, text=True)
    stage = output_dir / "package-stage"
    stage.mkdir()
    _copy_package_inputs(server_root, stage)
    _copy_local_dependencies(repo_root, stage)
    subprocess.run(
        ["npm", "pack", "--offline", "--ignore-scripts",
         "--pack-destination", str(output_dir)],
        cwd=stage, env=environment, check=True, capture_output=True, text=True,
    )
    artifacts = list(output_dir.glob("cortex-agent-server-*.tgz"))
    assert len(artifacts) == 1
    return artifacts[0]
