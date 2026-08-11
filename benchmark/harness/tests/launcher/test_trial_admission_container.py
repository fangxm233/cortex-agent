# input:  production trial builder, offline image, fake endpoints
# output: concurrent trial isolation and complete boundary evidence
# pos:    Black-box concurrent Harbor containment regression
# >>> If I am updated, update my header and folder CORTEX.md <<<

from docker_gate import require_docker_opt_in

require_docker_opt_in()

import asyncio
import base64
import hashlib
import json
import os
import shutil
import subprocess
import threading
import uuid
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Iterator
from urllib.parse import urlsplit

import pytest
from harbor.utils.container_cache import docker_build_context_hash

from capability_admission import admit_capability
from offline_package import build_offline_npm_artifact
from cortex_bench_harness.harbor_agent import CortexBenchAgent
from cortex_bench_harness.host_finalization import OUTER_ENVELOPE_FILENAME
from cortex_bench_harness.launcher.trial_admission import (
    ADMISSION_EVIDENCE_FILENAME,
    AdmittedDockerEnvironment,
    create_harbor_trial,
)

BASE_DIGEST = "sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818"
BASE_IMAGE = f"debian@{BASE_DIGEST}"
ALPINE_DIGEST = "sha256:5b10f432ef3da1b8d4c7eb6c487f2f5a8f096bc91145e68878dd4a5019afde11"
GOST_DIGEST = "sha256:afc0137758ab4ce399d47a299f9abbacbf522b52a17e59cbb4b4e7a1a66e9196"
TRIAL_IDS = ("10", "172")
REAL_FIXTURE_CREDENTIAL = "sk-ant-SYNTHETIC-HARBOR-CONTAINMENT"
CREDENTIAL_ENV = "CORTEX_BENCH_CONTAINMENT_CREDENTIAL"
REPO_ROOT = Path(__file__).resolve().parents[4]
FIXTURE_SCRIPT = Path(__file__).with_name("fake_containment_claude.mjs")
EXPECTED_PROBES = {
    "arbitrary-egress", "container-environment", "container-mounts",
    "direct-provider", "host-canary-isolation", "host-daemon-socket",
    "host-daemon-tcp", "instance-metadata", "own-process-tree",
    "own-state-root", "own-workspace", "proxy-host-other-port",
    "sibling-canary-isolation", "sibling-capability-replay",
    "sibling-control-callback", "sibling-identifier-replay",
    "sibling-process-signal", "sibling-proxy-route",
    "sibling-state-enumeration", "sibling-workspace-isolation",
    "trial-fake-proxy",
}
REQUIRED_EVIDENCE_ROWS = {
    "environment", "mount", "filesystem", "network", "state",
    "process", "credential", "artifact",
}
NETWORK_DENIAL_REASONS = {
    "closed", "timeout", "EACCES", "ECONNREFUSED", "ECONNRESET",
    "EHOSTUNREACH", "ENETUNREACH", "EPERM", "ETIMEDOUT",
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
    trial_ip: str


class FakeProviderServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, host: str) -> None:
        super().__init__((host, 0), FakeProviderHandler)
        self.request_count = 0


class FakeProviderHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        request = json.loads(self.rfile.read(length))
        self.server.request_count += 1
        payload = json.dumps({
            "id": "msg_containment", "type": "message", "model": request["model"],
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
    artifact = build_offline_npm_artifact(REPO_ROOT, root)
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


def create_trial_network(trial_id: str) -> NetworkFacts:
    project = f"{trial_id}__env"
    name = f"{project}_default"
    for suffix in range(200, 240):
        subnet = f"{trial_id}.30.{suffix}.0/24"
        result = docker(
            "network", "create", "--driver", "bridge", "--subnet", subnet,
            "--label", f"com.docker.compose.project={project}",
            "--label", "com.docker.compose.network=default", name, check=False,
        )
        if result.returncode == 0:
            gateway = f"{trial_id}.30.{suffix}.1"
            return NetworkFacts(gateway, name, f"{trial_id}.30.{suffix}.2")
    raise AssertionError("no isolated Docker subnet was available")


@contextmanager
def running_server(host: str) -> Iterator[tuple[FakeProviderServer, str]]:
    server = FakeProviderServer(host)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server, f"http://{host}:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@contextmanager
def provider_server() -> Iterator[tuple[FakeProviderServer, str]]:
    name = f"cortex-containment-provider-{uuid.uuid4().hex[:10]}"
    docker("network", "create", "--driver", "bridge", name)
    gateway = json.loads(docker("network", "inspect", name).stdout)[0]["IPAM"]["Config"][0]["Gateway"]
    try:
        with running_server(gateway) as server:
            yield server
    finally:
        docker("network", "rm", name, check=False)


def model_for(trial_id: str) -> str:
    return f"claude-synthetic-{trial_id}"


def root_run_id(trial_id: str) -> str:
    return f"{trial_id}.cortex-direct"


def arm(model: str) -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-arm/2", "kind": "cortex",
        "name": "cortex-direct", "backend": "claude", "provider": "anthropic",
        "model": model, "credential_capability": "claude-api-key",
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


def trial_seed(
    assets: OfflineAssets, upstream: str, network: NetworkFacts, trial_id: str,
) -> dict[str, object]:
    model = model_for(trial_id)
    return {
        "arm": arm(model), "arm_path": "arm://cortex-direct", "trial_id": trial_id,
        "root_run_id": root_run_id(trial_id),
        "task": {"task_id": "synthetic-containment", "image_ref": assets.image_ref,
                 "image_digest": assets.image_digest},
        "profile_name": "benchmark", "paid_run": False,
        "credential": {"upstream_base_url": upstream,
                       "route_identity_host": "api.anthropic.com",
                       "proxy_base_url": f"http://{network.gateway}",
                       "dummy_token_ref": "offline-token-handle"},
        "model_alias_policy": {"kind": "exact"},
    }


def manifest_seed(
    root: Path, assets: OfflineAssets, trial_id: str,
) -> dict[str, object]:
    wheel = root / "harness.whl"
    wheel.write_bytes(b"synthetic harness fixture")
    return {
        "root_run_id": root_run_id(trial_id), "trial_id": trial_id, "arm": "cortex-direct",
        "wheel_path": str(wheel), "lockfile_path": str(REPO_ROOT / "benchmark/harness/uv.lock"),
        "lockfile_manifest_path": "benchmark/harness/uv.lock",
        "npm_artifact_path": str(assets.artifact), "image_ref": assets.image_ref,
        "image_digest": assets.image_digest, "image_size_bytes": assets.image_size,
    }


def trial_inputs(
    root: Path, assets: OfflineAssets, upstream: str,
    network: NetworkFacts, trial_id: str,
) -> dict[str, object]:
    proxy = {
        "credential_env": CREDENTIAL_ENV, "bound_source_ip": network.trial_ip,
        "max_request_cost_usd": "1.00", "input_cost_per_million_usd": "3",
        "output_cost_per_million_usd": "15", "listen_host": "0.0.0.0",
    }
    scan_policy = {
        "secret_environment": {"provider_credential": CREDENTIAL_ENV},
        "forbidden_environment": {}, "forbidden_argv_environment": {},
        "repository_checkout_environment": "PWD",
        "host_identity_environment": {"user": "USER"},
    }
    return {"arm": arm(model_for(trial_id)), "task_path": write_task(root, assets),
            "trials_dir": root / "trials", "manifest": manifest_seed(root, assets, trial_id),
            "trial_seed": trial_seed(assets, upstream, network, trial_id),
            "cli_version": "2026.8.10", "host_scan_policy": scan_policy,
            "trial_proxy": proxy}


def tcp_target(url: str) -> dict[str, object]:
    parsed = urlsplit(url)
    assert parsed.hostname is not None and parsed.port is not None
    return {"host": parsed.hostname, "port": parsed.port}


def probe_instruction(
    model: str, upstream: str, host_canary: Path,
    daemon_url: str, arbitrary_url: str, other_proxy_port_url: str,
) -> str:
    denied_tcp = {
        "direct-provider": tcp_target(upstream),
        "host-daemon-tcp": tcp_target(daemon_url),
        "arbitrary-egress": tcp_target(arbitrary_url),
        "proxy-host-other-port": tcp_target(other_proxy_port_url),
        "instance-metadata": {"host": "169.254.169.254", "port": 80},
    }
    assert len({(item["host"], item["port"]) for item in denied_tcp.values()}) == 5
    payload = {"model": model, "host_canary_path": str(host_canary),
               "denied_tcp": denied_tcp}
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
    return f"Run the exact production containment trial.\nPROBE_INPUT_B64={encoded}\n"


def write_probe_instruction(
    inputs: dict[str, object], root: Path, model: str, upstream: str,
    daemon_url: str, arbitrary_url: str, other_proxy_port_url: str,
) -> Path:
    host_canary = root / "host-canary"
    host_canary.write_text("host-canary")
    instruction = probe_instruction(
        model, upstream, host_canary, daemon_url, arbitrary_url, other_proxy_port_url,
    )
    (Path(inputs["task_path"]) / "instruction.md").write_text(instruction)
    return host_canary


async def wait_for_file(path: Path, run_task: asyncio.Task, label: str) -> None:
    deadline = asyncio.get_running_loop().time() + 120
    while asyncio.get_running_loop().time() < deadline:
        if path.is_file():
            return
        if run_task.done():
            result = run_task.result()
            raise AssertionError(f"trial ended before {label}: {result.exception_info}")
        await asyncio.sleep(0.1)
    raise AssertionError(f"timed out waiting for {label}")


async def inspect_running_trial(trial, trial_id: str) -> dict[str, object]:
    project = f"{trial_id}__env"
    container_id = docker(
        "ps", "--filter", f"label=com.docker.compose.project={project}",
        "--filter", "label=com.docker.compose.service=main", "--format", "{{.ID}}",
    ).stdout.strip()
    assert container_id
    inspected = json.loads(docker("container", "inspect", container_id).stdout)[0]
    compose = await trial.agent_environment._run_docker_compose_command(
        ["config", "--format", "json"],
    )
    services = json.loads(compose.stdout or "{}")["services"]
    return {
        "container_id": container_id, "process_id": inspected["State"]["Pid"],
        "container_image": inspected["Image"], "mounts": inspected["Mounts"],
        "pull_policy": {name: services[name].get("pull_policy")
                        for name in ("main", "harbor-docker-egress-control-sidecar")},
    }


def coordination_dir(trial) -> Path:
    return trial.paths.host_artifact_path("main", "/logs/artifacts")


def probe_evidence_path(trial) -> Path:
    return trial.paths.agent_dir / "trial-home/logs/containment-probes.json"


def container_digest(container: str, path: str) -> str:
    return docker("exec", container, "sha256sum", path).stdout.split()[0]


def container_text(container: str, path: str) -> str:
    return docker("exec", container, "cat", path).stdout.strip()


def write_cross_inputs(trials, fixtures, inspections) -> None:
    for index, trial in enumerate(trials):
        peer = 1 - index
        session = trials[peer].agent.proxy_session
        assert session is not None
        sibling_state = trials[peer].paths.agent_dir / "trial-home/cortex-home/state"
        document = {
            "sibling": {
                "trial_id": fixtures[peer]["trial_id"],
                "root_run_id": root_run_id(fixtures[peer]["trial_id"]),
                "model": model_for(fixtures[peer]["trial_id"]),
                "state_directory": str(sibling_state),
                "state_file": str(sibling_state / "tasks.json"),
                "workspace_file": (
                    f"/proc/{inspections[peer]['process_id']}/root/app/trial-canary"
                ),
                "process_pid": inspections[peer]["process_id"],
                "proxy_url": session.handle.base_url,
                "dummy_token": session.handle.dummy_token,
            },
        }
        path = coordination_dir(trial) / "cross-trial-input.json"
        path.write_text(json.dumps(document))


async def cancel_running_trials(running: list[asyncio.Task]) -> None:
    for task in running:
        if not task.done():
            task.cancel()
    await asyncio.gather(*running, return_exceptions=True)


async def exercise_concurrent_trials(fixtures):
    trials = await asyncio.gather(*(
        create_harbor_trial(**fixture["inputs"]) for fixture in fixtures
    ))
    assert all(type(trial.agent) is CortexBenchAgent for trial in trials)
    assert all(type(trial.agent_environment) is AdmittedDockerEnvironment for trial in trials)
    running = [asyncio.create_task(trial.run()) for trial in trials]
    try:
        ready = [coordination_dir(trial) / "containment-ready.json" for trial in trials]
        await asyncio.gather(*(wait_for_file(path, task, "probe readiness")
                               for path, task in zip(ready, running)))
        inspections = await asyncio.gather(*(
            inspect_running_trial(trial, fixture["trial_id"])
            for trial, fixture in zip(trials, fixtures)
        ))
        state_path = "/logs/agent/trial-home/cortex-home/state/tasks.json"
        before = [container_digest(item["container_id"], state_path) for item in inspections]
        write_cross_inputs(trials, fixtures, inspections)
        evidence = [probe_evidence_path(trial) for trial in trials]
        await asyncio.gather(*(wait_for_file(path, task, "probe evidence")
                               for path, task in zip(evidence, running)))
        after = [container_digest(item["container_id"], state_path) for item in inspections]
        workspace = [container_text(item["container_id"], "/app/trial-canary")
                     for item in inspections]
        for trial in trials:
            (coordination_dir(trial) / "host-inspection-complete").write_text("ok\n")
        results = await asyncio.gather(*running)
        return trials, results, inspections, evidence, before, after, workspace
    finally:
        await cancel_running_trials(running)


def read_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text())


def assert_launch_evidence(trial, assets: OfflineAssets, trial_id: str) -> dict[str, object]:
    document = read_json(trial.paths.artifacts_dir / ADMISSION_EVIDENCE_FILENAME)
    assert set(document) == {
        "schema_version", "trial_id", "root_run_id", "image",
        "environment", "mounts", "network",
    }
    assert (document["trial_id"], document["root_run_id"]) == (
        trial_id, root_run_id(trial_id),
    )
    assert document["image"] == {"reference": assets.image_ref, "pinned": True}
    return document


def assert_probe_evidence(path: Path, trial_id: str) -> dict[str, dict[str, object]]:
    document = read_json(path)
    assert set(document) == {"schema_version", "trial_id", "root_run_id", "probe_outcomes"}
    assert document["schema_version"] == "cortex-harbor-containment-probes/1"
    assert (document["trial_id"], document["root_run_id"]) == (
        trial_id, root_run_id(trial_id),
    )
    outcomes = {entry["name"]: entry for entry in document["probe_outcomes"]}
    assert set(outcomes) == EXPECTED_PROBES
    assert all(set(entry) == {"name", "status", "boundary", "observation"}
               for entry in outcomes.values())
    assert all(entry["status"] == "passed" for entry in outcomes.values())
    denied = {name for name, entry in outcomes.items() if entry["boundary"] == "network"}
    assert all(outcomes[name]["observation"]["reason"] in NETWORK_DENIAL_REASONS
               for name in denied)
    environment = outcomes["container-environment"]["observation"]
    assert environment["pid_one"]["forbidden_keys"] == []
    assert environment["agent"]["forbidden_keys"] == []
    assert environment["pid_one"]["host_root_value_keys"] == []
    assert environment["agent"]["host_root_value_keys"] == []
    assert environment["agent"]["provider_secrets_are_dummy"] is True
    mounts = outcomes["container-mounts"]["observation"]
    assert mounts["declared_targets"] == ["/logs/agent", "/logs/artifacts", "/logs/verifier"]
    assert mounts["forbidden_targets"] == []
    return outcomes


def journal_state_admission(trial) -> dict[str, object]:
    path = trial.paths.agent_dir / "trajectory/events.jsonl"
    records = [json.loads(line) for line in path.read_text().splitlines()]
    admitted = [record["evidence"] for record in records if record["type"] == "state_admission"]
    assert len(admitted) == 1
    return admitted[0]


def classified_sources(outer: dict[str, object]) -> dict[str, str]:
    return {entry["source"]: entry["classification"]
            for entry in outer["classification"]["files"]}


def runtime_evidence_rows(
    launch, probes, state, terminal, fixture, before: str, after: str, workspace: str,
) -> dict[str, bool]:
    trial_id = fixture["trial_id"]
    expected_roots = {"project", "task", "thread", "session",
                      "execution", "cache", "temp", "backend"}
    return {
        "environment": launch["environment"]["inheritance"] == "none",
        "filesystem": fixture["host_canary"].read_text() == "host-canary"
        and probes["sibling-canary-isolation"]["status"] == "passed"
        and probes["sibling-workspace-isolation"]["status"] == "passed"
        and before == after and workspace == trial_id,
        "network": launch["network"]["default"] == "deny"
        and launch["network"]["proxy_route"]["trial_id"] == trial_id
        and probes["sibling-proxy-route"]["status"] == "passed"
        and probes["sibling-control-callback"]["status"] == "passed",
        "state": state["schema_version"] == "cortex-standalone-state-admission/1"
        and state["empty_before_projection"] is True
        and set(state["roots"]) == expected_roots,
        "process": terminal["supervisor"] == {"quiescent": True, "descendants": 0}
        and probes["sibling-process-signal"]["status"] == "passed",
    }


def host_evidence_rows(launch, outer, resolution, inspection) -> dict[str, bool]:
    live_mounts = {item["Destination"]: item for item in inspection["mounts"]}
    launch_mounts = {item["target"]: item for item in launch["mounts"]}
    selected = next(item for item in resolution["credential_capabilities"]
                    if item["id"] == "claude-api-key")
    sources = classified_sources(outer)
    return {
        "mount": set(live_mounts) == set(launch_mounts)
        and all(hashlib.sha256(live_mounts[key]["Source"].encode()).hexdigest()
                == launch_mounts[key]["source_sha256"] for key in live_mounts)
        and inspection["pull_policy"] == {"main": "never",
                                          "harbor-docker-egress-control-sidecar": "never"},
        "credential": selected["state"] == "offline-contract-passed"
        and outer["proxy_usage"]["reconciled"] is True
        and outer["revocation"]["route_active"] is False,
        "artifact": outer["classification"]["ok"] is True
        and outer["leak_scan"]["ok"] is True
        and outer["leak_scan"]["missing_sources"] == []
        and outer["leak_scan"]["unclassified_files"] == []
        and sources["trial_state:trial-home/logs/containment-probes.json"]
            == "optional-classified"
        and outer["publication"]["post_publication_reread"] is True
        and outer["grader_admission"] == {"admitted": True},
    }


def production_evidence_rows(
    trial, assets: OfflineAssets, fixture, inspection, probe_path: Path,
    before: str, after: str, workspace: str,
) -> dict[str, bool]:
    trial_id = fixture["trial_id"]
    launch = assert_launch_evidence(trial, assets, trial_id)
    probes = assert_probe_evidence(probe_path, trial_id)
    state = journal_state_admission(trial)
    path = trial.paths.agent_dir / f"trajectory/run-{root_run_id(trial_id)}.terminal.json"
    terminal = read_json(path)
    outer = read_json(trial.paths.artifacts_dir / OUTER_ENVELOPE_FILENAME)
    resolution = read_json(trial.paths.agent_dir / "arm-resolution.json")
    runtime = runtime_evidence_rows(
        launch, probes, state, terminal, fixture, before, after, workspace,
    )
    host = host_evidence_rows(launch, outer, resolution, inspection)
    host["credential"] = host["credential"] \
        and probes["sibling-capability-replay"]["status"] == "passed" \
        and probes["sibling-identifier-replay"]["status"] == "passed"
    return {**runtime, **host}


def assert_no_host_or_secret_leak(trial) -> None:
    forbidden = [REAL_FIXTURE_CREDENTIAL, str(Path.home()), str(REPO_ROOT)]
    roots = (trial.paths.agent_dir, trial.paths.artifacts_dir, trial.paths.verifier_dir)
    for root in roots:
        for path in root.rglob("*"):
            if path.is_file() and not path.is_symlink():
                data = path.read_bytes()
                assert all(value.encode() not in data for value in forbidden)


def cleanup_networks(networks: list[NetworkFacts]) -> None:
    for network in networks:
        docker("network", "rm", network.name, check=False)


def prepare_fixture(
    stack: ExitStack, root: Path, assets: OfflineAssets,
    trial_id: str, network: NetworkFacts,
) -> dict[str, object]:
    upstream_server, upstream = stack.enter_context(provider_server())
    _, arbitrary = stack.enter_context(provider_server())
    _, daemon = stack.enter_context(running_server(network.gateway))
    _, other_proxy_port = stack.enter_context(running_server(network.gateway))
    trial_root = root / trial_id
    trial_root.mkdir()
    inputs = trial_inputs(trial_root, assets, upstream, network, trial_id)
    host_canary = write_probe_instruction(
        inputs, trial_root, model_for(trial_id), upstream,
        daemon, arbitrary, other_proxy_port,
    )
    return {"trial_id": trial_id, "network": network, "inputs": inputs,
            "upstream": upstream_server, "host_canary": host_canary}


def assert_exact_public_entry(trial, trial_id: str) -> None:
    argv = trial.agent.preview_run_argv()
    assert argv[:2] == ["cortex", "agent-run"]
    assert argv[argv.index("--run-config") + 1] == "/logs/agent/arm-resolution.json"
    assert argv[argv.index("--root-run-id") + 1] == root_run_id(trial_id)
    assert "--prompt-file" in argv and "--events-file" in argv


def assert_pair_isolation(trials, fixtures, inspections) -> None:
    roots = [trial.paths.agent_dir.parent.resolve() for trial in trials]
    assert len(set(roots)) == len(trials)
    state_files = [trial.paths.agent_dir / "trial-home/cortex-home/state/tasks.json"
                   for trial in trials]
    assert len({path.resolve() for path in state_files}) == len(trials)
    assert all(path.resolve().is_relative_to(root) for path, root in zip(state_files, roots))
    mount_sources = [{item["Source"] for item in inspection["mounts"]}
                     for inspection in inspections]
    assert mount_sources[0].isdisjoint(mount_sources[1])
    assert len({item["container_id"] for item in inspections}) == len(trials)
    assert len({item["process_id"] for item in inspections}) == len(trials)
    sessions = [trial.agent.proxy_session for trial in trials]
    assert all(session is not None for session in sessions)
    assert len({session.handle.base_url for session in sessions}) == len(trials)
    assert len({session.handle.dummy_token for session in sessions}) == len(trials)
    for trial, fixture in zip(trials, fixtures):
        resolution = read_json(trial.paths.agent_dir / "arm-resolution.json")
        assert resolution["trial_id"] == fixture["trial_id"]
        assert resolution["arm"]["limits"]["max_parent_questions"] == 0
        assert resolution["roles"]["parent"]["mcp_composition"] == "none"
        assert resolution["roles"]["parent"]["mcp_config_paths"] == []


def test_concurrent_exact_production_trials_cannot_cross_boundaries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, offline_assets: OfflineAssets,
) -> None:
    admit_capability(monkeypatch, "claude-api-key")
    monkeypatch.setenv(CREDENTIAL_ENV, REAL_FIXTURE_CREDENTIAL)
    networks: list[NetworkFacts] = []
    try:
        networks = [create_trial_network(trial_id) for trial_id in TRIAL_IDS]
        with ExitStack() as stack:
            fixtures = [prepare_fixture(stack, tmp_path, offline_assets, trial_id, network)
                        for trial_id, network in zip(TRIAL_IDS, networks)]
            observed = asyncio.run(exercise_concurrent_trials(fixtures))
            trials, results, inspections, evidence, before, after, workspace = observed
            assert_pair_isolation(trials, fixtures, inspections)
            assert offline_assets.build_evidence["build"] == {"network": "none", "pull": "disabled"}
            for values in zip(trials, results, inspections, evidence, before, after,
                              workspace, fixtures):
                trial, result, inspection, probe, old, new, canary, fixture = values
                assert result.exception_info is None
                assert fixture["upstream"].request_count == 1
                assert inspection["container_image"] == offline_assets.image_id
                assert_exact_public_entry(trial, fixture["trial_id"])
                rows = production_evidence_rows(
                    trial, offline_assets, fixture, inspection, probe, old, new, canary,
                )
                assert set(rows) == REQUIRED_EVIDENCE_ROWS
                assert all(rows.values()), {name: value for name, value in rows.items() if not value}
                assert_no_host_or_secret_leak(trial)
    finally:
        cleanup_networks(networks)
