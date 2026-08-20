# input:  runtime image scripts, pinned manifests and local CLI fixtures
# output: vendor isolation and Cortex-smoke image proofs
# pos:    Contract tests for benchmark runtime images
# >>> If I am updated, update my header and folder CORTEX.md <<<

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

HARNESS_DIR = Path(__file__).resolve().parents[2]
BUILD_SCRIPT = HARNESS_DIR / "scripts" / "build-zero-paid-runtime-image.sh"
TASK_BUILD_SCRIPT = HARNESS_DIR / "scripts" / "provision-terminal-bench-images.sh"
PREFLIGHT_SCRIPT = HARNESS_DIR / "scripts" / "vendor-runtime-preflight.js"
DIGEST = f"sha256:{'a' * 64}"
IMAGE_REF = f"cortex-bench-zero-paid-runtime@{DIGEST}"
RUNTIME_MANIFEST = HARNESS_DIR / "scripts" / "zero-paid-runtime-inputs.json"
TERMINAL_BENCH_MANIFEST = HARNESS_DIR / "scripts" / "terminal-bench-2.1-images.json"
VENDORS = ("pi", "claude-code", "codex")
TASKS = ("chess-best-move", "constraints-scheduling", "db-wal-recovery")
FAKE_CODEX_PREFLIGHT = """#!/usr/bin/python3
import json, os, re, sys, urllib.request
from pathlib import Path
if sys.argv[1:] == ['--version']:
    print('codex-cli 0.148.0')
    raise SystemExit(0)
config = (Path(os.environ['CODEX_HOME']) / 'config.toml').read_text()
expected = "__EXPECTED_MODEL__"
if f'model = "{expected}"' not in config:
    print('wrong preflight model', file=sys.stderr)
    raise SystemExit(2)
base = re.search(r'base_url = "([^"]+)"', config).group(1)
body = json.dumps({'model': expected}).encode()
request = urllib.request.Request(base + '/responses', data=body, method='POST')
with urllib.request.urlopen(request) as response:
    response.read()
"""


def test_runtime_manifest_pins_the_three_p0_vendor_artifacts() -> None:
    document = json.loads(RUNTIME_MANIFEST.read_text(encoding="utf-8"))

    assert document["schema_version"] == "cortex-bench-vendor-runtime-inputs/2"
    assert document["vendors"]["pi"] == {
        "package": "@earendil-works/pi-coding-agent",
        "version": "0.82.1",
        "tree_sha256": "6bc5e821c034136ad52ae104fe3bc51f954950bc895ce35abc1e64a25f2375d8",
    }
    assert document["vendors"]["claude-code"] == {
        "distribution": "native",
        "platform": "linux-x64",
        "version": "2.1.232",
        "sha256": "61d23f8749136907d586d5b11831ea8a5234d4c1dea40a5e55c33b52e204c6d1",
        "size_bytes": 323021104,
    }
    codex = document["vendors"]["codex"]
    assert codex["package"] == "@openai/codex"
    assert codex["version"] == "0.148.0"
    assert codex["npm_integrity"] == (
        "sha512-bh5kH9+BMrFaHGmLeoSansPdfRksvr4UXzjQInns/KRO7r8VJ+6AAW+SqUsE8XcG3+OW/mI4EEy8Gpo9UDXGvQ=="
    )
    assert codex["platform_package"] == "@openai/codex@0.148.0-linux-x64"
    assert codex["platform_npm_integrity"] == (
        "sha512-uDT9s7AfMr9xLuJX3ZLVWHgHkUpCnZ33CZjZEdVQhrYCIErkDHsCW5TG290nNjaKngK0WxGt5uCcxeUHv9MWWA=="
    )
    assert codex["native_binary_path"] == (
        "vendor/x86_64-unknown-linux-musl/bin/codex"
    )
    assert codex["native_binary_sha256"] == (
        "ac2cfed85fb647d61e0150b8548102b330e4799d9d81ad5d354de701edf6b074"
    )


