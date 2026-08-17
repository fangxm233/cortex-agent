# input:  installed server, sealed home, direct arm and instruction
# output: terminal production thread and emitted evidence files
# pos:    Owns one production direct-arm server lifecycle
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
import json
import shlex
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Protocol

from ..trial_assets import canonical_sha256
from .production_home import MaterializedProductionHome

PROJECT_ID = "general"
TEMPLATE_NAME = "benchmark-direct"
SERVER_READY_TIMEOUT_SECONDS = 30.0
SESSION_POLL_SECONDS = 1.0
HTTP_REQUEST_TIMEOUT_SECONDS = 10
EVIDENCE_EXPORT_TIMEOUT_SECONDS = 120
SERVER_STOP_TIMEOUT_SECONDS = 30
GATEWAY_STATUS_URL = "http://127.0.0.1:9880/status"
HTTP_CLIENT = """
import fs from 'node:fs';
const [url, input] = process.argv.slice(1);
const response = await fetch(url, {
  method: 'POST',
  headers: {'content-type': 'application/json', 'x-cortex-token': process.env.CORTEX_WEBHOOK_TOKEN},
  body: fs.readFileSync(input),
});
const body = await response.text();
if (!response.ok) throw new Error(`HTTP ${response.status}: ${body}`);
process.stdout.write(body);
""".strip()


class ProductionSessionError(RuntimeError):
    """The production server session could not preserve its launch contract."""


class ExecResult(Protocol):
    stdout: str | None
    stderr: str | None


Executor = Callable[..., Awaitable[ExecResult]]


@dataclass(frozen=True)
class InstalledProductionServer:
    bundle_root: PurePosixPath
    backend_cli_path: PurePosixPath
    backend_cli_version: str


@dataclass(frozen=True)
class ProductionSessionSpec:
    logs_dir: Path
    container_logs_dir: PurePosixPath
    workspace_cwd: str
    arm: Mapping[str, object]
    trial_id: str
    root_run_id: str
    materialized_home: MaterializedProductionHome
    installed: InstalledProductionServer


@dataclass(frozen=True)
class ProductionThreadResult:
    thread_id: str
    status: str
    artifact: str | None
    final_output: str | None


def is_production_direct_candidate(arm: Mapping[str, object]) -> bool:
    orchestration = arm.get("orchestration")
    return (
        arm.get("kind") == "cortex" and arm.get("backend") == "pi"
        and arm.get("provider") == "deepseek"
        and arm.get("model") == "deepseek-v4-flash"
        and isinstance(orchestration, Mapping)
        and orchestration.get("mode") == "direct"
    )


def is_production_direct_arm(arm: Mapping[str, object]) -> bool:
    orchestration = arm.get("orchestration")
    limits = arm.get("limits")
    expected_limits = {
        "max_thread_starts": 0, "max_parent_questions": 0,
        "max_task_depth": 0, "max_tasks": 0,
        "max_resident_agent_processes": 1, "max_output_tokens": 65_536,
    }
    expected = (
        arm.get("schema_version") == "cortex-benchmark-arm/2",
        arm.get("kind") == "cortex",
        isinstance(arm.get("name"), str) and bool(arm.get("name")),
        arm.get("backend") == "pi", arm.get("provider") == "deepseek",
        arm.get("model") == "deepseek-v4-flash",
        arm.get("credential_capability") == "pi-deepseek-api-key",
        isinstance(orchestration, Mapping) and orchestration.get("mode") == "direct",
        isinstance(orchestration, Mapping) and orchestration.get("ask_manager") is False,
        isinstance(limits, Mapping)
        and all(limits.get(key) == value for key, value in expected_limits.items()),
    )
    return all(expected)


def require_production_direct_arm(arm: Mapping[str, object]) -> None:
    if not is_production_direct_arm(arm):
        raise ProductionSessionError(
            "production launcher requires the PI/DeepSeek direct arm; any arm that can enter "
            "the aistatus silent direct fallback is refused"
        )


