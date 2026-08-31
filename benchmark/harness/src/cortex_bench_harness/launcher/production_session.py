# input:  installed server, sealed home, production arm and instruction
# output: terminal production result, emitted evidence files, workdir contract proof
# pos:    Owns one production arm server lifecycle
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
import json
import shlex
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Protocol

from ..trial_assets import canonical_sha256
from .production_arms import TASK_ROOT, ProductionArmBundle, require_production_arm
from .production_home import MaterializedProductionHome

PROJECT_ID = "general"
SERVER_READY_TIMEOUT_SECONDS = 30.0
DISPATCH_WAIT_TIMEOUT_SECONDS = 120.0
SESSION_POLL_SECONDS = 1.0
HTTP_REQUEST_TIMEOUT_SECONDS = 10
TASK_CLI_TIMEOUT_SECONDS = 30
EVIDENCE_EXPORT_TIMEOUT_SECONDS = 120
SERVER_STOP_TIMEOUT_SECONDS = 30
GATEWAY_STATUS_URL = "http://127.0.0.1:9880/status"
SERVER_AUTH_FILENAME = "production-server-auth.json"
WEBHOOK_AUTH_FILENAME = "production-webhook-auth.json"
TASK_SPEC_FILENAME = "production-task-spec.json"
SESSION_OUTCOME_FILENAME = "production-session-outcome.json"
SESSION_OUTCOME_SCHEMA_VERSION = "cortex-bench-production-session-outcome/1"
DEADLINE_EXHAUSTED = "deadline_exhausted"
DEADLINE_REASON = "run_deadline_reached"
# `--auto-lock` acquires the project lock and deliberately never releases it, and the lock owner is
# `CORTEX_EXECUTION_ID` or else the calling process id. Each exec is a new process, so the launcher
# states one owner for the add and the release that follows it.
TASK_INJECTION_OWNER = "benchmark-launcher"
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


