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
TASK_BUILD_SCRIPT = HARNESS_DIR / "scripts" / "provision-terminal-bench-images.sh"
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


def terminal_bench_source(root: Path, task_ids: tuple[str, ...]) -> Path:
    source = root / "terminal-bench-source"
    (source / ".git").mkdir(parents=True)
    for task_id in task_ids:
        task = source / "tasks" / task_id
        (task / "environment").mkdir(parents=True)
        (task / "tests").mkdir()
        (task / "instruction.md").write_text(f"Solve {task_id}.\n", encoding="utf-8")
        (task / "tests/test.sh").write_text("#!/bin/bash\necho authentic\n", encoding="utf-8")
        (task / "tests/test_outputs.py").write_text("def test_output(): pass\n", encoding="utf-8")
        (task / "task.toml").write_text(
            "[environment]\n"
            f'docker_image = "registry.invalid/{task_id}:mutable"\n'
            "allow_internet = true\n"
            "mcp_servers = []\n",
            encoding="utf-8",
        )
    return source


def terminal_bench_manifest(
    root: Path, inputs: dict[str, Path], task_ids: tuple[str, ...], verifier_hash: str,
) -> Path:
    source = root / "terminal-bench-source/tasks"
    document = {
        "schema_version": "cortex-terminal-bench-images/1",
        "source": {
            "repository": "https://github.com/harbor-framework/terminal-bench-2-1.git",
            "commit": "1" * 40,
        },
        "runtime_inputs": str(runtime_manifest(root, inputs)),
        "build_epoch": 1786481201,
        "verifier": {
            "python_version": "3.12",
            "packages": [{
                "requirement": "pytest==8.4.1",
                "filename": "pytest-8.4.1-py3-none-any.whl",
                "url": "https://files.invalid/pytest-8.4.1-py3-none-any.whl",
                "sha256": hashlib.sha256(b"fixture wheel").hexdigest(),
            }],
            "tree_sha256": verifier_hash,
        },
        "tasks": [
            {
                "task_id": task_id,
                "source_image_ref": f"registry.invalid/{task_id}:mutable",
                "source_image_digest": f"sha256:{index + 3:064x}",
                "final_image_tag": f"cortex-terminal-bench-2.1:{task_id}-pi-0.82.1",
                "final_image_digest": f"sha256:{index + 6:064x}",
                "source_files": {
                    relative: hashlib.sha256((source / task_id / relative).read_bytes()).hexdigest()
                    for relative in (
                        "instruction.md", "task.toml", "tests/test.sh",
                        "tests/test_outputs.py",
                    )
                },
            }
            for index, task_id in enumerate(task_ids)
        ],
    }
    path = root / "terminal-bench-images.json"
    path.write_text(json.dumps(document), encoding="utf-8")
    return path


