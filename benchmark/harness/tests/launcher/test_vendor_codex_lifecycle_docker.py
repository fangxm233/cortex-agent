# input:  real Docker Codex image, synthetic Responses upstream
# output: dummy-auth, native-default request and lifecycle proof
# pos:    Real-container boundary test for current Codex runtime
# >>> If I am updated, update my header and folder CORTEX.md <<<

import argparse
import base64
import json
import shlex
import threading
import uuid
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
import yaml

import cortex_bench_harness.vendor_agents as vendor_agents
from cortex_bench_harness import campaign
from cortex_bench_harness.proxy.adapters.openai_codex_responses import JWT_ACCOUNT_CLAIM
from cortex_bench_harness.vendor_agents import VendorLifecycleMixin
from docker_gate import docker_opt_in

HARNESS_DIR = Path(__file__).resolve().parents[2]
IMAGE_MANIFEST = HARNESS_DIR / "scripts/terminal-bench-2.1-images.json"
MODEL = "gpt-5.6-sol"
VERSION = "0.148.0"
CREDENTIAL_ENV = "CORTEX_BENCH_CODEX_DOCKER_CREDENTIAL"
FORBIDDEN_ENV = "CORTEX_BENCH_CODEX_DOCKER_FORBIDDEN"
CHECKOUT_ENV = "CORTEX_BENCH_CODEX_DOCKER_CHECKOUT"
IDENTITY_ENV = "CORTEX_BENCH_CODEX_DOCKER_IDENTITY"
TRIAL_ID = "vendor-codex-task-pure-codex"

pytestmark = docker_opt_in


def _segment(document: dict[str, object]) -> str:
    payload = json.dumps(document, separators=(",", ":")).encode()
    return base64.b64encode(payload).decode().rstrip("=")


def _credential() -> str:
    expiry = int((datetime.now(UTC) + timedelta(hours=2)).timestamp())
    return ".".join((
        _segment({"alg": "none", "typ": "JWT"}),
        _segment({JWT_ACCOUNT_CLAIM: {"chatgpt_account_id": "synthetic-docker"}, "exp": expiry}),
        _segment({"synthetic": True}),
    ))


def _response() -> bytes:
    message = {
        "id": "msg_docker", "type": "message", "status": "completed",
        "role": "assistant", "content": [{
            "type": "output_text", "text": "LIFECYCLE_OK", "annotations": [], "logprobs": [],
        }],
    }
    base = {
        "id": "resp_docker", "object": "response", "status": "in_progress",
        "model": MODEL, "output": [], "usage": None,
    }
    completed = {
        **base, "status": "completed", "error": None, "incomplete_details": None,
        "output": [message], "usage": {
            "input_tokens": 1, "output_tokens": 1, "total_tokens": 2,
            "input_tokens_details": {"cached_tokens": 0},
            "output_tokens_details": {"reasoning_tokens": 0},
        },
    }
    events = [
        {"type": "response.created", "response": base},
        {"type": "response.output_item.done", "output_index": 0, "item": message},
        {"type": "response.completed", "response": completed},
    ]
    return ("".join(
        f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events
    ) + "data: [DONE]\n\n").encode()


class _Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        payload = self.rfile.read(int(self.headers.get("content-length", "0")))
        self.server.requests.append(json.loads(payload))  # type: ignore[attr-defined]
        body = _response()
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


