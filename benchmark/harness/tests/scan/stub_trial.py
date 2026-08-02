# input:  real npm bundle, pinned Debian image, and fake Claude fixture
# output: collected real agent-run, lifecycle, network, and scan evidence
# pos:    Reusable Harbor container integration for the genuine run path
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
import hashlib
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import override

from harbor.environments.base import ExecResult
from harbor.environments.docker.docker import DockerEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.task.config import EnvironmentConfig
from harbor.models.trial.config import ServiceVolumeConfig
from harbor.models.trial.paths import TrialPaths

from cortex_bench_harness import CortexBenchAgent
from cortex_bench_harness.scan import ArtifactSet, ScanPolicy, scan_trial_artifacts

IMAGE_DIGEST = "sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818"
IMAGE_REF = f"debian@{IMAGE_DIGEST}"
WHEEL_NAME = "cortex_bench_harness-0.1.0-py3-none-any.whl"
MODEL_NAME = "claude-fake-benchmark"
ROOT_RUN_ID = "root-real-agent-run"
TRIAL_ID = "trial-real-agent-run"
AGENT_USER = "cortex-agent"
MIN_FREE_BYTES = 10 * 1024**3
MAX_IMAGE_BYTES = 2 * 1024**3
FORBIDDEN_CREDENTIAL = "sk-ant-REAL-CREDENTIAL-MUST-NOT-ENTER"
URI_HOST = re.compile(rb"https?://[^/\s\"']+")
IPV4 = re.compile(rb"\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b")
HOME_PATH = re.compile(rb"/home/[^/\x00\s]+")


@dataclass(frozen=True)
class Layout:
    root: Path
    repo_root: Path
    harness_dir: Path
    trial_paths: TrialPaths
    environment_dir: Path
    workspace: Path
    cortex_home: Path
    fake_bin: Path
    node_runtime: Path
    wheel_path: Path
    npm_artifact: Path


@dataclass(frozen=True)
class TrialEvidence:
    image_size_bytes: int
    inherited_real_run: bool
    run_exit_code: int
    resolved_cwd: str
    raw_usage: dict[str, int]
    event_types: frozenset[str]
    cost_record: dict[str, int | float | None]
    terminal_state: str
    trajectory_validation: dict[str, object]
    scope: dict[str, object]
    required_scan_clean: bool
    whole_tree_scan_clean: bool
    outbound_routes: list[str]


class RecordingCortexBenchAgent(CortexBenchAgent):
    run_result: ExecResult | None = None

    @override
    async def exec_as_agent(
        self, environment: DockerEnvironment, command: str,
        env: dict[str, str] | None = None, cwd: str | None = None,
        timeout_sec: int | None = None,
    ) -> ExecResult:
        result = await super().exec_as_agent(environment, command, env, cwd, timeout_sec)
        if command.startswith("cortex agent-run "):
            self.run_result = result
            self.logs_dir.mkdir(parents=True, exist_ok=True)
            (self.logs_dir / "stdout.txt").write_text(result.stdout or "")
            (self.logs_dir / "stderr.txt").write_text(result.stderr or "")
        return result