def fake_task_builder_tools(root: Path, source_commit: str) -> Path:
    binary = root / "task-bin"
    executable(
        binary / "git",
        "#!/bin/sh\n"
        "set -eu\n"
        "if [ \"$1\" = -C ] && [ \"$3\" = rev-parse ]; then printf '%s\\n' \"$SOURCE_COMMIT\"; exit 0; fi\n"
        "exit 99\n",
    )
    executable(
        binary / "uv",
        "#!/bin/sh\n"
        "set -eu\n"
        "target=\n"
        "while [ $# -gt 0 ]; do [ \"$1\" = --target ] && { target=$2; break; }; shift; done\n"
        "mkdir -p \"$target\"\n",
    )
    executable(
        binary / "curl",
        "#!/bin/sh\n"
        "set -eu\n"
        "while [ $# -gt 0 ]; do [ \"$1\" = -o ] && { output=$2; break; }; shift; done\n"
        "printf 'fixture wheel' > \"$output\"\n",
    )
    executable(
        binary / "docker",
        "#!/bin/sh\n"
        "set -eu\n"
        "printf '%s %s\\n' \"${SOURCE_DATE_EPOCH:-unset}\" \"$*\" >> \"$DOCKER_CALLS\"\n"
        "if [ \"$1\" = buildx ] && [ \"$2\" = build ]; then\n"
        "  for context do :; done\n"
        "  test -x \"$context/verifier/bin/apt-get\"\n"
        "  exit 0\n"
        "fi\n"
        "if [ \"$1\" = image ] && [ \"$2\" = inspect ]; then\n"
        "  case \"$*\" in *--format*) :;; *) exit 0;; esac\n"
        "  case \"$*\" in *'{{.Id}}'*) printf '%s\\n' \"${SOURCE_IMAGE_ID:-${3##*@}}\"; exit 0;; esac\n"
        "  case \"$*\" in *'{{json .Config}}'*) printf '%s\\n' '{\"Env\":[\"PATH=/usr/bin\"],\"Volumes\":null}'; exit 0;; esac\n"
        "  tag=$3; task=${tag#*:}; task=${task%-pi-0.82.1}\n"
        "  case $task in alpha) n=6;; beta) n=7;; gamma) n=8;; *) exit 98;; esac\n"
        "  printf '%s@sha256:%064x\\n' \"${tag%%:*}\" \"$n\"; exit 0\n"
        "fi\n"
        "if [ \"$1\" = load ]; then exit 0; fi\n"
        "if [ \"$1\" = run ]; then exit 0; fi\n"
        "exit 99\n",
    )
    return binary


def test_terminal_bench_builder_preserves_authentic_tasks_and_builds_pinned_images(
    tmp_path: Path,
) -> None:
    task_ids = ("alpha", "beta", "gamma")
    inputs = fixture_inputs(tmp_path)
    source = terminal_bench_source(tmp_path, task_ids)
    empty_verifier = tmp_path / "empty-verifier"
    empty_verifier.mkdir()
    manifest = terminal_bench_manifest(
        tmp_path, inputs, task_ids, tree_sha256(empty_verifier),
    )
    tools = fake_task_builder_tools(tmp_path, "1" * 40)
    tasks_dir = tmp_path / "admitted-tasks"
    wheelhouse = tmp_path / "wheelhouse"
    wheelhouse.mkdir()
    (wheelhouse / "pytest-8.4.1-py3-none-any.whl").write_bytes(b"fixture wheel")
    environment = {
        "HOME": str(tmp_path / "home"), "PATH": f"{tools}:/usr/bin:/bin",
        "SOURCE_COMMIT": "1" * 40, "SOURCE_DIR": str(source),
        "TASKS_DIR": str(tasks_dir), "MANIFEST": str(manifest),
        "WHEELHOUSE": str(wheelhouse),
        "NODE_BIN": str(inputs["node"]), "NPM_ROOT": str(inputs["npm"]),
        "PI_ROOT": str(inputs["pi"]),
        "DOCKER_CALLS": str(tmp_path / "docker-calls.txt"),
    }

    completed = subprocess.run(
        [str(TASK_BUILD_SCRIPT)], cwd=HARNESS_DIR, env=environment,
        check=True, capture_output=True, text=True,
    )

    calls = Path(environment["DOCKER_CALLS"]).read_text(encoding="utf-8")
    assert calls.count(
        "1786481201 buildx build --network none --pull=false --no-cache "
        "--provenance=false --build-arg SOURCE_DATE_EPOCH=1786481201"
    ) == 3
    assert calls.count("type=oci,name=cortex-terminal-bench-2.1:") == 3
    assert calls.count("rewrite-timestamp=true") == 3
    assert calls.count("1786481201 load --input") == 3
    assert calls.count("1786481201 run --rm --network none --pull never") >= 3
    for task_id in task_ids:
        original = source / "tasks" / task_id
        admitted = tasks_dir / task_id
        assert (admitted / "instruction.md").read_bytes() == (original / "instruction.md").read_bytes()
        assert (admitted / "tests/test.sh").read_bytes() == (original / "tests/test.sh").read_bytes()
        assert (admitted / "tests/test_outputs.py").read_bytes() == (
            original / "tests/test_outputs.py"
        ).read_bytes()
        task_config = (admitted / "task.toml").read_text(encoding="utf-8")
        assert "allow_internet" not in task_config
        # The imported task declares the widest plan; the campaign's `network` block is what
        # narrows it, so `allowed_hosts` is dropped entirely rather than emitted empty.
        assert "network_mode = \"public\"" in task_config
        assert "allowed_hosts" not in task_config
        assert f"@sha256:{task_ids.index(task_id) + 6:064x}" in task_config
    output = json.loads(completed.stdout)
    assert output["ok"] is True
    assert [task["task_id"] for task in output["tasks"]] == list(task_ids)


