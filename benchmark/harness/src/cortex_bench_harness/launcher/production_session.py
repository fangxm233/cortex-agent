import asyncio
import json
import shlex
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Protocol

from ..trial_assets import canonical_sha256
from .production_arms import require_production_arm
from .production_home import MaterializedProductionHome

PROJECT_ID = "general"
SERVER_READY_TIMEOUT_SECONDS = 30.0
SESSION_POLL_SECONDS = 1.0
HTTP_REQUEST_TIMEOUT_SECONDS = 10
EVIDENCE_EXPORT_TIMEOUT_SECONDS = 120
WORKSPACE_CONTRACT_TIMEOUT_SECONDS = 30
SERVER_STOP_TIMEOUT_SECONDS = 30
GATEWAY_STATUS_URL = "http://127.0.0.1:9880/status"
SERVER_AUTH_FILENAME = "production-server-auth.json"
WEBHOOK_AUTH_FILENAME = "production-webhook-auth.json"
SESSION_OUTCOME_FILENAME = "production-session-outcome.json"
SESSION_OUTCOME_SCHEMA_VERSION = "cortex-bench-production-session-outcome/2"
SESSION_ROUTE = "/webhook/benchmark-session"
DEADLINE_EXHAUSTED = "deadline_exhausted"
DEADLINE_REASON = "run_deadline_reached"
# The bearer arrives by file path, never by exec environment and never in argv. The sealed
# container environment is an exact identity — keys and value digest — so one extra exec-time
# variable refuses the whole call, and a value in the command string would be argv the leak
# scanner reads. This is the same one-shot-file delivery `_write_server_auth` uses.
HTTP_CLIENT = """
import fs from 'node:fs';
const [url, input, auth] = process.argv.slice(1);
const response = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-cortex-token': JSON.parse(fs.readFileSync(auth, 'utf8')).webhookToken,
  },
  body: fs.readFileSync(input),
});
const body = await response.text();
if (!response.ok) throw new Error(`HTTP ${response.status}: ${body}`);
process.stdout.write(body);
""".strip()


# The workspace-contract reader. It answers three states the host must tell apart -- the journal
# was never exported, it exists but is not the newline-delimited JSON it claims to be, or it is
# readable -- and returns nothing else. Reducing it to the run headers here rather than shipping
# the whole journal back through stdout keeps a 700 KB trajectory out of an exec result.
WORKSPACE_CONTRACT_READER = """
import fs from 'node:fs';
const [journal] = process.argv.slice(1);
let report = { journal: 'absent' };
if (fs.existsSync(journal)) {
  try {
    const rows = fs.readFileSync(journal, 'utf8')
      .split('\\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
    report = {
      journal: 'read',
      headers: rows
        .filter((row) => row && row.type === 'run_header')
        .map((row) => ({ slot: row.agent_slot ?? null, cwd: row.resolved_cwd ?? null })),
    };
  } catch {
    report = { journal: 'malformed' };
  }
}
process.stdout.write(JSON.stringify(report));
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
class ProductionSessionResult:
    """How the trial's session ended: its last turn's status and final output."""

    session_id: str
    status: str
    final_output: str | None


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


def _exec_timed_out(error: Exception) -> bool:
    """Whether Harbor's executor exhausted the declared per-command timeout."""
    return (
        isinstance(error, TimeoutError)
        or isinstance(error, RuntimeError)
        and str(error).startswith("Command timed out after ")
    )