class _Upstream:
    def __enter__(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.server.requests = []  # type: ignore[attr-defined]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_args: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}"

    @property
    def requests(self) -> list[dict[str, object]]:
        return self.server.requests  # type: ignore[attr-defined,return-value]


def _image_ref() -> str:
    manifest = json.loads(IMAGE_MANIFEST.read_text())
    task = next(item for item in manifest["tasks"] if item["task_id"] == "chess-best-move")
    variant = task["variants"]["codex"]
    return f"{variant['final_image_tag'].split(':')[0]}@{variant['final_image_digest']}"


def _write_task(root: Path) -> Path:
    task = root / "task"
    (task / "tests").mkdir(parents=True)
    (task / "instruction.md").write_text("Reply with LIFECYCLE_OK.\n")
    (task / "task.toml").write_text(
        f"[environment]\ndocker_image = {json.dumps(_image_ref())}\n"
        'network_mode = "public"\nos = "linux"\n\n'
        "[agent]\ntimeout_sec = 60\n\n[verifier]\ntimeout_sec = 30\n"
    )
    verifier = task / "tests/test.sh"
    verifier.write_text("#!/bin/sh\nset -eu\nprintf '1\\n' > /logs/verifier/reward.txt\n")
    verifier.chmod(0o755)
    return task


def _inputs(root: Path) -> dict[str, str]:
    paths = {name: root / filename for name, filename in (
        ("wheel_path", "harness.whl"), ("lockfile_path", "uv.lock"),
        ("npm_artifact_path", "server.tgz"),
    )}
    for path in paths.values():
        path.write_bytes(b"codex Docker lifecycle fixture\n")
    return {**{name: str(path) for name, path in paths.items()},
            "lockfile_manifest_path": "benchmark/harness/uv.lock"}


def _arm() -> dict[str, object]:
    return {
        "name": "pure-codex", "kind": "vendor-baseline", "vendor_agent": "codex",
        "vendor_cli_version": VERSION, "provider": "openai-codex", "model": MODEL,
        "credential_capability": "codex-subscription", "limits": {
            "max_provider_requests": 4, "max_cost_usd": "0.01",
            "deadline_seconds": 60, "max_output_tokens": 65_536,
        },
    }


def _document(root: Path, upstream: str) -> dict[str, object]:
    subnet = uuid.uuid4().int % 512
    return {
        "schema_version": "cortex-bench-campaign/1", "campaign": "vendor-codex-docker",
        "paid": False, "trials_dir": str(root / "trials"), "concurrency": 1,
        "cli_version": "unused", "manifest": _inputs(root),
        "credential": {"upstream_base_url": upstream, "route_identity_host": "chatgpt.com",
                       "proxy_host_suffix": "proxy.invalid", "dummy_token_ref": "dummy-only"},
        "host_scan_policy": {
            "secret_environment": {"provider_credential": CREDENTIAL_ENV},
            "forbidden_environment": {"ambient": FORBIDDEN_ENV},
            "forbidden_argv_environment": {},
            "repository_checkout_environment": CHECKOUT_ENV,
            "host_identity_environment": {"machine": IDENTITY_ENV},
        },
        "docker_network": {"subnet_pool": f"10.253.{subnet % 256}.0/24",
                           "subnet_prefix": 24},
        "proxy": {"credential_env": CREDENTIAL_ENV, "listen_host": "0.0.0.0",
                  "request_body_limit_bytes": 67_108_864,
                  "response_body_limit_bytes": 67_108_864},
        "arms": [_arm()],
        "network": {"mode": "filtered"},
        "tasks": [{"task_id": "task", "path": str(_write_task(root)),
                   "image_ref": _image_ref()}], "comparisons": [],
    }


def _observe_first_cli(monkeypatch: pytest.MonkeyPatch) -> None:
    original = VendorLifecycleMixin._setup_command
    wrapper = (
        "#!/bin/sh\nset -eu\n"
        "test -s /logs/agent/trial-home/codex-home/auth.json\n"
        "test -s /logs/agent/trial-home/codex-home/config.toml\n"
        "test -s /logs/agent/vendor-runtime-files.json\n"
        "printf 'dummy-config-present-before-cli\\n' > /logs/agent/first-vendor-cli.txt\n"
        "exec /usr/local/bin/codex.real \"$@\"\n"
    )

    def observed(self: VendorLifecycleMixin, files: object) -> str:
        command = original(self, files)  # type: ignore[arg-type]
        return (
            f"{command}; mv /usr/local/bin/codex /usr/local/bin/codex.real; "
            f"printf %s {shlex.quote(wrapper)} > /usr/local/bin/codex; "
            "chmod 0755 /usr/local/bin/codex"
        )

    monkeypatch.setattr(VendorLifecycleMixin, "_setup_command", observed)


def _install_environment(monkeypatch: pytest.MonkeyPatch, credential: str) -> None:
    monkeypatch.setenv(CREDENTIAL_ENV, credential)
    monkeypatch.setenv(FORBIDDEN_ENV, "forbidden-codex-environment")
    monkeypatch.setenv(CHECKOUT_ENV, "/private/codex-docker-checkout")
    monkeypatch.setenv(IDENTITY_ENV, "private-codex-docker-machine")


def _track_routes(monkeypatch: pytest.MonkeyPatch) -> dict[str, int]:
    counts = {"arm": 0, "revoke": 0}
    original_arm, original_revoke = vendor_agents.arm_trial_proxy, vendor_agents.revoke_trial_proxy

    def arm(*args: object, **kwargs: object):
        counts["arm"] += 1
        return original_arm(*args, **kwargs)

    def revoke(*args: object, **kwargs: object):
        counts["revoke"] += 1
        return original_revoke(*args, **kwargs)

    monkeypatch.setattr(vendor_agents, "arm_trial_proxy", arm)
    monkeypatch.setattr(vendor_agents, "revoke_trial_proxy", revoke)
    return counts


def _run(root: Path, upstream: str) -> dict[str, object]:
    path = root / "campaign.yaml"
    path.write_text(yaml.safe_dump(_document(root, upstream)))
    return campaign.run(argparse.Namespace(config=str(path), dry_run=False))


def test_current_codex_image_completes_real_docker_lifecycle_with_native_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    credential = _credential()
    _install_environment(monkeypatch, credential)
    _observe_first_cli(monkeypatch)
    counts = _track_routes(monkeypatch)
    with _Upstream() as upstream:
        result = _run(tmp_path, upstream.base_url)
    trial = tmp_path / "trials" / TRIAL_ID
    assert result["trials"][0]["outcome_state"] == "terminal-success"
    assert result["trials"][0]["verifier_rewards"] == {"reward": 1.0}
    assert counts == {"arm": 1, "revoke": 1}
    assert [request["model"] for request in upstream.requests] == [MODEL]
    assert "max_output_tokens" not in upstream.requests[0]
    assert credential not in "".join(
        path.read_text(errors="ignore") for path in trial.rglob("*") if path.is_file()
    )
