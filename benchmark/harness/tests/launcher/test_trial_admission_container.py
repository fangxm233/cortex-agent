# input:  production Harbor trial builder, offline fixture image, local fake proxies
# output: exact-container environment, mount, canary, network and digest evidence
# pos:    Black-box production Harbor containment regression
# >>> If I am updated, update my header and folder CORTEX.md <<<

from docker_gate import require_docker_opt_in

require_docker_opt_in()

import asyncio
import base64
import hashlib
import ipaddress
import json
import os
import select
import shutil
import subprocess
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Iterator

import pytest
from harbor.utils.container_cache import docker_build_context_hash

from capability_admission import admit_capability
from cortex_bench_harness.harbor_agent import CortexBenchAgent
from cortex_bench_harness.launcher.credential_capabilities import CredentialCapabilityKey
from cortex_bench_harness.launcher.trial_admission import (
    ADMISSION_EVIDENCE_FILENAME,
    AdmittedDockerEnvironment,
    create_harbor_trial,
)
from cortex_bench_harness.proxy import ProxyBudget, start_trial_proxy
from cortex_bench_harness.proxy.adapters import select_adapter
from cortex_bench_harness.proxy.lease import LeaseTerms

BASE_DIGEST = "sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818"
BASE_IMAGE = f"debian@{BASE_DIGEST}"
ALPINE_DIGEST = "sha256:5b10f432ef3da1b8d4c7eb6c487f2f5a8f096bc91145e68878dd4a5019afde11"
GOST_DIGEST = "sha256:afc0137758ab4ce399d47a299f9abbacbf522b52a17e59cbb4b4e7a1a66e9196"
MODEL = "claude-synthetic-1"
TRIAL_ID = "172"
ROOT_RUN_ID = f"{TRIAL_ID}.cortex-direct"
REAL_FIXTURE_CREDENTIAL = "sk-ant-SYNTHETIC-HARBOR-CONTAINMENT"
CREDENTIAL_ENV = "CORTEX_BENCH_CONTAINMENT_CREDENTIAL"
REPO_ROOT = Path(__file__).resolve().parents[4]
SERVER_ROOT = REPO_ROOT / "agent-server"
FIXTURE_SCRIPT = Path(__file__).with_name("fake_containment_claude.mjs")
EXPECTED_PROBES = {
    "arbitrary-egress", "container-environment", "container-mounts",
    "direct-provider", "host-canary-isolation", "host-daemon-socket",
    "host-daemon-tcp", "instance-metadata", "sibling-canary-isolation",
    "sibling-proxy-route", "trial-fake-proxy",
}


@dataclass(frozen=True)
class OfflineAssets:
    artifact: Path
    build_evidence: dict[str, object]
    image_digest: str
    image_id: str
    image_ref: str
    image_size: int


@dataclass(frozen=True)
class NetworkFacts:
    gateway: str
    name: str
    sibling_ip: str
    trial_ip: str


class FakeProviderServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, host: str) -> None:
        super().__init__((host, 0), FakeProviderHandler)
        self.request_count = 0


class FakeProviderHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        self.rfile.read(length)
        self.server.request_count += 1
        payload = json.dumps({
            "id": "msg_containment", "type": "message", "model": MODEL,
            "usage": {"input_tokens": 2, "output_tokens": 3}, "content": [],
        }).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, _format: str, *_args: object) -> None:
        return


