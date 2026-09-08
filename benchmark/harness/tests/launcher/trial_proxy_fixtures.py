# input:  synthetic trial seeds, container probes, proxy sessions
# output: reusable wiring fixtures and recording handles
# pos:    Offline trial-proxy lifecycle fixture helpers
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
import socket
from datetime import UTC, datetime, timedelta
from pathlib import Path

from harbor.environments.base import ExecResult

from cortex_bench_harness.harbor_agent import CortexBenchAgent
from cortex_bench_harness.launcher.trial_proxy import (
    TrialProxySession, arm_trial_proxy, parse_trial_proxy_spec,
)
from cortex_bench_harness.proxy.adapters.openai_codex_responses import JWT_ACCOUNT_CLAIM

DIGEST = f"sha256:{'a' * 64}"
ROOT_RUN_ID = "trial-wiring.cortex-direct"
TRIAL_ID = "trial-wiring"
ARM_NAME = "cortex-direct"
MODEL = "deepseek-v4-flash"
DEADLINE_SECONDS = 90
CREDENTIAL_ENV = "CORTEX_BENCH_WIRING_CREDENTIAL"
REAL_CREDENTIAL = "sk-ant-WIRING-BOUNDARY-UNIQUE"
REQUEST_BODY_LIMIT_BYTES = 16 * 1024 * 1024
RESPONSE_BODY_LIMIT_BYTES = 16 * 1024 * 1024
BUNDLE_ROOT = "/installed-agent/npm/lib/node_modules/@cortex-agent/server"
CLI_PATH = "/usr/local/bin/pi"
CLI_VERSION = "0.82.1"
# A fixed host instant, so the provisional bound is an exact arithmetic expectation rather than a
# window. It is a host reading; nothing in this file derives it from a container clock.
H0_EPOCH_MS = 1_800_000_000_000


def closed_upstream() -> str:
    """A loopback port with nothing listening: a forwarded request fails to connect."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return f"http://127.0.0.1:{probe.getsockname()[1]}"


def cortex_arm(credential_capability: str = "pi-deepseek-api-key") -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-arm/2",
        "kind": "cortex", "name": ARM_NAME, "backend": "pi",
        "provider": "deepseek", "model": MODEL,
        "credential_capability": credential_capability,
        "orchestration": {"mode": "direct", "ask_manager": False},
        "limits": {
            "max_provider_requests": 8, "max_cost_usd": "2.50",
            "deadline_seconds": DEADLINE_SECONDS, "max_output_tokens": 65536,
        },
    }


def seed_credential(upstream: str) -> dict[str, object]:
    return {
        "upstream_base_url": upstream,
        "route_identity_host": "api.deepseek.com",
        "proxy_base_url": "http://trial-proxy.invalid",
        "dummy_token_ref": "offline-token-handle",
    }


def trial_seed(upstream: str, **overrides: object) -> dict[str, object]:
    return {
        "arm": cortex_arm(), "arm_path": f"arm://{ARM_NAME}", "trial_id": TRIAL_ID,
        "root_run_id": ROOT_RUN_ID,
        "task": {"task_id": "terminal-task", "image_ref": f"registry.invalid/task@{DIGEST}",
                 "image_digest": DIGEST},
        "profile_name": "benchmark", "paid_run": False,
        "credential": seed_credential(upstream), "model_alias_policy": {"kind": "exact"},
        **overrides,
    }


def manifest_seed(tmp_path: Path) -> dict[str, object]:
    files = {
        "wheel_path": tmp_path / "harness.whl",
        "lockfile_path": tmp_path / "uv.lock",
        "npm_artifact_path": tmp_path / "server.tgz",
    }
    for file in files.values():
        file.write_bytes(b"wiring fixture")
    return {
        "root_run_id": ROOT_RUN_ID, "trial_id": TRIAL_ID, "arm": ARM_NAME,
        **{name: str(file) for name, file in files.items()},
        "lockfile_manifest_path": "benchmark/harness/uv.lock",
        "image_ref": f"registry.invalid/task@{DIGEST}", "image_digest": DIGEST,
        "image_size_bytes": len(b"wiring fixture"),
    }


def proxy_spec(**overrides: object) -> dict[str, object]:
    return {
        "credential_env": CREDENTIAL_ENV, "bound_source_ip": "127.0.0.1",
        "advertised_host": f"{TRIAL_ID}.proxy.invalid",
        "request_body_limit_bytes": REQUEST_BODY_LIMIT_BYTES,
        "response_body_limit_bytes": RESPONSE_BODY_LIMIT_BYTES,
        **overrides,
    }


class ContainerEnvironment:
    """The container the agent probes, answering with container paths only, so no host path can
    enter the documents the agent writes."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.uploads: list[tuple[Path | str, str]] = []

    async def exec(self, command: str, **_kwargs: object) -> ExecResult:
        self.calls.append(command)
        responses = (
            (command.endswith("pwd") or "realpath -- /app" in command, "/app\n"),
            ("npm ls --global" in command, f"{BUNDLE_ROOT}\n"),
            (command.endswith("cortex daemon --version"), "2026.8.3-2\n"),
            ("command -v pi" in command, f"{CLI_PATH}\n"),
            (command.endswith("pi --version"), f"{CLI_VERSION}\n"),
        )
        for matches, stdout in responses:
            if matches:
                return ExecResult(stdout=stdout, return_code=0)
        return ExecResult(return_code=0)

    async def upload_file(self, source_path: Path | str, target_path: str) -> None:
        self.uploads.append((source_path, target_path))