def build_environment() -> dict[str, str]:
    allowed = ("PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "UV_CACHE_DIR", "PNPM_HOME")
    environment = {key: os.environ[key] for key in allowed if key in os.environ}
    environment["PYTHONNOUSERSITE"] = "1"
    return environment


def run_command(arguments: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        arguments, cwd=cwd, env=build_environment(), check=True,
        capture_output=True, text=True, timeout=900,
    )


def inspect_image() -> dict[str, object]:
    free_bytes = shutil.disk_usage("/").free
    assert free_bytes >= MIN_FREE_BYTES, f"Docker disk gate failed: {free_bytes}"
    result = run_command(["docker", "image", "inspect", IMAGE_REF])
    image = json.loads(result.stdout)[0]
    size = image["Size"]
    assert isinstance(size, int) and size < MAX_IMAGE_BYTES
    return {"image_ref": IMAGE_REF, "image_digest": IMAGE_DIGEST, "image_size_bytes": size}


def image_inventory() -> set[str]:
    result = run_command(["docker", "image", "ls", "--no-trunc", "--quiet"])
    return set(result.stdout.splitlines())


def session_id() -> str:
    return f"cortex-real-agent-run-{os.getpid()}"


def disconnect_container_network() -> None:
    labels = ["--filter", f"label=com.docker.compose.project={session_id()}"]
    container = run_command([
        "docker", "ps", *labels, "--filter", "label=com.docker.compose.service=main",
        "--format", "{{.ID}}",
    ]).stdout.splitlines()
    networks = run_command([
        "docker", "network", "ls", *labels, "--format", "{{.Name}}",
    ]).stdout.splitlines()
    assert len(container) == 1 and len(networks) == 1
    run_command(["docker", "network", "disconnect", "-f", networks[0], container[0]])


def build_harness_wheel(harness_dir: Path) -> Path:
    run_command(["bash", "scripts/build-wheel.sh"], cwd=harness_dir)
    wheel = harness_dir / "dist" / WHEEL_NAME
    assert wheel.is_file()
    return wheel


def build_node_runtime(root: Path) -> Path:
    node = Path(shutil.which("node") or "").resolve()
    npm = Path(shutil.which("npm") or "").resolve()
    assert node.is_file() and npm.is_file()
    runtime = root / "node-runtime"
    (runtime / "bin").mkdir(parents=True)
    shutil.copy2(node, runtime / "bin/node")
    shutil.copytree(npm.parents[1], runtime / "lib/node_modules/npm", symlinks=True)
    (runtime / "bin/npm").symlink_to("../lib/node_modules/npm/bin/npm-cli.js")
    return runtime


def build_npm_artifact(root: Path, repo_root: Path) -> Path:
    output = root / "npm-artifact"
    output.mkdir()
    run_command(["pnpm", "--filter", "@cortex-agent/web...", "run", "build"], repo_root)
    run_command(["npm", "pack", "--pack-destination", str(output)], repo_root / "agent-server")
    artifacts = list(output.glob("cortex-agent-server-*.tgz"))
    assert len(artifacts) == 1
    return artifacts[0]


def write_profile(cortex_home: Path) -> None:
    profile = {
        "defaultProfile": "benchmark",
        "profiles": {"benchmark": {
            "model": MODEL_NAME, "backend": "claude", "provider": "anthropic",
            "claudeBackend": "print", "fallback": [],
            "extraEnv": {"FAKE_CLAUDE_ARTIFACT_DIR": "/logs/artifacts"},
        }},
    }
    config = cortex_home / "config"
    config.mkdir(parents=True)
    (config / "profiles.json").write_text(json.dumps(profile))
    for name in ("projects", "tmp", "xdg-config", "xdg-cache"):
        (cortex_home / name).mkdir()


def install_fake_claude(root: Path) -> Path:
    fake_bin = root / "fake-bin"
    fake_bin.mkdir()
    source = Path(__file__).with_name("fake_claude.sh")
    target = fake_bin / "claude"
    shutil.copy2(source, target)
    target.chmod(0o755)
    return fake_bin


def create_layout(root: Path) -> Layout:
    harness_dir = Path(__file__).resolve().parents[2]
    repo_root = harness_dir.parents[1]
    trial_paths = TrialPaths(root / "trial")
    trial_paths.mkdir()
    environment_dir = root / "environment"
    workspace = root / "workspace"
    cortex_home = root / "cortex-home"
    environment_dir.mkdir()
    workspace.mkdir()
    write_profile(cortex_home)
    return Layout(
        root, repo_root, harness_dir, trial_paths, environment_dir, workspace,
        cortex_home, install_fake_claude(root), build_node_runtime(root),
        build_harness_wheel(harness_dir), build_npm_artifact(root, repo_root),
    )


def create_environment(layout: Layout) -> DockerEnvironment:
    mounts: list[ServiceVolumeConfig] = [
        {"type": "bind", "source": str(layout.workspace), "target": "/app"},
        {"type": "bind", "source": str(layout.node_runtime), "target": "/opt/node", "read_only": True},
        {"type": "bind", "source": str(layout.fake_bin), "target": "/opt/fake-bin", "read_only": True},
        {"type": "bind", "source": str(layout.cortex_home), "target": "/cortex-home"},
        {"type": "bind", "source": str(layout.trial_paths.agent_dir), "target": "/logs/agent"},
        {"type": "bind", "source": str(layout.trial_paths.verifier_dir), "target": "/logs/verifier"},
        {"type": "bind", "source": str(layout.trial_paths.artifacts_dir), "target": "/logs/artifacts"},
    ]
    return DockerEnvironment(
        environment_dir=layout.environment_dir, environment_name="cortex-real-agent-run",
        session_id=session_id(), trial_paths=layout.trial_paths,
        task_env_config=EnvironmentConfig(docker_image=IMAGE_REF, workdir="/app"), mounts=mounts,
        extra_docker_compose=[Path(__file__).with_name("docker-compose-never-pull.yaml")],
    )


def agent_environment() -> dict[str, str]:
    return {
        "PATH": "/opt/fake-bin:/usr/local/bin:/opt/node/bin:/usr/bin:/bin",
        "HOME": f"/home/{AGENT_USER}", "CORTEX_HOME": "/cortex-home",
        "CORTEX_PROJECTS_DIR": "/cortex-home/projects",
        "CLAUDE_CONFIG_DIR": f"/home/{AGENT_USER}/.claude",
        "XDG_CONFIG_HOME": "/cortex-home/xdg-config",
        "XDG_CACHE_HOME": "/cortex-home/xdg-cache", "TMPDIR": "/cortex-home/tmp",
    }


def create_agent(layout: Layout, image: dict[str, object]) -> RecordingCortexBenchAgent:
    manifest = {
        "root_run_id": ROOT_RUN_ID, "trial_id": TRIAL_ID,
        "arm": "cortex-direct-real-agent-run", "wheel_path": str(layout.wheel_path),
        "lockfile_path": str(layout.harness_dir / "uv.lock"),
        "lockfile_manifest_path": "benchmark/harness/uv.lock",
        "npm_artifact_path": str(layout.npm_artifact), **image,
    }
    return RecordingCortexBenchAgent(
        logs_dir=layout.trial_paths.agent_dir,
        artifact_dir=layout.trial_paths.artifacts_dir,
        manifest=manifest, extra_env=agent_environment(),
    )


async def provision_runtime(environment: DockerEnvironment) -> None:
    uid = os.getuid()
    command = (
        "ln -s /opt/node/bin/node /usr/local/bin/node"
        " && ln -s /opt/node/bin/npm /usr/local/bin/npm"
        f" && useradd --uid {uid} --create-home --shell /bin/bash {AGENT_USER}"
    )
    result = await environment.exec(command=command, user="root")
    assert result.return_code == 0, result.stderr


def validation_command() -> str:
    script = (
        "const m=await import('file://' + process.argv[1]);"
        "const r=m.validateTrajectoryRoot(process.argv[2]);"
        "console.log(JSON.stringify(r));if(!r.ok)process.exit(1);"
    )
    return (
        'package_root="$(npm ls --global --parseable --depth=0 --prefix '
        '/installed-agent/npm @cortex-agent/server)"'
        f" && node --input-type=module -e {shlex.quote(script)} "
        '"$package_root/dist/domain/agent-run/manifest.js" /logs/agent/trajectory'
        " > /logs/artifacts/trajectory-validation.json"
    )


def trial_record() -> dict[str, object]:
    scope = {
        "stub_agent_trial": False, "real_cortex_agent_run": True,
        "fake_model_backend": "claude-path-substitution", "paid_model_calls": 0,
        "other_faked_layers": [],
    }
    return {
        "scope": scope,
        "layers": {
            "harbor_agent_run": "real", "installed_cortex_cli": "real",
            "process_supervisor": "real", "claude_adapter": "real",
            "model_backend": "fake-network-free",
            "container_network": "detached-before-agent-run",
        },
    }


async def write_container_evidence(environment: DockerEnvironment) -> None:
    record = shlex.quote(json.dumps(trial_record(), sort_keys=True))
    sensitive = "ANTHROPIC|OPENAI|AWS_|SLACK|FEISHU|API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET"
    commands = [
        validation_command(),
        "command -v claude > /logs/artifacts/claude-path.txt",
        "tail -n +2 /proc/net/route > /logs/artifacts/outbound-routes.txt",
        f"env | cut -d= -f1 | grep -E {shlex.quote(sensitive)} "
        "> /logs/artifacts/sensitive-env-names.txt || true",
        "test ! -s /logs/artifacts/sensitive-env-names.txt",
        f"printf '%s\\n' {record} > /logs/artifacts/trial-record.json",
    ]
    for command in commands:
        result = await environment.exec(command=command)
        assert result.return_code == 0, f"{command}\n{result.stderr}"


async def execute_trial(
    layout: Layout, image: dict[str, object],
) -> RecordingCortexBenchAgent:
    environment = create_environment(layout)
    agent = create_agent(layout, image)
    try:
        await environment.start(force_build=False)
        await provision_runtime(environment)
        with environment.with_default_user(AGENT_USER):
            with environment.scoped_exec_env(agent.extra_env):
                assert agent.run.__func__ is CortexBenchAgent.run
                await agent.setup(environment)
                disconnect_container_network()
                routes = await environment.exec(command="tail -n +2 /proc/net/route")
                assert routes.return_code == 0 and not (routes.stdout or "").strip()
                await agent.run("Complete the synthetic real-agent trial.", environment, AgentContext())
                await write_container_evidence(environment)
    finally:
        await environment.stop(delete=True)
    assert agent.run_result is not None
    return agent


def parse_journal(layout: Layout) -> tuple[dict[str, object], list[dict[str, object]]]:
    path = layout.trial_paths.agent_dir / "trajectory" / "events.jsonl"
    records = [json.loads(line) for line in path.read_text().splitlines()]
    header = records[0]
    events = [record["event"] for record in records[1:]]
    assert header["type"] == "run_header" and header["resolved_cwd"] == "/app"
    return header, events


def parse_fake_usage(layout: Layout) -> dict[str, int]:
    artifacts = layout.trial_paths.artifacts_dir
    output = (artifacts / "fake-claude-output.jsonl").read_text().splitlines()
    result = json.loads(output[-1])
    request = json.loads((artifacts / "fake-claude-stdin.json").read_text())
    argv = (artifacts / "fake-claude-argv.txt").read_text().splitlines()
    assert (artifacts / "fake-claude-version.txt").read_text().strip() == "2.1.999 (Cortex benchmark fake)"
    assert (artifacts / "claude-path.txt").read_text().strip() == "/opt/fake-bin/claude"
    assert (artifacts / "fake-claude-cwd.txt").read_text().strip() == "/app"
    assert request["type"] == "user" and request["session_id"] == result["session_id"]
    assert argv[:5] == ["-p", "--input-format", "stream-json", "--output-format", "stream-json"]
    assert "--strict-mcp-config" in argv and argv[argv.index("--model") + 1] == MODEL_NAME
    return result["usage"]


def validate_terminal(layout: Layout, header: dict[str, object]) -> dict[str, object]:
    root = layout.trial_paths.agent_dir / "trajectory"
    started = json.loads((root / f"run-{ROOT_RUN_ID}.started.json").read_text())
    terminal = json.loads((root / f"run-{ROOT_RUN_ID}.terminal.json").read_text())
    journal = root / "events.jsonl"
    assert started["journal_path"] == terminal["journal_path"]
    assert terminal["journal_sha256"] == hashlib.sha256(journal.read_bytes()).hexdigest()
    assert terminal["supervisor"] == {"quiescent": True, "descendants": 0}
    for key in ("model_execution_identity_hash", "role_tool_surface_hash", "bundle_manifest_hash"):
        assert terminal[key] == header[key]
    return terminal


def host_secret_literals() -> dict[str, str]:
    values = {"forbidden_real_credential": FORBIDDEN_CREDENTIAL}
    pattern = re.compile(r"(KEY|TOKEN|SECRET|CREDENTIAL)$")
    candidates = [value for key, value in os.environ.items() if pattern.search(key)]
    for index, value in enumerate(dict.fromkeys(candidates), start=1):
        if len(value) >= 8 and "\n" not in value and "\r" not in value:
            values[f"host_secret_{index}"] = value
    return values


def write_workspace_diff(layout: Layout) -> Path:
    output = layout.trial_paths.artifacts_dir / "workspace.diff"
    with output.open("wb") as stream:
        for path in sorted(layout.workspace.rglob("*")):
            if path.is_symlink():
                payload = os.fsencode(os.readlink(path))
            elif path.is_file():
                payload = path.read_bytes()
            else:
                continue
            relative = os.fsencode(path.relative_to(layout.workspace))
            stream.write(b"--- /dev/null\n+++ b/" + relative + b"\n")
            for line in payload.splitlines(keepends=True):
                stream.write(b"+" + line)
            if payload and not payload.endswith(b"\n"):
                stream.write(b"\n")
    return output


def required_scan(layout: Layout, secrets: dict[str, str]) -> bool:
    agent = layout.trial_paths.agent_dir
    artifacts = layout.trial_paths.artifacts_dir
    artifact_set = ArtifactSet(
        stdout=agent / "stdout.txt", stderr=agent / "stderr.txt",
        events=agent / "trajectory" / "events.jsonl",
        manifest=artifacts / "cortex-bench-harness-manifest.json",
        workspace_diff=artifacts / "workspace.diff",
    )
    policy = ScanPolicy(secrets, str(layout.repo_root), socket.gethostname())
    report = scan_trial_artifacts(artifact_set, policy)
    (artifacts / "required-scan-report.json").write_text(json.dumps(report.as_dict(), sort_keys=True))
    return report.clean


def result_surface_files(layout: Layout) -> list[Path]:
    files: list[Path] = []
    for root in (layout.trial_paths.agent_dir, layout.trial_paths.verifier_dir,
                 layout.trial_paths.artifacts_dir):
        files.extend(path for path in root.rglob("*") if path.is_file())
    return sorted(files)


def whole_tree_scan(layout: Layout, secrets: dict[str, str]) -> bool:
    findings: list[str] = []
    literals = [value.encode() for value in secrets.values()]
    total_bytes = 0
    files = result_surface_files(layout)
    for path in files:
        data = path.read_bytes()
        total_bytes += len(data)
        if any(literal in data for literal in literals):
            findings.append(f"secret:{path.relative_to(layout.root)}")
        if HOME_PATH.search(data) or URI_HOST.search(data) or IPV4.search(data):
            findings.append(f"host:{path.relative_to(layout.root)}")
    report = {"clean": not findings, "files_scanned": len(files),
              "bytes_scanned": total_bytes, "matches": findings}
    output = layout.trial_paths.artifacts_dir / "whole-tree-scan-report.json"
    output.write_text(json.dumps(report, sort_keys=True))
    return not findings


def collect_evidence(
    layout: Layout, image: dict[str, object], agent: RecordingCortexBenchAgent,
) -> TrialEvidence:
    header, events = parse_journal(layout)
    terminal = validate_terminal(layout, header)
    event_types = frozenset(str(event["type"]) for event in events)
    cost = next(event for event in events if event["type"] == "cost_record")
    validation = json.loads(
        (layout.trial_paths.artifacts_dir / "trajectory-validation.json").read_text()
    )
    secrets = host_secret_literals()
    write_workspace_diff(layout)
    required_clean = required_scan(layout, secrets)
    whole_clean = whole_tree_scan(layout, secrets)
    scope = json.loads(
        (layout.trial_paths.artifacts_dir / "trial-record.json").read_text()
    )["scope"]
    routes = (layout.trial_paths.artifacts_dir / "outbound-routes.txt").read_text().splitlines()
    return TrialEvidence(
        int(image["image_size_bytes"]), True, agent.run_result.return_code,
        str(header["resolved_cwd"]), parse_fake_usage(layout), event_types,
        {key: cost[key] for key in ("tokens_in", "tokens_out", "prompt_tokens",
                                    "cached_tokens", "cost_usd")},
        str(terminal["state"]), validation, scope, required_clean, whole_clean, routes,
    )


def run_real_agent_trial(root: Path) -> TrialEvidence:
    image = inspect_image()
    before_images = image_inventory()
    layout = create_layout(root)
    agent = asyncio.run(execute_trial(layout, image))
    after_images = image_inventory()
    assert after_images == before_images, "real trial changed the Docker image inventory"
    return collect_evidence(layout, image, agent)


def main() -> None:
    import tempfile

    with tempfile.TemporaryDirectory(prefix="cortex-real-agent-run-") as temp_dir:
        evidence = run_real_agent_trial(Path(temp_dir))
        print(json.dumps(evidence.__dict__, default=list, sort_keys=True))


if __name__ == "__main__":
    main()
