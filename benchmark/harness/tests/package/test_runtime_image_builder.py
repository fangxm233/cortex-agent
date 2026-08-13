# input:  runtime-image build script, local Node/npm/PI fixtures
# output: offline build invocation and digest-pinned image reference
# pos:    Contract test for the ZERO-PAID runtime image builder
# >>> If I am updated, update my header and folder CORTEX.md <<<

import hashlib
import json
import subprocess
from pathlib import Path

HARNESS_DIR = Path(__file__).resolve().parents[2]
BUILD_SCRIPT = HARNESS_DIR / "scripts" / "build-zero-paid-runtime-image.sh"
DIGEST = f"sha256:{'a' * 64}"
IMAGE_REF = f"cortex-bench-zero-paid-runtime@{DIGEST}"


def executable(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    path.chmod(0o755)
    return path


def fixture_inputs(root: Path) -> dict[str, Path]:
    node = executable(
        root / "node-dist/bin/node",
        "#!/usr/bin/python3\n"
        "import json, sys\n"
        "if sys.argv[1] == '--version': print('v22.19.0')\n"
        "elif sys.argv[1] == '-p':\n"
        "    value = json.load(open(sys.argv[3]))\n"
        "    keys = sys.argv[2].split(').', 1)[1].split('.') if ').' in sys.argv[2] else ['version']\n"
        "    for key in keys: value = value[key]\n"
        "    print(value)\n",
    )
    npm = root / "node-dist/lib/node_modules/npm"
    executable(npm / "bin/npm-cli.js", "#!/bin/sh\nexit 0\n")
    (npm / "package.json").write_text(json.dumps({"version": "10.9.3"}), encoding="utf-8")
    pi = root / "pi-agent"
    executable(pi / "dist/cli.js", "#!/usr/bin/env node\n")
    (pi / "package.json").write_text(
        json.dumps({"name": "@earendil-works/pi-coding-agent", "version": "0.82.1"}),
        encoding="utf-8",
    )
    return {"node": node, "npm": npm, "pi": pi}


def tree_sha256(root: Path) -> str:
    completed = subprocess.run([
        "tar", "--sort=name", "--mtime=UTC 1980-01-01", "--owner=0", "--group=0",
        "--numeric-owner", "--pax-option=delete=atime,delete=ctime", "-cf", "-", "-C",
        str(root), ".",
    ], check=True, capture_output=True)
    return hashlib.sha256(completed.stdout).hexdigest()


def runtime_manifest(root: Path, inputs: dict[str, Path]) -> Path:
    path = root / "runtime-inputs.json"
    path.write_text(json.dumps({
        "schema_version": "cortex-bench-zero-paid-runtime-inputs/1",
        "node": {"version": "v22.19.0", "sha256": hashlib.sha256(
            inputs["node"].read_bytes()).hexdigest()},
        "npm": {"version": "10.9.3", "tree_sha256": tree_sha256(inputs["npm"])},
        "pi": {"version": "0.82.1", "tree_sha256": tree_sha256(inputs["pi"])},
    }), encoding="utf-8")
    return path


def fake_docker(root: Path) -> Path:
    return executable(
        root / "bin/docker",
        """#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$DOCKER_CALLS"
if [ "$1" = build ]; then
  for context do :; done
  test -x "$context/node-runtime/bin/node"
  test -f "$context/node-runtime/lib/node_modules/npm/bin/npm-cli.js"
  test -x "$context/pi-agent/dist/cli.js"
  grep -q 'debian@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818' "$context/Dockerfile"
  grep -q '/opt/pi-agent/dist/cli.js' "$context/Dockerfile"
  exit 0
fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  printf '%s\n' "$FAKE_IMAGE_REF"
  exit 0
fi
if [ "$1" = run ]; then
  exit 0
fi
exit 99
""",
    )


def explicit_environment(
    root: Path, inputs: dict[str, Path], docker: Path,
) -> dict[str, str]:
    return {
        "HOME": str(root / "home"), "PATH": f"{docker.parent}:/usr/bin:/bin",
        "DOCKER_CALLS": str(root / "docker-calls.txt"), "FAKE_IMAGE_REF": IMAGE_REF,
        "NODE_BIN": str(inputs["node"]), "NPM_ROOT": str(inputs["npm"]),
        "PI_ROOT": str(inputs["pi"]), "RUNTIME_INPUTS": str(runtime_manifest(root, inputs)),
        "IMAGE_TAG": "cortex-bench-zero-paid-runtime:test",
    }


def test_builder_stages_the_pinned_runtime_and_builds_without_network_or_pull(
    tmp_path: Path,
) -> None:
    inputs = fixture_inputs(tmp_path)
    docker = fake_docker(tmp_path)
    environment = explicit_environment(tmp_path, inputs, docker)

    completed = subprocess.run(
        [str(BUILD_SCRIPT)], cwd=HARNESS_DIR, env=environment,
        check=True, capture_output=True, text=True,
    )

    invoked = Path(environment["DOCKER_CALLS"]).read_text(encoding="utf-8").splitlines()
    assert any("build --network none --pull=false --provenance=false" in call for call in invoked)
    assert any(call.startswith("run --rm --network none --pull never") for call in invoked)
    assert completed.stdout.splitlines() == [
        "pi_version=0.82.1", f"image_ref={IMAGE_REF}", f"image_digest={DIGEST}",
    ]


def test_builder_resolves_node_npm_and_pi_from_their_executable_symlinks(
    tmp_path: Path,
) -> None:
    inputs = fixture_inputs(tmp_path)
    docker = fake_docker(tmp_path)
    (docker.parent / "node").symlink_to(inputs["node"])
    (docker.parent / "npm").symlink_to(inputs["npm"] / "bin/npm-cli.js")
    (docker.parent / "pi").symlink_to(inputs["pi"] / "dist/cli.js")
    environment = explicit_environment(tmp_path, inputs, docker)
    for name in ("NODE_BIN", "NPM_ROOT", "PI_ROOT"):
        del environment[name]

    completed = subprocess.run(
        [str(BUILD_SCRIPT)], cwd=HARNESS_DIR, env=environment,
        check=True, capture_output=True, text=True,
    )

    assert completed.stdout.splitlines()[1] == f"image_ref={IMAGE_REF}"


def test_builder_refuses_a_runtime_whose_digest_differs_from_the_manifest(
    tmp_path: Path,
) -> None:
    inputs = fixture_inputs(tmp_path)
    docker = fake_docker(tmp_path)
    environment = explicit_environment(tmp_path, inputs, docker)
    manifest = Path(environment["RUNTIME_INPUTS"])
    document = json.loads(manifest.read_text(encoding="utf-8"))
    document["node"]["sha256"] = "0" * 64
    manifest.write_text(json.dumps(document), encoding="utf-8")

    completed = subprocess.run(
        [str(BUILD_SCRIPT)], cwd=HARNESS_DIR, env=environment,
        check=False, capture_output=True, text=True,
    )

    assert completed.returncode == 1
    assert "node sha256 mismatch" in completed.stderr
    assert not Path(environment["DOCKER_CALLS"]).exists()