def test_terminal_bench_manifest_has_one_digest_pinned_variant_per_vendor_and_task() -> None:
    document = json.loads(TERMINAL_BENCH_MANIFEST.read_text(encoding="utf-8"))

    assert document["schema_version"] == "cortex-terminal-bench-images/2"
    assert tuple(document["vendors"]) == VENDORS
    assert tuple(task["task_id"] for task in document["tasks"]) == TASKS
    for task in document["tasks"]:
        assert tuple(task["variants"]) == VENDORS
        assert "final_image_tag" not in task
        assert "final_image_digest" not in task
        for vendor, variant in task["variants"].items():
            assert variant["final_image_tag"].endswith(f"-{vendor}-{document['vendors'][vendor]['version']}")
            assert variant["final_image_digest"].startswith("sha256:")
            assert len(variant["final_image_digest"]) == 71
            assert set(variant) == {"final_image_tag", "final_image_digest"}
    smoke = document["cortex_smoke"]
    selected = next(task for task in document["tasks"] if task["task_id"] == smoke["task_id"])
    assert smoke["final_image_tag"].endswith("-cortex-smoke-2026.8.6")
    assert smoke["final_image_digest"].startswith("sha256:")
    campaign = yaml.safe_load(
        (HARNESS_DIR.parent / "campaigns/terminal-bench-2.1-deepseek-paid-smoke.yaml").read_text()
    )
    assert campaign["tasks"] == [{
        "task_id": smoke["task_id"],
        "path": f"tasks/terminal-bench-2.1/{smoke['task_id']}",
        "image_ref": f"{smoke['final_image_tag'].split(':')[0]}@{smoke['final_image_digest']}",
    }]
    assert selected["task_id"] == "constraints-scheduling"