def test_terminal_bench_builder_refuses_a_source_image_digest_mismatch(
    tmp_path: Path,
) -> None:
    task_ids = ("alpha", "beta", "gamma")
    inputs = fixture_inputs(tmp_path)
    terminal_bench_source(tmp_path, task_ids)
    empty_verifier = tmp_path / "empty-verifier"
    empty_verifier.mkdir()
    manifest = terminal_bench_manifest(
        tmp_path, inputs, task_ids, tree_sha256(empty_verifier),
    )
    tools = fake_task_builder_tools(tmp_path, "1" * 40)
    wheelhouse = tmp_path / "wheelhouse"
    wheelhouse.mkdir()
    (wheelhouse / "pytest-8.4.1-py3-none-any.whl").write_bytes(b"fixture wheel")
    environment = {
        "HOME": str(tmp_path / "home"), "PATH": f"{tools}:/usr/bin:/bin",
        "SOURCE_COMMIT": "1" * 40,
        "SOURCE_DIR": str(tmp_path / "terminal-bench-source"),
        "TASKS_DIR": str(tmp_path / "admitted-tasks"), "MANIFEST": str(manifest),
        "WHEELHOUSE": str(wheelhouse),
        "NODE_BIN": str(inputs["node"]), "NPM_ROOT": str(inputs["npm"]),
        "PI_ROOT": str(inputs["pi"]), "SOURCE_IMAGE_ID": f"sha256:{'f' * 64}",
        "DOCKER_CALLS": str(tmp_path / "docker-calls.txt"),
    }

    completed = subprocess.run(
        [str(TASK_BUILD_SCRIPT)], cwd=HARNESS_DIR, env=environment,
        check=False, capture_output=True, text=True,
    )

    assert completed.returncode == 1
    assert "source image digest" in completed.stderr
    assert "build --network none" not in Path(environment["DOCKER_CALLS"]).read_text()


def test_terminal_bench_builder_refuses_a_missing_pinned_wheel_without_acquire(
    tmp_path: Path,
) -> None:
    task_ids = ("alpha", "beta", "gamma")
    inputs = fixture_inputs(tmp_path)
    terminal_bench_source(tmp_path, task_ids)
    empty_verifier = tmp_path / "empty-verifier"
    empty_verifier.mkdir()
    manifest = terminal_bench_manifest(
        tmp_path, inputs, task_ids, tree_sha256(empty_verifier),
    )
    tools = fake_task_builder_tools(tmp_path, "1" * 40)
    environment = {
        "HOME": str(tmp_path / "home"), "PATH": f"{tools}:/usr/bin:/bin",
        "SOURCE_COMMIT": "1" * 40,
        "SOURCE_DIR": str(tmp_path / "terminal-bench-source"),
        "TASKS_DIR": str(tmp_path / "admitted-tasks"), "MANIFEST": str(manifest),
        "WHEELHOUSE": str(tmp_path / "empty-wheelhouse"),
        "NODE_BIN": str(inputs["node"]), "NPM_ROOT": str(inputs["npm"]),
        "PI_ROOT": str(inputs["pi"]), "DOCKER_CALLS": str(tmp_path / "docker-calls.txt"),
    }

    completed = subprocess.run(
        [str(TASK_BUILD_SCRIPT)], cwd=HARNESS_DIR, env=environment,
        check=False, capture_output=True, text=True,
    )

    assert completed.returncode == 1
    assert "pinned verifier wheel is unavailable" in completed.stderr
    assert not Path(environment["DOCKER_CALLS"]).exists()