def _required_mapping(value: object, label: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ProductionSessionError(f"{label} response must be an object")
    return value


def _required_text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ProductionSessionError(f"{label} must be non-empty")
    return value


def _unavailable_proxy(trial_id: str) -> dict[str, object]:
    unavailable = {"status": "unavailable", "reason": "counter_unreadable"}
    return {
        "schema_version": "cortex-bench-proxy-export/1", "trial_id": trial_id,
        "adapter_id": "trial-scoped-proxy", "requests": unavailable,
        "cached_tokens": unavailable, "input_tokens": unavailable,
        "output_tokens": unavailable, "audit_log": unavailable,
        "lease_echo": unavailable, "source": "proxy_export",
    }


class ProductionServerSession:
    def __init__(
        self, spec: ProductionSessionSpec, *,
        poll_interval_seconds: float = SESSION_POLL_SECONDS,
        readiness_timeout_seconds: float = SERVER_READY_TIMEOUT_SECONDS,
    ) -> None:
        require_production_direct_arm(spec.arm)
        self._spec = spec
        self._poll_seconds = poll_interval_seconds
        self._ready_timeout_seconds = readiness_timeout_seconds
        self._temporary_files: list[Path] = []
        self._stopped_cleanly = False

    @property
    def stopped_cleanly(self) -> bool:
        return self._stopped_cleanly

    async def run(self, instruction: str, execute: Executor) -> ProductionThreadResult:
        pid: int | None = None
        try:
            pid = await self._start_server(execute)
            await self._wait_until_ready(execute)
            thread_id = await self._start_thread(instruction, execute)
            result = await self._wait_for_result(thread_id, execute)
            await self._export_evidence(execute)
            return result
        finally:
            try:
                if pid is not None:
                    await self._stop_server(pid, execute)
            finally:
                self._remove_temporary_files()

    def _container_path(self, name: str) -> PurePosixPath:
        return self._spec.container_logs_dir / name

    def _write_request(self, name: str, value: Mapping[str, object]) -> PurePosixPath:
        local = self._spec.logs_dir / name
        local.parent.mkdir(parents=True, exist_ok=True)
        local.write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")
        self._temporary_files.append(local)
        return self._container_path(name)

    def _launch_command(self, auth_path: PurePosixPath) -> str:
        environment = {
            **self._spec.materialized_home.process_environment,
            "CORTEX_PRODUCTION_AUTH_FILE": str(auth_path),
        }
        assignments = [f"{key}={value}" for key, value in sorted(environment.items())]
        app = self._spec.installed.bundle_root / "dist/entry/production-app-bootstrap.js"
        prefix = shlex.join(["env", "-i", *assignments, "setsid", "node", str(app)])
        stdout = shlex.quote(str(self._container_path("stdout.txt")))
        stderr = shlex.quote(str(self._container_path("stderr.txt")))
        return f"{prefix} >{stdout} 2>{stderr} </dev/null & printf '%s\\n' \"$!\""

    def _write_server_auth(self) -> PurePosixPath:
        path = self._write_request("production-server-auth.json", {
            "clientToken": self._spec.materialized_home.client_token,
            "webhookToken": self._spec.materialized_home.webhook_token,
        })
        # The bind-mounted log owner may not equal the container UID. The bootstrap unlinks this
        # one-shot file before importing the app or spawning any model-controlled process.
        (self._spec.logs_dir / "production-server-auth.json").chmod(0o444)
        return path

    async def _start_server(self, execute: Executor) -> int:
        result = await execute(
            self._launch_command(self._write_server_auth()), cwd=self._spec.workspace_cwd,
        )
        text = (result.stdout or "").strip()
        if not text.isdigit() or int(text) <= 0:
            raise ProductionSessionError("production server did not return a process-group id")
        return int(text)

    def _http_command(self, request_path: PurePosixPath) -> str:
        environment = self._spec.materialized_home.process_environment
        port = environment["WEBHOOK_PORT"]
        url = f"http://127.0.0.1:{port}/webhook/thread-op"
        return shlex.join([
            "node", "--input-type=module", "--eval", HTTP_CLIENT,
            url, str(request_path),
        ])

    async def _post(self, name: str, body: Mapping[str, object], execute: Executor) -> Mapping[str, object]:
        request = self._write_request(name, body)
        token = self._spec.materialized_home.webhook_token
        result = await execute(
            self._http_command(request), env={"CORTEX_WEBHOOK_TOKEN": token},
            cwd=self._spec.workspace_cwd, timeout_sec=HTTP_REQUEST_TIMEOUT_SECONDS,
        )
        try:
            response = json.loads(result.stdout or "")
        except json.JSONDecodeError as error:
            raise ProductionSessionError("thread-op returned malformed JSON") from error
        return _required_mapping(response, "thread-op")

    @staticmethod
    def _response_data(response: Mapping[str, object]) -> Mapping[str, object]:
        if response.get("success") is not True:
            raise ProductionSessionError(f"thread-op refused request: {response.get('error')}")
        return _required_mapping(response.get("data"), "thread-op data")

    async def _probe_gateway(self, execute: Executor) -> None:
        script = (
            "const r=await fetch(process.argv[1]);"
            "const b=await r.text();"
            "if(!r.ok)throw new Error(`HTTP ${r.status}: ${b}`);"
            "process.stdout.write(b)"
        )
        await execute(
            shlex.join(["node", "--input-type=module", "--eval", script, GATEWAY_STATUS_URL]),
            cwd=self._spec.workspace_cwd, timeout_sec=HTTP_REQUEST_TIMEOUT_SECONDS,
        )

    async def _wait_until_ready(self, execute: Executor) -> None:
        deadline = time.monotonic() + self._ready_timeout_seconds
        last_error: Exception | None = None
        while time.monotonic() < deadline:
            try:
                self._response_data(await self._post(
                    "production-thread-ready.json", {"action": "list"}, execute,
                ))
                await self._probe_gateway(execute)
                return
            except Exception as error:
                last_error = error
                await asyncio.sleep(self._poll_seconds)
        raise ProductionSessionError("production server readiness timed out") from last_error

    async def _start_thread(self, instruction: str, execute: Executor) -> str:
        context = self._spec.materialized_home.production_evidence_context
        response = await self._post("production-thread-start.json", {
            "action": "start", "template": TEMPLATE_NAME, "message": instruction,
            "projectId": PROJECT_ID, "productionBenchmarkEvidenceContext": context,
        }, execute)
        return _required_text(self._response_data(response).get("threadId"), "thread id")

    def _run_deadline(self) -> float:
        limits = _required_mapping(self._spec.arm.get("limits"), "arm limits")
        seconds = limits.get("deadline_seconds")
        if not isinstance(seconds, int) or isinstance(seconds, bool) or seconds <= 0:
            raise ProductionSessionError("arm deadline_seconds must be a positive integer")
        return time.monotonic() + seconds

    async def _wait_for_result(self, thread_id: str, execute: Executor) -> ProductionThreadResult:
        deadline = self._run_deadline()
        while time.monotonic() < deadline:
            response = await self._post(
                "production-thread-result.json",
                {"action": "result", "threadId": thread_id}, execute,
            )
            data = self._response_data(response)
            if data.get("terminal") is True:
                return self._parse_result(data, thread_id)
            await asyncio.sleep(self._poll_seconds)
        raise ProductionSessionError("production thread result timed out")

    @staticmethod
    def _parse_result(data: Mapping[str, object], thread_id: str) -> ProductionThreadResult:
        if data.get("threadId") != thread_id:
            raise ProductionSessionError("thread-op result identity mismatch")
        artifact = data.get("artifact")
        final_output = data.get("finalOutput")
        if artifact is not None and not isinstance(artifact, str):
            raise ProductionSessionError("thread artifact must be text or null")
        if final_output is not None and not isinstance(final_output, str):
            raise ProductionSessionError("thread final output must be text or null")
        return ProductionThreadResult(
            thread_id, _required_text(data.get("status"), "thread status"),
            artifact, final_output,
        )

    def _evidence_input(self) -> dict[str, object]:
        limits = _required_mapping(self._spec.arm.get("limits"), "arm limits")
        return {
            "outputDirectory": str(self._container_path("trajectory")),
            "project": PROJECT_ID, "trialId": self._spec.trial_id,
            "rootRunId": self._spec.root_run_id, "armName": self._spec.arm["name"],
            "armCanonicalSha256": canonical_sha256(self._spec.arm),
            "bundleManifestHash": self._spec.materialized_home.bundle_manifest_hash,
            "mode": "direct", "expectedRoles": [TEMPLATE_NAME], "managerQa": None,
            "limits": {"max_task_depth": limits["max_task_depth"], "max_tasks": limits["max_tasks"]},
            "proxyExport": _unavailable_proxy(self._spec.trial_id),
        }

    async def _export_evidence(self, execute: Executor) -> None:
        path = self._write_request("production-evidence-input.json", self._evidence_input())
        await execute(
            shlex.join(["cortex-evidence-export", "--input-file", str(path)]),
            cwd=self._spec.workspace_cwd, timeout_sec=EVIDENCE_EXPORT_TIMEOUT_SECONDS,
        )

    async def _stop_server(self, pid: int, execute: Executor) -> None:
        command = (
            f"kill -TERM -- -{pid}; "
            f"for _ in $(seq 1 {SERVER_STOP_TIMEOUT_SECONDS * 10}); do "
            f"kill -0 -- -{pid} 2>/dev/null || exit 0; sleep 0.1; done; exit 1"
        )
        await execute(command, cwd=self._spec.workspace_cwd, timeout_sec=SERVER_STOP_TIMEOUT_SECONDS + 5)
        self._stopped_cleanly = True

    def _remove_temporary_files(self) -> None:
        for path in self._temporary_files:
            path.unlink(missing_ok=True)
        self._temporary_files.clear()