def executable(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    path.chmod(0o755)
    return path


def test_codex_runtime_preflight_selects_the_campaign_model(tmp_path: Path) -> None:
    node = shutil.which("node")
    assert node
    campaign = yaml.safe_load(
        (HARNESS_DIR.parent / "campaigns/terminal-bench-2.1-vendor-codex.yaml").read_text()
    )
    fake_source = FAKE_CODEX_PREFLIGHT.replace(
        "__EXPECTED_MODEL__", campaign["arms"][0]["model"])
    fake = executable(tmp_path / "bin/codex", fake_source)
    env = {**os.environ, "PATH": str(fake.parent)}

    result = subprocess.run(
        [node, str(PREFLIGHT_SCRIPT), "--vendor", "codex", "--cli", str(fake)],
        capture_output=True, text=True, env=env, timeout=30,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {
        "ok": True, "vendor": "codex", "version": "codex-cli 0.148.0", "requests": 1,
    }


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
        "    print(value)\n"
        "elif sys.argv[1] == '-e':\n"
        "    value = json.load(open(sys.argv[3]))['vendors'][sys.argv[4]][sys.argv[5]]\n"
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
    claude = executable(
        root / "claude/claude",
        "#!/bin/sh\nprintf '2.1.232 (Claude Code)\\n'\n",
    )
    codex = root / "codex"
    executable(codex / "bin/codex.js", "#!/usr/bin/env node\n")
    (codex / "package.json").write_text(
        json.dumps({"name": "@openai/codex", "version": "0.148.0"}), encoding="utf-8",
    )
    platform = codex / "node_modules/@openai/codex-linux-x64"
    native = executable(
        platform / "vendor/x86_64-unknown-linux-musl/bin/codex", "fixture codex native\n",
    )
    (platform / "package.json").write_text(
        json.dumps({"name": "@openai/codex", "version": "0.148.0-linux-x64"}),
        encoding="utf-8",
    )
    return {
        "node": node, "npm": npm, "pi": pi, "claude": claude,
        "codex": codex, "codex_native": native,
    }


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
        "schema_version": "cortex-bench-vendor-runtime-inputs/2",
        "node": {"version": "v22.19.0", "sha256": hashlib.sha256(
            inputs["node"].read_bytes()).hexdigest()},
        "npm": {"version": "10.9.3", "tree_sha256": tree_sha256(inputs["npm"])},
        "vendors": {
            "pi": {
                "package": "@earendil-works/pi-coding-agent", "version": "0.82.1",
                "tree_sha256": tree_sha256(inputs["pi"]),
            },
            "claude-code": {
                "distribution": "native", "platform": "linux-x64", "version": "2.1.232",
                "sha256": hashlib.sha256(inputs["claude"].read_bytes()).hexdigest(),
                "size_bytes": inputs["claude"].stat().st_size,
            },
            "codex": {
                "package": "@openai/codex", "version": "0.148.0",
                "npm_integrity": "sha512-fixture-main", "tree_sha256": tree_sha256(inputs["codex"]),
                "platform_package": "@openai/codex@0.148.0-linux-x64",
                "platform_npm_integrity": "sha512-fixture-platform",
                "native_binary_path": "vendor/x86_64-unknown-linux-musl/bin/codex",
                "native_binary_sha256": hashlib.sha256(inputs["codex_native"].read_bytes()).hexdigest(),
                "target": "x86_64-unknown-linux-musl",
            },
        },
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
  grep -q 'debian@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818' "$context/Dockerfile"
  case "$VENDOR" in
    pi)
      test -x "$context/node-runtime/bin/node"
      test -x "$context/vendor-runtime/dist/cli.js"
      grep -q '@earendil-works/pi-coding-agent' "$context/vendor-runtime/package.json"
      grep -q '/opt/vendor-runtime/dist/cli.js' "$context/Dockerfile"
      ! grep -Eq '/usr/local/bin/(claude|codex)' "$context/Dockerfile"
      ;;
    claude-code)
      test -x "$context/vendor-runtime/claude"
      test -x "$context/node-runtime/bin/node"
      grep -q '/usr/local/bin/claude' "$context/Dockerfile"
      ! grep -Eq '/usr/local/bin/(pi|codex)' "$context/Dockerfile"
      ;;
    codex)
      test -x "$context/node-runtime/bin/node"
      test -x "$context/vendor-runtime/bin/codex.js"
      grep -q '@openai/codex' "$context/vendor-runtime/package.json"
      grep -q '/usr/local/bin/codex' "$context/Dockerfile"
      ! grep -Eq '/usr/local/bin/(pi|claude)' "$context/Dockerfile"
      ;;
    *) exit 97;;
  esac
  ! grep -Rq 'mariozechner/pi-coding-agent' "$context"
  exit 0
fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  printf '%s\n' "$FAKE_IMAGE_REF"
  exit 0
fi
if [ "$1" = run ]; then
  case "$*" in
    *'/tmp/vendor-runtime-preflight.js'*) ;;
    *) exit 96;;
  esac
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
        "VENDOR": "pi",
        "DOCKER_CALLS": str(root / "docker-calls.txt"), "FAKE_IMAGE_REF": IMAGE_REF,
        "NODE_BIN": str(inputs["node"]), "NPM_ROOT": str(inputs["npm"]),
        "PI_ROOT": str(inputs["pi"]), "CLAUDE_BIN": str(inputs["claude"]),
        "CODEX_ROOT": str(inputs["codex"]),
        "RUNTIME_INPUTS": str(runtime_manifest(root, inputs)),
        "IMAGE_TAG": "cortex-bench-zero-paid-runtime:test",
    }