def public_agent(
    tmp_path: Path, upstream: str, *, proxy: dict[str, object] | None = None,
    **seed_overrides: object,
) -> CortexBenchAgent:
    return CortexBenchAgent(
        logs_dir=tmp_path / "agent", artifact_dir=tmp_path / "artifacts",
        manifest=manifest_seed(tmp_path), trial_seed=trial_seed(upstream, **seed_overrides),
        trial_proxy=proxy_spec() if proxy is None else proxy,
    )


def arm_session(
    tmp_path: Path, upstream: str, *, arm: dict[str, object] | None = None,
    proxy_dir: Path | None = None, trial_roots: tuple[Path, ...] | None = None,
    now_ms: int = H0_EPOCH_MS, spec: dict[str, object] | None = None,
    credential: str = REAL_CREDENTIAL,
) -> TrialProxySession:
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    return arm_trial_proxy(
        arm=arm or cortex_arm(), trial_id=TRIAL_ID, upstream_base_url=upstream,
        spec=parse_trial_proxy_spec(spec or proxy_spec()),
        proxy_dir=proxy_dir or artifacts / "proxy",
        trial_roots=trial_roots or (artifacts,),
        environ={CREDENTIAL_ENV: credential}, now_ms=lambda: now_ms,
    )


def epoch_datetime(epoch_ms: int) -> datetime:
    return datetime(1970, 1, 1, tzinfo=UTC) + timedelta(milliseconds=epoch_ms)


def codex_vendor_arm() -> dict[str, object]:
    arm = cortex_arm("codex-subscription")
    arm.pop("backend")
    arm.pop("orchestration")
    arm.update({
        "kind": "vendor-baseline", "name": "pure-codex", "vendor_agent": "codex",
        "vendor_cli_version": "0.148.0", "provider": "openai-codex", "model": "gpt-5.6-sol",
    })
    return arm


def codex_token(expiry_ms: int) -> str:
    import base64

    def segment(document: dict[str, object]) -> str:
        encoded = json.dumps(document, separators=(",", ":")).encode()
        return base64.b64encode(encoded).decode().rstrip("=")

    return ".".join((
        segment({"alg": "none"}),
        segment({JWT_ACCOUNT_CLAIM: {"chatgpt_account_id": "acct-wiring"},
                 "exp": expiry_ms // 1000}),
        segment({"synthetic": True}),
    ))


class RecordingHandle:
    """A handle stand-in that records the order in which the revoke reads it."""

    def __init__(self, calls: list[str], *, stop_error: bool = False) -> None:
        self.calls = calls
        self.base_url = "http://127.0.0.1:1"
        self.dummy_token = "dummy-recording"
        self.trial_id = TRIAL_ID
        self._stop_error = stop_error
        self._stopped = False

    @property
    def lease_echo_record(self) -> dict[str, object]:
        return {"status": "unavailable", "reason": "no_echo_received"}

    @property
    def accounting_export(self) -> dict[str, object]:
        self.calls.append("export")
        return {"schema_version": "cortex-bench-proxy-export/1", "trial_id": TRIAL_ID}

    @property
    def final_accounting_export(self) -> dict[str, object]:
        self.calls.append("freeze_handlers")
        return self.accounting_export

    @property
    def revocation_evidence(self) -> dict[str, object]:
        if not self._stopped:
            raise RuntimeError("proxy revocation has not been proven")
        return {
            "schema_version": "cortex-bench-proxy-revocation/1", "trial_id": TRIAL_ID,
            "route_active": False, "listener_present": False,
            "serving_thread_alive": False, "active_handlers": 0, "body_handlers": 0,
        }

    def stop(self) -> None:
        self.calls.append("stop")
        if self._stop_error:
            raise RuntimeError("proxy client handlers did not stop")
        self._stopped = True


def recording_session(tmp_path: Path, calls: list[str], *, stop_error: bool = False):
    proxy_dir = tmp_path / "artifacts" / "proxy"
    proxy_dir.mkdir(parents=True, exist_ok=True)
    return TrialProxySession(
        handle=RecordingHandle(calls, stop_error=stop_error),
        upstream_base_url="http://127.0.0.1:1",
        absolute_deadline=epoch_datetime(H0_EPOCH_MS),
        provisional_bound_ms=H0_EPOCH_MS,
        proxy_dir=proxy_dir,
    )