class ProductionServerSession:
    def __init__(
        self, spec: ProductionSessionSpec, *,
        poll_interval_seconds: float = SESSION_POLL_SECONDS,
        readiness_timeout_seconds: float = SERVER_READY_TIMEOUT_SECONDS,
    ) -> None:
        declared_bundle = require_production_arm(spec.arm)
        if declared_bundle != spec.materialized_home.arm_bundle:
            raise ProductionSessionError(
                "materialized home does not belong to the declared production arm")
        self._spec = spec
        self._poll_seconds = poll_interval_seconds
        self._ready_timeout_seconds = readiness_timeout_seconds
        self._temporary_files: list[Path] = []
        self._stopped_cleanly = False

    @property
    def stopped_cleanly(self) -> bool:
        return self._stopped_cleanly

    async def run(self, instruction: str, execute: Executor) -> ProductionSessionResult:
        pid: int | None = None
        try:
            pid = await self._start_server(execute)
            await self._wait_until_ready(execute)
            session_id = await self._start_session(instruction, execute)
            result = await self._wait_for_result(session_id, execute)
            if result.status != "completed":
                self._write_terminal_outcome(result)
            if result.status != DEADLINE_EXHAUSTED:
                await self._export_evidence(execute)
                await self._require_workspace_contract(execute)
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

    def _production_command(
        self, argv: Sequence[str], extra: Mapping[str, str] | None = None,
    ) -> str:
        """One command under the server's own sealed process environment.

        The admitted container environment names a different CORTEX_HOME, and admission refuses
        any exec-time variable, so every process that has to read the production home composes
        that environment inside the command — the same `env -i` construction the bootstrap uses.
        """
        environment = {
            **self._spec.materialized_home.process_environment, **(extra or {}),
        }
        assignments = [f"{key}={value}" for key, value in sorted(environment.items())]
        return shlex.join(["env", "-i", *assignments, *argv])

    def _launch_command(self, auth_path: PurePosixPath) -> str:
        app = self._spec.installed.bundle_root / "dist/entry/production-app-bootstrap.js"
        prefix = self._production_command(
            ["setsid", "node", str(app)],
            {"CORTEX_PRODUCTION_AUTH_FILE": str(auth_path)},
        )
        stdout = shlex.quote(str(self._container_path("stdout.txt")))
        stderr = shlex.quote(str(self._container_path("stderr.txt")))
        return f"{prefix} >{stdout} 2>{stderr} </dev/null & printf '%s\\n' \"$!\""

    def _write_server_auth(self) -> PurePosixPath:
        path = self._write_request(SERVER_AUTH_FILENAME, {
            "clientToken": self._spec.materialized_home.client_token,
            "webhookToken": self._spec.materialized_home.webhook_token,
        })
        # The bind-mounted log owner may not equal the container UID. The bootstrap unlinks this
        # one-shot file before importing the app or spawning any model-controlled process.
        (self._spec.logs_dir / SERVER_AUTH_FILENAME).chmod(0o444)
        return path

    async def _start_server(self, execute: Executor) -> int:
        result = await execute(
            self._launch_command(self._write_server_auth()), cwd=self._spec.workspace_cwd,
        )
        text = (result.stdout or "").strip()
        if not text.isdigit() or int(text) <= 0:
            raise ProductionSessionError("production server did not return a process-group id")
        return int(text)

    def _http_command(
        self, request_path: PurePosixPath, auth_path: PurePosixPath,
    ) -> str:
        environment = self._spec.materialized_home.process_environment
        port = environment["WEBHOOK_PORT"]
        url = f"http://127.0.0.1:{port}{SESSION_ROUTE}"
        return shlex.join([
            "node", "--input-type=module", "--eval", HTTP_CLIENT,
            url, str(request_path), str(auth_path),
        ])

    def _write_webhook_auth(self) -> PurePosixPath:
        return self._write_request(WEBHOOK_AUTH_FILENAME, {
            "webhookToken": self._spec.materialized_home.webhook_token,
        })

    async def _post(self, name: str, body: Mapping[str, object], execute: Executor) -> Mapping[str, object]:
        request = self._write_request(name, body)
        auth = self._write_webhook_auth()
        try:
            result = await execute(
                self._http_command(request, auth),
                cwd=self._spec.workspace_cwd, timeout_sec=HTTP_REQUEST_TIMEOUT_SECONDS,
            )
        finally:
            (self._spec.logs_dir / WEBHOOK_AUTH_FILENAME).unlink(missing_ok=True)
        try:
            response = json.loads(result.stdout or "")
        except json.JSONDecodeError as error:
            raise ProductionSessionError("benchmark-session returned malformed JSON") from error
        return _required_mapping(response, "benchmark-session")

    @staticmethod
    def _response_data(response: Mapping[str, object]) -> Mapping[str, object]:
        if response.get("success") is not True:
            raise ProductionSessionError(
                f"benchmark-session refused request: {response.get('error')}")
        return _required_mapping(response.get("data"), "benchmark-session data")

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
                data = self._response_data(await self._post(
                    "production-session-ready.json", {"action": "ping"}, execute,
                ))
                if data.get("ready") is not True:
                    raise ProductionSessionError("benchmark-session is not ready")
                await self._probe_gateway(execute)
                return
            except Exception as error:
                last_error = error
                await asyncio.sleep(self._poll_seconds)
        raise ProductionSessionError("production server readiness timed out") from last_error

    async def _start_session(self, instruction: str, execute: Executor) -> str:
        """The trial's one unit of work, handed to a fresh direct session as its first message."""
        context = self._spec.materialized_home.production_evidence_context
        response = await self._post("production-session-start.json", {
            "action": "start", "message": instruction,
            "projectId": PROJECT_ID, "productionBenchmarkEvidenceContext": context,
        }, execute)
        return _required_text(self._response_data(response).get("sessionId"), "session id")

    def _run_deadline(self) -> float:
        limits = _required_mapping(self._spec.arm.get("limits"), "arm limits")
        seconds = limits.get("deadline_seconds")
        if not isinstance(seconds, int) or isinstance(seconds, bool) or seconds <= 0:
            raise ProductionSessionError("arm deadline_seconds must be a positive integer")
        return time.monotonic() + seconds

    async def _wait_for_result(self, session_id: str, execute: Executor) -> ProductionSessionResult:
        deadline = self._run_deadline()
        while time.monotonic() < deadline:
            try:
                response = await self._post(
                    "production-session-status.json",
                    {"action": "status", "sessionId": session_id}, execute,
                )
            except Exception as error:
                # A status poll is observational. Harbor may time out one Docker exec while the
                # server is busy even though the session and its campaign deadline remain live.
                # Retry only that typed/message-shaped timeout; all other exec failures stay fatal.
                if not _exec_timed_out(error):
                    raise
                await asyncio.sleep(self._poll_seconds)
                continue
            data = self._response_data(response)
            if data.get("terminal") is True:
                return self._parse_result(data, session_id)
            await asyncio.sleep(self._poll_seconds)
        return ProductionSessionResult(session_id, DEADLINE_EXHAUSTED, None)

    def _write_terminal_outcome(self, result: ProductionSessionResult) -> None:
        reason = (
            DEADLINE_REASON if result.status == DEADLINE_EXHAUSTED
            else f"session_{result.status}"
        )
        document = {
            "schema_version": SESSION_OUTCOME_SCHEMA_VERSION,
            "trial_id": self._spec.trial_id, "session_id": result.session_id,
            "terminal": True, "status": result.status,
            "terminal_reason": reason, "final_output": result.final_output,
        }
        path = self._spec.logs_dir / SESSION_OUTCOME_FILENAME
        path.write_text(
            json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )

    @staticmethod
    def _parse_result(data: Mapping[str, object], session_id: str) -> ProductionSessionResult:
        if data.get("sessionId") != session_id:
            raise ProductionSessionError("benchmark-session status identity mismatch")
        final_output = data.get("finalOutput")
        if final_output is not None and not isinstance(final_output, str):
            raise ProductionSessionError("session final output must be text or null")
        return ProductionSessionResult(
            session_id, _required_text(data.get("status"), "session status"), final_output,
        )

    def _evidence_input(self) -> dict[str, object]:
        return {
            "outputDirectory": str(self._container_path("trajectory")),
            "trialId": self._spec.trial_id,
            "rootRunId": self._spec.root_run_id, "armName": self._spec.arm["name"],
            "armCanonicalSha256": canonical_sha256(self._spec.arm),
            "bundleManifestHash": self._spec.materialized_home.bundle_manifest_hash,
            "proxyExport": _unavailable_proxy(self._spec.trial_id),
        }

    async def _export_evidence(self, execute: Executor) -> None:
        path = self._write_request("production-evidence-input.json", self._evidence_input())
        await execute(
            self._production_command(
                ["cortex-evidence-export", "--input-file", str(path)]),
            cwd=self._spec.workspace_cwd, timeout_sec=EVIDENCE_EXPORT_TIMEOUT_SECONDS,
        )

    async def _require_workspace_contract(self, execute: Executor) -> None:
        """Every attempt must report the workdir this launcher resolved, or the trial is void.

        The journal header and the backend spawn used to answer "where does the model run" from
        two separate fallbacks, so the evidence could name the task workdir while the model's own
        tools ran inside the sealed home -- a disagreement no artifact stated and no score could
        reveal. The two are one expression now; this reads the published header back and refuses
        the trial if they ever part again, because a trial whose evidence names the wrong
        directory is a harness defect, not an agent failure.

        READ IN THE CONTAINER, NOT ACROSS THE MOUNT. The exporter runs as root and gives its
        output directory mode 700, so on the host -- where the launcher is an ordinary user --
        even stat() of the journal fails until the container is gone and the tree is chowned. By
        then the trial is scored and it is too late to void it. The bytes are the same bytes;
        this reads them on the side that owns them.
        """
        script = shlex.join([
            "node", "--input-type=module", "--eval", WORKSPACE_CONTRACT_READER,
            str(self._container_path("trajectory") / "events.jsonl"),
        ])
        try:
            result = await execute(
                script, cwd=self._spec.workspace_cwd,
                timeout_sec=WORKSPACE_CONTRACT_TIMEOUT_SECONDS,
            )
        except Exception as error:
            raise ProductionSessionError(
                "production trajectory journal could not be read") from error
        try:
            report = json.loads(result.stdout or "")
        except json.JSONDecodeError as error:
            raise ProductionSessionError(
                "production trajectory journal reader returned malformed JSON") from error
        state = _required_mapping(report, "workspace contract report").get("journal")
        if state == "absent":
            raise ProductionSessionError("production trajectory journal was not exported")
        if state != "read":
            raise ProductionSessionError("production trajectory journal is malformed")
        headers = report.get("headers")
        if not isinstance(headers, list):
            raise ProductionSessionError("workspace contract report carries no header list")
        for header in headers:
            reported = _required_mapping(header, "workspace contract header").get("cwd")
            if reported != self._spec.workspace_cwd:
                raise ProductionSessionError(
                    f"attempt {header.get('slot')!r} reports cwd {reported!r}, "
                    f"but the task workdir is {self._spec.workspace_cwd!r}")
        if not headers:
            raise ProductionSessionError("production trajectory journal carries no run header")

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