@pytest.mark.parametrize(
    ("vendor", "version"),
    (("pi", "0.82.1"), ("claude-code", "2.1.232"), ("codex", "0.148.0")),
)
def test_builder_stages_only_the_selected_vendor_and_preflights_offline(
    tmp_path: Path, vendor: str, version: str,
) -> None:
    inputs = fixture_inputs(tmp_path)
    docker = fake_docker(tmp_path)
    environment = explicit_environment(tmp_path, inputs, docker)
    environment["VENDOR"] = vendor
    target_input = {"pi": "PI_ROOT", "claude-code": "CLAUDE_BIN", "codex": "CODEX_ROOT"}[vendor]
    for name in ("PI_ROOT", "CLAUDE_BIN", "CODEX_ROOT"):
        if name != target_input:
            environment[name] = "/unavailable-non-target-runtime"

    completed = subprocess.run(
        [str(BUILD_SCRIPT)], cwd=HARNESS_DIR, env=environment,
        check=True, capture_output=True, text=True,
    )

    invoked = Path(environment["DOCKER_CALLS"]).read_text(encoding="utf-8").splitlines()
    assert any("build --network none --pull=false --provenance=false" in call for call in invoked)
    preflight = next(call for call in invoked if call.startswith("run --rm --network none --pull never"))
    assert "--mount type=bind" in preflight
    assert "/tmp/vendor-runtime-preflight.js" in preflight
    assert completed.stdout.splitlines() == [
        f"vendor={vendor}", f"vendor_version={version}",
        f"image_ref={IMAGE_REF}", f"image_digest={DIGEST}",
    ]