def docker(*args: str, check: bool = True, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["docker", *args], check=check, capture_output=True, text=True, timeout=timeout,
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix().encode()
        digest.update(relative + b"\0")
        if path.is_symlink():
            digest.update(os.readlink(path).encode())
        elif path.is_file():
            digest.update(path.read_bytes())
    return digest.hexdigest()


def build_node_runtime(root: Path) -> Path:
    node = Path(shutil.which("node") or "").resolve()
    npm = Path(shutil.which("npm") or "").resolve()
    assert node.is_file() and npm.is_file(), "local Node/npm distribution is required"
    runtime = root / "node-runtime"
    (runtime / "bin").mkdir(parents=True)
    shutil.copy2(node, runtime / "bin/node")
    shutil.copytree(npm.parents[1], runtime / "lib/node_modules/npm", symlinks=True)
    (runtime / "bin/npm").symlink_to("../lib/node_modules/npm/bin/npm-cli.js")
    return runtime


def copy_package_inputs(stage: Path) -> None:
    files = ("package.json", "package-lock.json", "README.md")
    directories = ("dist", "defaults", "native/cortex-supervisor/dist", "web/dist")
    for relative in files:
        shutil.copy2(SERVER_ROOT / relative, stage / relative)
    package = json.loads((stage / "package.json").read_text())
    package["scripts"].pop("prepare", None)
    package["scripts"].pop("prepack", None)
    package["bundleDependencies"] = True
    (stage / "package.json").write_text(json.dumps(package, indent=2) + "\n")
    for relative in directories:
        shutil.copytree(SERVER_ROOT / relative, stage / relative, symlinks=True)
    script = "scripts/postinstall-restart-trigger.mjs"
    (stage / "scripts").mkdir()
    shutil.copy2(SERVER_ROOT / script, stage / script)


def merge_dependency_tree(source: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for entry in os.scandir(source):
        target = destination / entry.name
        if target.exists() or target.is_symlink():
            if entry.is_dir(follow_symlinks=False) and target.is_dir() and not target.is_symlink():
                merge_dependency_tree(Path(entry.path), target)
            continue
        if entry.is_symlink():
            target.symlink_to(os.readlink(entry.path), target_is_directory=entry.is_dir())
        elif entry.is_dir(follow_symlinks=False):
            shutil.copytree(entry.path, target, copy_function=shutil.copy2, symlinks=True)
        else:
            shutil.copy2(entry.path, target)


def copy_local_dependencies(stage: Path) -> None:
    destination = stage / "node_modules"
    shutil.copytree(
        SERVER_ROOT / "node_modules", destination, copy_function=shutil.copy2, symlinks=True,
    )
    merge_dependency_tree(REPO_ROOT / "node_modules", destination)


def build_npm_artifact(root: Path) -> Path:
    environment = {**os.environ, "npm_config_offline": "true",
                   "npm_config_update_notifier": "false"}
    environment.pop("PYTHONPATH", None)
    for command in (
        ["pnpm", "--filter", "@cortex-agent/web...", "run", "build"],
        ["npm", "run", "build:supervisor"],
        ["node", "scripts/copy-web-dist.js"],
    ):
        cwd = REPO_ROOT if command[0] == "pnpm" else SERVER_ROOT
        subprocess.run(command, cwd=cwd, env=environment, check=True,
                       capture_output=True, text=True)
    stage = root / "package-stage"
    stage.mkdir()
    copy_package_inputs(stage)
    copy_local_dependencies(stage)
    subprocess.run(
        ["npm", "pack", "--offline", "--ignore-scripts",
         "--pack-destination", str(root)],
        cwd=stage, env=environment, check=True, capture_output=True, text=True,
    )
    artifacts = list(root.glob("cortex-agent-server-*.tgz"))
    assert len(artifacts) == 1
    return artifacts[0]


def fixture_dockerfile(context: Path) -> Path:
    path = context / "Dockerfile"
    path.write_text(
        f"FROM {BASE_IMAGE}\n"
        "COPY node-runtime /opt/node\n"
        "COPY fake_containment_claude.mjs /opt/fixtures/fake-containment-claude.mjs\n"
        "RUN ln -s /opt/node/bin/node /usr/local/bin/node \\\n"
        " && ln -s /opt/node/bin/npm /usr/local/bin/npm \\\n"
        " && printf '#!/bin/sh\\nexec /opt/node/bin/node /opt/fixtures/fake-containment-claude.mjs \"$@\"\\n' > /usr/local/bin/claude \\\n"
        " && chmod +x /usr/local/bin/claude && mkdir -p /app\n"
        "WORKDIR /app\n",
    )
    return path


def inspect_image(reference: str) -> dict[str, object]:
    return json.loads(docker("image", "inspect", reference).stdout)[0]


def build_runtime_image(root: Path, runtime: Path) -> tuple[str, dict[str, object]]:
    context = root / "image-context"
    context.mkdir()
    shutil.copytree(runtime, context / "node-runtime", symlinks=True)
    shutil.copy2(FIXTURE_SCRIPT, context / FIXTURE_SCRIPT.name)
    dockerfile = fixture_dockerfile(context)
    tag = f"cortex-harbor-containment:{tree_digest(context)[:16]}"
    docker("build", "--network=none", "--pull=false", "--tag", tag,
           "--file", str(dockerfile), str(context), timeout=600)
    image = inspect_image(tag)
    repo_digests = image.get("RepoDigests") or []
    image_ref = next((value for value in repo_digests
                      if value.startswith("cortex-harbor-containment@")), None)
    assert image_ref is not None, "local fixture image did not receive a content digest"
    return image_ref, image


def ensure_offline_sidecar() -> tuple[str, str]:
    import harbor.environments.docker as docker_package

    context = docker_package.EGRESS_CONTROL_SIDECAR_CONTEXT_PATH
    platform = docker("version", "--format", "{{.Server.Os}}/{{.Server.Arch}}").stdout.strip()
    key = docker_build_context_hash(
        context=context, dockerfile_path=context / "Dockerfile",
        build_args={}, platform=platform,
    )
    name = f"harbor-prebuilt:harbor-docker-egress-control-sidecar--{key}"
    if docker("image", "inspect", name, check=False).returncode != 0:
        docker("build", "--network=none", "--pull=false", "--platform", platform,
               "--tag", name, "--file", str(context / "Dockerfile"), str(context), timeout=600)
    return name, str(inspect_image(name)["Id"])


@pytest.fixture(scope="module")
def offline_assets(tmp_path_factory: pytest.TempPathFactory) -> OfflineAssets:
    root = tmp_path_factory.mktemp("harbor-containment-assets")
    runtime = build_node_runtime(root)
    artifact = build_npm_artifact(root)
    image_ref, image = build_runtime_image(root, runtime)
    sidecar_name, sidecar_id = ensure_offline_sidecar()
    image_id = str(image["Id"])
    image_digest = image_ref.rsplit("@", 1)[1]
    evidence = {
        "schema_version": "cortex-harbor-fixture-build/1",
        "base": {"reference": BASE_IMAGE, "digest": BASE_DIGEST},
        "runtime": {"sha256": tree_digest(runtime)},
        "fixture": {"sha256": sha256_file(FIXTURE_SCRIPT)},
        "cortex_package": {"sha256": sha256_file(artifact)},
        "image": {"reference": image_ref, "digest": image_digest,
                  "config_digest": image_id},
        "sidecar": {"reference": sidecar_name, "digest": sidecar_id},
        "provisioned": {"alpine": ALPINE_DIGEST, "gost": GOST_DIGEST},
        "build": {"network": "none", "pull": "disabled"},
    }
    return OfflineAssets(
        artifact, evidence, image_digest, image_id,
        image_ref, int(image["Size"]),
    )


def create_trial_network() -> NetworkFacts:
    project = f"{TRIAL_ID}__env"
    name = f"{project}_default"
    for suffix in range(200, 240):
        subnet = f"172.30.{suffix}.0/24"
        result = docker(
            "network", "create", "--driver", "bridge", "--subnet", subnet,
            "--label", f"com.docker.compose.project={project}",
            "--label", "com.docker.compose.network=default", name, check=False,
        )
        if result.returncode == 0:
            gateway = f"172.30.{suffix}.1"
            return NetworkFacts(gateway, name, f"172.30.{suffix}.3", f"172.30.{suffix}.2")
    raise AssertionError("no isolated Docker subnet was available")


@contextmanager
def provider_server() -> Iterator[tuple[FakeProviderServer, str]]:
    name = f"cortex-containment-provider-{uuid.uuid4().hex[:10]}"
    docker("network", "create", "--driver", "bridge", name)
    gateway = json.loads(docker("network", "inspect", name).stdout)[0]["IPAM"]["Config"][0]["Gateway"]
    server = FakeProviderServer(gateway)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server, f"http://{gateway}:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        docker("network", "rm", name, check=False)


def arm() -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-arm/2", "kind": "cortex",
        "name": "cortex-direct", "backend": "claude", "provider": "anthropic",
        "model": MODEL, "credential_capability": "claude-api-key",
        "orchestration": {"mode": "direct", "ask_manager": False},
        "limits": {
            "max_thread_starts": 0, "max_parent_questions": 0, "max_task_depth": 0,
            "max_tasks": 0, "max_provider_requests": 8,
            "max_resident_agent_processes": 1, "max_cost_usd": "2.50",
            "deadline_seconds": 180,
        },
    }


def write_task(root: Path, assets: OfflineAssets) -> Path:
    task = root / "task"
    (task / "environment").mkdir(parents=True)
    (task / "tests").mkdir()
    (task / "instruction.md").write_text("Run the synthetic containment probe.\n")
    (task / "tests/test.sh").write_text(
        "#!/bin/sh\nprintf '1\\n' > /logs/verifier/reward.txt\n",
    )
    (task / "task.toml").write_text(
        "[environment]\n"
        f"docker_image = {json.dumps(assets.image_ref)}\n"
        "workdir = \"/app\"\nnetwork_mode = \"allowlist\"\nallowed_hosts = []\n\n"
        "[agent]\ntimeout_sec = 180\n",
    )
    return task


def trial_inputs(root: Path, assets: OfflineAssets, upstream: str, network: NetworkFacts) -> dict[str, object]:
    wheel = root / "harness.whl"
    wheel.write_bytes(b"synthetic harness fixture")
    seed = {
        "arm": arm(), "arm_path": "arm://cortex-direct", "trial_id": TRIAL_ID,
        "root_run_id": ROOT_RUN_ID,
        "task": {"task_id": "synthetic-containment", "image_ref": assets.image_ref,
                 "image_digest": assets.image_digest},
        "profile_name": "benchmark", "paid_run": False,
        "credential": {"upstream_base_url": upstream,
                       "route_identity_host": "api.anthropic.com",
                       "proxy_base_url": f"http://{network.gateway}",
                       "dummy_token_ref": "offline-token-handle"},
        "model_alias_policy": {"kind": "exact"},
    }
    manifest = {
        "root_run_id": ROOT_RUN_ID, "trial_id": TRIAL_ID, "arm": "cortex-direct",
        "wheel_path": str(wheel), "lockfile_path": str(REPO_ROOT / "benchmark/harness/uv.lock"),
        "lockfile_manifest_path": "benchmark/harness/uv.lock",
        "npm_artifact_path": str(assets.artifact), "image_ref": assets.image_ref,
        "image_digest": assets.image_digest, "image_size_bytes": assets.image_size,
    }
    proxy = {
        "credential_env": CREDENTIAL_ENV, "bound_source_ip": network.trial_ip,
        "max_request_cost_usd": "1.00", "input_cost_per_million_usd": "3",
        "output_cost_per_million_usd": "15", "listen_host": "0.0.0.0",
    }
    return {"arm": arm(), "task_path": write_task(root, assets),
            "trials_dir": root / "trials", "manifest": manifest,
            "trial_seed": seed, "cli_version": "2026.8.10", "trial_proxy": proxy}


def sibling_proxy(upstream: str, network: NetworkFacts, root: Path):
    key = CredentialCapabilityKey(
        "claude", "anthropic", "anthropic-messages", "api-key-bearer",
    )
    return start_trial_proxy(
        trial_id="sibling", upstream_base_url=upstream,
        adapter=select_adapter(key, upstream_base_url=upstream,
                               credential=REAL_FIXTURE_CREDENTIAL, frozen_model=MODEL),
        bound_source_ip=network.sibling_ip,
        absolute_deadline=datetime.now(UTC) + timedelta(minutes=5),
        budget=ProxyBudget(Decimal("2.50"), Decimal("1"), Decimal("3"), Decimal("15")),
        log_path=root / "sibling-proxy.jsonl",
        lease_terms=LeaseTerms(budget_ms=300_000, teardown_grace_ms=6_000),
        listen_host="0.0.0.0", advertised_host=network.gateway,
    )


def start_sibling(assets: OfflineAssets, network: NetworkFacts, proxy) -> tuple[str, subprocess.Popen[str]]:
    name = f"cortex-containment-sibling-{os.getpid()}"
    script = (
        "const fs=require('fs'),http=require('http');"
        "fs.writeFileSync(process.env.CANARY,'sibling-canary');"
        "const body=JSON.stringify({model:process.env.MODEL,prompt:'sibling'});"
        "const r=http.request(process.env.PROXY+'/v1/messages?beta=true',{method:'POST',headers:"
        "{authorization:'Bearer '+process.env.TOKEN,'content-type':'application/json',"
        "'content-length':Buffer.byteLength(body)}},x=>{console.log('READY '+x.statusCode);x.resume();});"
        "r.end(body);setInterval(()=>{},1000);"
    )
    command = [
        "docker", "run", "--rm", "--pull=never", "--network", network.name,
        "--ip", network.sibling_ip, "--name", name,
        "--env", "CANARY=/tmp/sibling-canary", "--env", f"MODEL={MODEL}",
        "--env", f"PROXY={proxy.base_url}", "--env", f"TOKEN={proxy.dummy_token}",
        assets.image_ref, "node", "-e", script,
    ]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    readable, _, _ = select.select([process.stdout], [], [], 10)
    assert readable and process.stdout.readline().strip() == "READY 200"
    return name, process


def probe_instruction(upstream: str, sibling_url: str, network: NetworkFacts, host_canary: Path) -> str:
    provider = upstream.removeprefix("http://").split(":")
    payload = {
        "model": MODEL, "host_canary_path": str(host_canary),
        "sibling_canary_path": "/tmp/sibling-canary", "sibling_proxy_url": sibling_url,
        "denied_tcp": {
            "direct-provider": {"host": provider[0], "port": int(provider[1])},
            "host-daemon-tcp": {"host": provider[0], "port": int(provider[1])},
            "arbitrary-egress": {"host": provider[0], "port": int(provider[1])},
            "instance-metadata": {"host": "169.254.169.254", "port": 80},
        },
    }
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
    return f"Run the exact production containment trial.\nPROBE_INPUT_B64={encoded}\n"


async def wait_for_probe(path: Path, run_task: asyncio.Task) -> None:
    deadline = asyncio.get_running_loop().time() + 120
    while asyncio.get_running_loop().time() < deadline:
        if path.is_file():
            return
        if run_task.done():
            result = run_task.result()
            raise AssertionError(f"trial ended before probe evidence: {result.exception_info}")
        await asyncio.sleep(0.1)
    raise AssertionError("timed out waiting for containment probe evidence")


async def inspect_running_trial(trial, publish_dir: Path) -> dict[str, object]:
    project = f"{TRIAL_ID}__env"
    container_id = docker(
        "ps", "--filter", f"label=com.docker.compose.project={project}",
        "--filter", "label=com.docker.compose.service=main", "--format", "{{.ID}}",
    ).stdout.strip()
    assert container_id
    inspected = json.loads(docker("container", "inspect", container_id).stdout)[0]
    compose = await trial.agent_environment._run_docker_compose_command(
        ["config", "--format", "json"],
    )
    (publish_dir / "host-inspection-complete").write_text("ok\n")
    services = json.loads(compose.stdout or "{}")["services"]
    return {
        "container_image": inspected["Image"], "mounts": inspected["Mounts"],
        "pull_policy": {name: services[name].get("pull_policy")
                        for name in ("main", "harbor-docker-egress-control-sidecar")},
    }


async def run_and_inspect(trial, publish: Path):
    running = asyncio.create_task(trial.run())
    probe_path = publish / "containment-probes.json"
    await wait_for_probe(probe_path, running)
    inspection = await inspect_running_trial(trial, publish)
    return await running, inspection, probe_path


def canary_digest(container: str, path: str) -> str:
    result = docker("exec", container, "sha256sum", path)
    return result.stdout.split()[0]


def write_machine_evidence(trial, assets: OfflineAssets, inspection: dict[str, object],
                           host_unchanged: bool, sibling_unchanged: bool) -> None:
    artifact_root = trial.paths.artifacts_dir
    (artifact_root / "fixture-build-evidence.json").write_text(
        json.dumps(assets.build_evidence, indent=2, sort_keys=True) + "\n",
    )
    document = {
        "schema_version": "cortex-harbor-host-containment/1",
        "trial_id": TRIAL_ID, "root_run_id": ROOT_RUN_ID,
        "container_image": inspection["container_image"],
        "mounts": [{"source": mount["Source"], "target": mount["Destination"],
                    "read_write": mount["RW"], "type": mount["Type"]}
                   for mount in inspection["mounts"]],
        "pull_policy": inspection["pull_policy"],
        "probe_outcomes": {
            "host-canary-read-write": "passed" if host_unchanged else "failed",
            "sibling-canary-read-write": "passed" if sibling_unchanged else "failed",
        },
    }
    (artifact_root / "host-containment-probes.json").write_text(
        json.dumps(document, indent=2, sort_keys=True) + "\n",
    )


def assert_launch_evidence(trial, assets: OfflineAssets) -> None:
    document = json.loads(
        (trial.paths.artifacts_dir / ADMISSION_EVIDENCE_FILENAME).read_text(),
    )
    assert set(document) == {
        "schema_version", "trial_id", "root_run_id", "image",
        "environment", "mounts", "network",
    }
    assert document["trial_id"] == TRIAL_ID and document["root_run_id"] == ROOT_RUN_ID
    assert document["image"] == {"reference": assets.image_ref, "pinned": True}
    assert document["environment"]["inheritance"] == "none"
    assert document["network"]["default"] == "deny"


def assert_probe_evidence(path: Path) -> None:
    document = json.loads(path.read_text())
    assert set(document) == {"schema_version", "trial_id", "root_run_id", "probe_outcomes"}
    assert document["schema_version"] == "cortex-harbor-containment-probes/1"
    assert (document["trial_id"], document["root_run_id"]) == (TRIAL_ID, ROOT_RUN_ID)
    outcomes = {entry["name"]: entry for entry in document["probe_outcomes"]}
    assert set(outcomes) == EXPECTED_PROBES
    assert all(set(entry) == {"name", "status", "boundary", "observation"}
               for entry in outcomes.values())
    assert all(entry["status"] == "passed" for entry in outcomes.values())
    environment = outcomes["container-environment"]["observation"]
    assert environment["pid_one"]["forbidden_keys"] == []
    assert environment["agent"]["forbidden_keys"] == []
    assert environment["pid_one"]["host_root_value_keys"] == []
    assert environment["agent"]["host_root_value_keys"] == []
    assert environment["agent"]["provider_secrets_are_dummy"] is True
    mounts = outcomes["container-mounts"]["observation"]
    assert mounts["declared_targets"] == ["/logs/agent", "/logs/artifacts", "/logs/verifier"]
    assert mounts["forbidden_targets"] == []


def assert_host_evidence(trial, assets: OfflineAssets) -> None:
    document = json.loads((trial.paths.artifacts_dir / "host-containment-probes.json").read_text())
    assert set(document) == {
        "schema_version", "trial_id", "root_run_id", "container_image",
        "mounts", "pull_policy", "probe_outcomes",
    }
    assert document["container_image"] == assets.image_id
    launch = json.loads((trial.paths.artifacts_dir / ADMISSION_EVIDENCE_FILENAME).read_text())
    expected = {entry["target"]: entry for entry in launch["mounts"]}
    actual = {entry["target"]: entry for entry in document["mounts"]}
    assert set(actual) == {"/logs/agent", "/logs/artifacts", "/logs/verifier"}
    assert all(actual[target]["source"] == expected[target]["source"] for target in actual)
    assert all(actual[target]["read_write"] is True for target in actual)
    assert document["pull_policy"] == {
        "main": "never", "harbor-docker-egress-control-sidecar": "never",
    }
    assert set(document["probe_outcomes"]) == {
        "host-canary-read-write", "sibling-canary-read-write",
    }
    assert set(document["probe_outcomes"].values()) == {"passed"}


def assert_no_host_or_secret_leak(trial) -> None:
    forbidden = [REAL_FIXTURE_CREDENTIAL, str(Path.home()), str(REPO_ROOT)]
    roots = (trial.paths.agent_dir, trial.paths.artifacts_dir, trial.paths.verifier_dir)
    for root in roots:
        for path in root.rglob("*"):
            if path.is_file() and not path.is_symlink():
                data = path.read_bytes()
                assert all(value.encode() not in data for value in forbidden)


def cleanup_runtime(network: NetworkFacts, sibling_name: str | None,
                    sibling_process: subprocess.Popen[str] | None, proxy) -> None:
    if sibling_name:
        docker("stop", "--time", "1", sibling_name, check=False)
    if sibling_process:
        sibling_process.wait(timeout=10)
    if proxy:
        proxy.stop()
    docker("network", "rm", network.name, check=False)


def verify_completed_trial(trial, assets: OfflineAssets, result, inspection,
                           probe_path: Path, upstream: FakeProviderServer,
                           host_unchanged: bool, sibling_unchanged: bool) -> None:
    write_machine_evidence(
        trial, assets, inspection, host_unchanged, sibling_unchanged,
    )
    assert result.exception_info is None
    assert upstream.request_count == 2
    assert_launch_evidence(trial, assets)
    assert_probe_evidence(probe_path)
    assert_host_evidence(trial, assets)
    assert_no_host_or_secret_leak(trial)


def test_exact_production_harbor_trial_enforces_the_real_boundary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, offline_assets: OfflineAssets,
) -> None:
    admit_capability(monkeypatch, "claude-api-key")
    monkeypatch.setenv(CREDENTIAL_ENV, REAL_FIXTURE_CREDENTIAL)
    network = create_trial_network()
    sibling_name = sibling_process = sibling = None
    try:
        with provider_server() as (upstream_server, upstream):
            sibling = sibling_proxy(upstream, network, tmp_path)
            sibling_name, sibling_process = start_sibling(offline_assets, network, sibling)
            sibling_before = canary_digest(sibling_name, "/tmp/sibling-canary")
            inputs = trial_inputs(tmp_path, offline_assets, upstream, network)
            host_canary = tmp_path / "host-canary"
            host_canary.write_text("host-canary")
            instruction = probe_instruction(upstream, sibling.base_url, network, host_canary)
            (Path(inputs["task_path"]) / "instruction.md").write_text(instruction)
            trial = asyncio.run(create_harbor_trial(**inputs))
            assert type(trial.agent) is CortexBenchAgent
            assert type(trial.agent_environment) is AdmittedDockerEnvironment
            publish = trial.paths.host_artifact_path("main", "/logs/artifacts")
            result, inspection, probe_path = asyncio.run(run_and_inspect(trial, publish))
            sibling_after = canary_digest(sibling_name, "/tmp/sibling-canary")
            verify_completed_trial(
                trial, offline_assets, result, inspection, probe_path, upstream_server,
                host_canary.read_text() == "host-canary", sibling_before == sibling_after,
            )
    finally:
        cleanup_runtime(network, sibling_name, sibling_process, sibling)