def _required_mapping(value: object, label: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ProductionSessionError(f"{label} response must be an object")
    return value


def _required_text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ProductionSessionError(f"{label} must be non-empty")
    return value


def _task_cli_result(stdout: str) -> object | None:
    """The JSON result inside a `cortex-task` output stream, or None when there is none.

    The shipped CLI prints its result as pretty-printed JSON, its own logger writes console lines
    to the same stream ahead of it, and its advisory notices trail it. The result is therefore the
    last complete object that opens at column zero, decoded and stopped there rather than read as
    the whole stream. The launcher adapts to the server it runs; it does not quiet that server to
    suit itself.
    """
    decoder = json.JSONDecoder()
    result: object | None = None
    for line in range(len(stdout)):
        if stdout[line] != "{" or (line and stdout[line - 1] != "\n"):
            continue
        try:
            value, _ = decoder.raw_decode(stdout, line)
        except ValueError:
            continue
        result = value
    return result


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
        dispatch_timeout_seconds: float = DISPATCH_WAIT_TIMEOUT_SECONDS,
    ) -> None:
        declared_bundle = require_production_arm(spec.arm)
        if declared_bundle != spec.materialized_home.arm_bundle:
            raise ProductionSessionError(
                "materialized home does not belong to the declared production arm")
        self._spec = spec
        self._poll_seconds = poll_interval_seconds
        self._ready_timeout_seconds = readiness_timeout_seconds
        self._dispatch_timeout_seconds = dispatch_timeout_seconds
        self._temporary_files: list[Path] = []
        self._stopped_cleanly = False

    @property
    def stopped_cleanly(self) -> bool:
        return self._stopped_cleanly

    @property
    def _arm_bundle(self) -> ProductionArmBundle:
        """The bundle this home was materialized from: the arm that is actually running."""
        return self._spec.materialized_home.arm_bundle

    async def run(self, instruction: str, execute: Executor) -> ProductionThreadResult:
        pid: int | None = None
        try:
            pid = await self._start_server(execute)
            await self._wait_until_ready(execute)
            thread_id = await self._inject_unit_of_work(instruction, execute)
            result = await self._wait_for_result(thread_id, execute)
            if result.status != "completed":
                self._write_terminal_outcome(result)
            if result.status != DEADLINE_EXHAUSTED:
                await self._export_evidence(execute)
                self._require_workspace_contract()
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
        url = f"http://127.0.0.1:{port}/webhook/thread-op"
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

    async def _inject_unit_of_work(self, instruction: str, execute: Executor) -> str:
        """The arm's own injection kind, resolved to the thread whose outcome the trial waits on.

        A thread root is posted to the webhook and its id comes back in the reply. A task root is
        added to the arm's task store and the production dispatcher decides when to run it and
        which thread runs it, so the launcher reads that thread back off the server.
        """
        if self._arm_bundle.injection == TASK_ROOT:
            await self._inject_task(instruction, execute)
            return await self._await_dispatched_thread(execute)
        return await self._start_thread(instruction, execute)

    async def _start_thread(self, instruction: str, execute: Executor) -> str:
        context = self._spec.materialized_home.production_evidence_context
        response = await self._post("production-thread-start.json", {
            "action": "start", "template": self._arm_bundle.root_template,
            "message": instruction,
            "projectId": PROJECT_ID, "productionBenchmarkEvidenceContext": context,
        }, execute)
        return _required_text(self._response_data(response).get("threadId"), "thread id")

    async def _task_cli(self, argv: Sequence[str], execute: Executor) -> Mapping[str, object]:
        """One production `cortex-task` call under the server's own sealed environment."""
        result = await execute(
            self._production_command(
                ["cortex-task", *argv], {"CORTEX_EXECUTION_ID": TASK_INJECTION_OWNER}),
            cwd=self._spec.workspace_cwd, timeout_sec=TASK_CLI_TIMEOUT_SECONDS,
        )
        label = f"cortex-task {argv[0]}"
        decoded = _task_cli_result(result.stdout or "")
        if decoded is None:
            raise ProductionSessionError(f"{label} printed no JSON result")
        response = _required_mapping(decoded, label)
        if response.get("success") is not True:
            raise ProductionSessionError(f"{label} refused: {response.get('message')}")
        return response

    async def _inject_task(self, instruction: str, execute: Executor) -> str:
        """The unit of work as a task in the arm's own store, added by the production CLI.

        The task store is the one part of the sealed home this arm reopens, and `cortex-task` is
        the shipped writer of it — the webhook's task-op route refuses an add from a caller that
        holds no project lock, and holding one is exactly what `--auto-lock` does here.
        """
        spec = self._write_request(TASK_SPEC_FILENAME, {
            "text": instruction,
            "why": "The trial's one unit of work, injected as this arm's task root.",
            "done-when": instruction,
            "template": self._arm_bundle.root_template, "priority": "high",
        })
        added = await self._task_cli([
            "add", "--project", PROJECT_ID, "--task-file", str(spec), "--auto-lock",
        ], execute)
        await self._task_cli(["lock-release", "--project", PROJECT_ID, "--json"], execute)
        return _required_text(added.get("task-id"), "injected task id")

    async def _await_dispatched_thread(self, execute: Executor) -> str:
        """The thread the production dispatcher started for the injected task.

        The dispatcher picks the task up on its own cycle, so the root appears after the add
        rather than in reply to it. The server lists newest first and the arm caps the tree at
        one task, so the first dispatch-triggered thread is its current attempt after a retry.
        """
        deadline = time.monotonic() + self._dispatch_timeout_seconds
        while time.monotonic() < deadline:
            try:
                response = await self._post("production-thread-list.json", {
                    "action": "list-threads", "scope": "project", "projectId": PROJECT_ID,
                }, execute)
            except Exception as error:
                if not _exec_timed_out(error):
                    raise
                await asyncio.sleep(self._poll_seconds)
                continue
            threads = self._response_data(response).get("threads")
            if not isinstance(threads, list):
                raise ProductionSessionError("thread-op list-threads must return a thread list")
            dispatched = [
                thread for thread in threads
                if isinstance(thread, Mapping) and thread.get("trigger") == "task-dispatch"
            ]
            if dispatched:
                return _required_text(dispatched[0].get("threadId"), "dispatched thread id")
            await asyncio.sleep(self._poll_seconds)
        raise ProductionSessionError("production task dispatch did not start a thread")

    def _run_deadline(self) -> float:
        limits = _required_mapping(self._spec.arm.get("limits"), "arm limits")
        seconds = limits.get("deadline_seconds")
        if not isinstance(seconds, int) or isinstance(seconds, bool) or seconds <= 0:
            raise ProductionSessionError("arm deadline_seconds must be a positive integer")
        return time.monotonic() + seconds

    async def _wait_for_result(self, thread_id: str, execute: Executor) -> ProductionThreadResult:
        deadline = self._run_deadline()
        while time.monotonic() < deadline:
            try:
                response = await self._post(
                    "production-thread-result.json",
                    {"action": "result", "threadId": thread_id}, execute,
                )
            except Exception as error:
                # A result poll is observational. Harbor may time out one Docker exec while the
                # server is busy even though the thread and its campaign deadline remain live.
                # Retry only that typed/message-shaped timeout; all other exec failures stay fatal.
                if not _exec_timed_out(error):
                    raise
                await asyncio.sleep(self._poll_seconds)
                continue
            data = self._response_data(response)
            if data.get("terminal") is True:
                return self._parse_result(data, thread_id)
            await asyncio.sleep(self._poll_seconds)
        return ProductionThreadResult(thread_id, DEADLINE_EXHAUSTED, None, None)

    def _write_terminal_outcome(self, result: ProductionThreadResult) -> None:
        reason = (
            DEADLINE_REASON if result.status == DEADLINE_EXHAUSTED
            else f"thread_{result.status}"
        )
        document = {
            "schema_version": SESSION_OUTCOME_SCHEMA_VERSION,
            "trial_id": self._spec.trial_id, "thread_id": result.thread_id,
            "terminal": True, "status": result.status,
            "terminal_reason": reason, "artifact": result.artifact,
            "final_output": result.final_output,
        }
        path = self._spec.logs_dir / SESSION_OUTCOME_FILENAME
        path.write_text(
            json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )

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
        return {
            "outputDirectory": str(self._container_path("trajectory")),
            "project": PROJECT_ID, "trialId": self._spec.trial_id,
            "rootRunId": self._spec.root_run_id, "armName": self._spec.arm["name"],
            "armCanonicalSha256": canonical_sha256(self._spec.arm),
            "bundleManifestHash": self._spec.materialized_home.bundle_manifest_hash,
            "mode": self._arm_bundle.evidence_mode,
            "expectedRoles": list(self._arm_bundle.expected_roles),
            "managerQa": self._arm_bundle.manager_qa,
            "proxyExport": _unavailable_proxy(self._spec.trial_id),
        }

    async def _export_evidence(self, execute: Executor) -> None:
        path = self._write_request("production-evidence-input.json", self._evidence_input())
        await execute(
            self._production_command(
                ["cortex-evidence-export", "--input-file", str(path)]),
            cwd=self._spec.workspace_cwd, timeout_sec=EVIDENCE_EXPORT_TIMEOUT_SECONDS,
        )

    def _require_workspace_contract(self) -> None:
        """Every attempt must report the workdir this launcher resolved, or the trial is void.

        The journal header and the backend spawn used to answer "where does the model run" from
        two separate fallbacks, so the evidence could name the task workdir while the model's own
        tools ran inside the sealed home -- a disagreement no artifact stated and no score could
        reveal. The two are one expression now; this reads the published header back and refuses
        the trial if they ever part again, because a trial whose evidence names the wrong
        directory is a harness defect, not an agent failure.
        """
        journal = self._spec.logs_dir / "trajectory" / "events.jsonl"
        if not journal.is_file():
            raise ProductionSessionError("production trajectory journal was not exported")
        headers = 0
        for line in journal.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as error:
                raise ProductionSessionError("production trajectory journal is malformed") from error
            if not isinstance(record, Mapping) or record.get("type") != "run_header":
                continue
            headers += 1
            reported = record.get("resolved_cwd")
            if reported != self._spec.workspace_cwd:
                raise ProductionSessionError(
                    f"attempt {record.get('agent_slot')!r} reports cwd {reported!r}, "
                    f"but the task workdir is {self._spec.workspace_cwd!r}")
        if headers == 0:
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