def test_preflight_requires_cli_isolation_and_one_loopback_request(tmp_path: Path) -> None:
    binary = executable(
        tmp_path / "bin/pi",
        "#!/usr/bin/python3\n"
        "import json, os, sys, urllib.request\n"
        "if sys.argv[1:] == ['--version']:\n"
        "    print('0.82.1')\n"
        "else:\n"
        "    root = os.environ['PI_CODING_AGENT_DIR']\n"
        "    base = json.load(open(root + '/models.json'))['providers']['deepseek']['baseUrl']\n"
        "    request = urllib.request.Request(base + '/chat/completions', data=b'{\"model\":\"deepseek-chat\"}', headers={'content-type': 'application/json'})\n"
        "    urllib.request.urlopen(request).read()\n",
    )
    environment = {
        "HOME": str(tmp_path), "PATH": str(binary.parent),
    }

    completed = subprocess.run(
        ["/usr/bin/node", str(PREFLIGHT_SCRIPT), "--vendor", "pi", "--cli", str(binary)],
        env=environment, check=True, capture_output=True, text=True, timeout=30,
    )

    assert json.loads(completed.stdout) == {
        "ok": True, "vendor": "pi", "version": "0.82.1", "requests": 1,
    }


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

    assert completed.stdout.splitlines()[2] == f"image_ref={IMAGE_REF}"


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
        "schema_version": "cortex-terminal-bench-images/2",
        "source": {
            "repository": "https://github.com/harbor-framework/terminal-bench-2-1.git",
            "commit": "1" * 40,
        },
        "runtime_inputs": str(runtime_manifest(root, inputs)),
        "build_epoch": 1786481201,
        "vendors": {
            "pi": {"version": "0.82.1"},
            "claude-code": {"version": "2.1.232"},
            "codex": {"version": "0.148.0"},
        },
        "cortex_smoke": {
            "task_id": task_ids[0], "version": "2026.8.6",
            "final_image_tag": f"cortex-terminal-bench-2.1:{task_ids[0]}-cortex-smoke-2026.8.6",
            "final_image_digest": f"sha256:{15:064x}",
        },
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
                "variants": {
                    vendor: {
                        "final_image_tag": (
                            f"cortex-terminal-bench-2.1:{task_id}-{vendor}-{version}"
                        ),
                        "final_image_digest": f"sha256:{index * 3 + vendor_index + 6:064x}",
                    }
                    for vendor_index, (vendor, version) in enumerate((
                        ("pi", "0.82.1"), ("claude-code", "2.1.232"),
                        ("codex", "0.148.0"),
                    ))
                },
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
        "if [ \"${1:-}\" = python ] && [ \"${2:-}\" = find ]; then printf '/usr/bin/python3\\n'; exit 0; fi\n"
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
        "  vendor=${context##*/}\n"
        "  case $vendor in\n"
        "    pi) test -x \"$context/vendor-runtime/dist/cli.js\";;\n"
        "    claude-code) test -x \"$context/vendor-runtime/claude\";;\n"
        "    codex) test -x \"$context/vendor-runtime/bin/codex.js\";;\n"
        "    cortex-smoke) test -x \"$context/pi-agent/dist/cli.js\"; test -f \"$context/npm/package.json\";;\n"
        "    *) exit 97;;\n"
        "  esac\n"
        "  exit 0\n"
        "fi\n"
        "if [ \"$1\" = image ] && [ \"$2\" = inspect ]; then\n"
        "  case \"$*\" in *--format*) :;; *) exit 0;; esac\n"
        "  case \"$*\" in *'{{.Id}}'*) printf '%s\\n' \"${SOURCE_IMAGE_ID:-${3##*@}}\"; exit 0;; esac\n"
        "  case \"$*\" in *'{{json .Config}}'*) printf '%s\\n' '{\"Env\":[\"PATH=/usr/bin\"],\"Volumes\":null}'; exit 0;; esac\n"
        "  tag=$3; key=${tag#*:}\n"
        "  case $key in\n"
        "    alpha-pi-0.82.1) n=6;; alpha-claude-code-2.1.232) n=7;; alpha-codex-0.148.0) n=8;;\n"
        "    beta-pi-0.82.1) n=9;; beta-claude-code-2.1.232) n=10;; beta-codex-0.148.0) n=11;;\n"
        "    gamma-pi-0.82.1) n=12;; gamma-claude-code-2.1.232) n=13;; gamma-codex-0.148.0) n=14;;\n"
        "    alpha-cortex-smoke-2026.8.6) n=15;;\n"
        "    *) exit 98;;\n"
        "  esac\n"
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
        "PI_ROOT": str(inputs["pi"]), "CLAUDE_BIN": str(inputs["claude"]),
        "CODEX_ROOT": str(inputs["codex"]),
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
    ) == 9
    assert calls.count("type=oci,name=cortex-terminal-bench-2.1:") == 9
    assert calls.count("rewrite-timestamp=true") == 9
    assert calls.count("1786481201 load --input") == 9
    assert calls.count("1786481201 run --rm --network none --pull never") >= 9
    for task_index, task_id in enumerate(task_ids):
        original = source / "tasks" / task_id
        task_documents = []
        for vendor_index, vendor in enumerate(VENDORS):
            admitted = tasks_dir / vendor / task_id
            assert (admitted / "instruction.md").read_bytes() == (original / "instruction.md").read_bytes()
            assert (admitted / "tests/test.sh").read_bytes() == (original / "tests/test.sh").read_bytes()
            assert (admitted / "tests/test_outputs.py").read_bytes() == (
                original / "tests/test_outputs.py"
            ).read_bytes()
            task_config = (admitted / "task.toml").read_text(encoding="utf-8")
            assert "allow_internet" not in task_config
            assert "network_mode = \"public\"" in task_config
            assert "allowed_hosts" not in task_config
            assert f"@sha256:{task_index * 3 + vendor_index + 6:064x}" in task_config
            task_documents.append(task_config.replace(task_config.split("docker_image = ")[1].splitlines()[0], '"<IMAGE>"'))
        assert len(set(task_documents)) == 1
    output = json.loads(completed.stdout)
    assert output["ok"] is True
    assert [(variant["task_id"], variant["vendor"]) for variant in output["variants"]] == [
        (task_id, vendor) for task_id in task_ids for vendor in VENDORS
    ]


def test_terminal_bench_builder_can_rebuild_only_three_codex_variants(
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
    wheelhouse = tmp_path / "wheelhouse"
    wheelhouse.mkdir()
    (wheelhouse / "pytest-8.4.1-py3-none-any.whl").write_bytes(b"fixture wheel")
    environment = {
        "HOME": str(tmp_path / "home"), "PATH": f"{tools}:/usr/bin:/bin",
        "SOURCE_COMMIT": "1" * 40, "SOURCE_DIR": str(source),
        "TASKS_DIR": str(tmp_path / "admitted-tasks"), "MANIFEST": str(manifest),
        "WHEELHOUSE": str(wheelhouse), "NODE_BIN": str(inputs["node"]),
        "NPM_ROOT": str(inputs["npm"]), "PI_ROOT": "/unavailable-pi",
        "CLAUDE_BIN": "/unavailable-claude", "CODEX_ROOT": str(inputs["codex"]),
        "DOCKER_CALLS": str(tmp_path / "docker-calls.txt"),
    }

    completed = subprocess.run(
        [str(TASK_BUILD_SCRIPT), "--vendor", "codex"], cwd=HARNESS_DIR,
        env=environment, check=True, capture_output=True, text=True,
    )

    calls = Path(environment["DOCKER_CALLS"]).read_text(encoding="utf-8")
    assert calls.count("buildx build") == 3
    output = json.loads(completed.stdout)
    assert [(variant["task_id"], variant["vendor"]) for variant in output["variants"]] == [
        (task_id, "codex") for task_id in task_ids
    ]
    assert not (tmp_path / "admitted-tasks/pi").exists()
    assert not (tmp_path / "admitted-tasks/claude-code").exists()


def test_terminal_bench_builder_reproduces_the_cortex_smoke_image(tmp_path: Path) -> None:
    task_ids = ("alpha", "beta", "gamma")
    inputs = fixture_inputs(tmp_path)
    source = terminal_bench_source(tmp_path, task_ids)
    empty_verifier = tmp_path / "empty-verifier"; empty_verifier.mkdir()
    manifest = terminal_bench_manifest(tmp_path, inputs, task_ids, tree_sha256(empty_verifier))
    tools = fake_task_builder_tools(tmp_path, "1" * 40)
    wheelhouse = tmp_path / "wheelhouse"; wheelhouse.mkdir()
    (wheelhouse / "pytest-8.4.1-py3-none-any.whl").write_bytes(b"fixture wheel")
    environment = {
        "HOME": str(tmp_path / "home"), "PATH": f"{tools}:/usr/bin:/bin",
        "SOURCE_COMMIT": "1" * 40, "SOURCE_DIR": str(source),
        "TASKS_DIR": str(tmp_path / "admitted-tasks"), "MANIFEST": str(manifest),
        "WHEELHOUSE": str(wheelhouse), "NODE_BIN": str(inputs["node"]),
        "NPM_ROOT": str(inputs["npm"]), "PI_ROOT": str(inputs["pi"]),
        "CLAUDE_BIN": str(inputs["claude"]), "CODEX_ROOT": str(inputs["codex"]),
        "DOCKER_CALLS": str(tmp_path / "docker-calls.txt"),
    }
    completed = subprocess.run(
        [str(TASK_BUILD_SCRIPT), "--cortex-smoke"], cwd=HARNESS_DIR,
        env=environment, check=True, capture_output=True, text=True,
    )
    calls = Path(environment["DOCKER_CALLS"]).read_text(encoding="utf-8")
    assert calls.count("buildx build") == 1
    assert calls.count("run --rm --network none --pull never") == 1
    task = tmp_path / "admitted-tasks/alpha/task.toml"
    assert f"@sha256:{15:064x}" in task.read_text(encoding="utf-8")
    assert json.loads(completed.stdout)["image_digest"] == f"sha256:{15:064x}"


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
        "PI_ROOT": str(inputs["pi"]), "CLAUDE_BIN": str(inputs["claude"]),
        "CODEX_ROOT": str(inputs["codex"]), "SOURCE_IMAGE_ID": f"sha256:{'f' * 64}",
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
        "PI_ROOT": str(inputs["pi"]), "CLAUDE_BIN": str(inputs["claude"]),
        "CODEX_ROOT": str(inputs["codex"]),
        "DOCKER_CALLS": str(tmp_path / "docker-calls.txt"),
    }

    completed = subprocess.run(
        [str(TASK_BUILD_SCRIPT)], cwd=HARNESS_DIR, env=environment,
        check=False, capture_output=True, text=True,
    )

    assert completed.returncode == 1
    assert "pinned verifier wheel is unavailable" in completed.stderr
    assert not Path(environment["DOCKER_CALLS"]).exists()
