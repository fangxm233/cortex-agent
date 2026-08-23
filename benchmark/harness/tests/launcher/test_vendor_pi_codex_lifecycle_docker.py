# input:  real Docker PI image, admitted OpenAI Codex oauth cap, synthetic Responses upstream
# output: pure-PI request/lifecycle proof for the OpenAI Codex path
# pos:    Real-container boundary test for the new PI OpenAI Codex runtime
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
import zstandard

from capability_admission import admit_capability
from docker_gate import docker_opt_in
from launcher.test_vendor_codex_lifecycle_docker import _credential, _response
from launcher.test_vendor_lifecycle_docker import (
    CREDENTIAL_ENV,
    _campaign_document,
    _install_first_cli_observer,
    _install_scan_environment,
    _run_document,
    _track_routes,
)

MODEL = "gpt-5.6-sol"
CAMPAIGN = "vendor-pi-codex-docker"
ARM_NAME = "pure-pi"
TRIAL_ID = f"{CAMPAIGN}-task-{ARM_NAME}"
REWARD_VERIFIER = "#!/bin/sh\nset -eu\nprintf '1\\n' > /logs/verifier/reward.txt\n"

pytestmark = docker_opt_in


def _document(root: Path, upstream: str) -> dict[str, object]:
    document = _campaign_document(
        root,
        upstream,
        verifier=REWARD_VERIFIER,
        instruction="Reply with LIFECYCLE_OK.",
    )
    document["campaign"] = CAMPAIGN
    credential = dict(document["credential"])  # type: ignore[arg-type]
    credential["route_identity_host"] = "chatgpt.com"
    document["credential"] = credential
    arm = dict(document["arms"][0])  # type: ignore[index]
    limits = dict(arm["limits"])  # type: ignore[arg-type]
    limits["max_output_tokens"] = 65_536
    arm.update({
        "provider": "openai-codex",
        "model": MODEL,
        "thinking": "xhigh",
        "credential_capability": "pi-openai-codex-oauth",
        "limits": limits,
    })
    document["arms"] = [arm]
    return document


class _Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        payload = self.rfile.read(int(self.headers.get("content-length", "0")))
        if self.headers.get("content-encoding") == "zstd":
            payload = zstandard.ZstdDecompressor().decompress(payload)
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
    def __enter__(self) -> "_Upstream":
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


def _read_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def _trial_root(root: Path) -> Path:
    return root / "trials" / TRIAL_ID


def _assert_host_credential_absent(root: Path, credential: str) -> None:
    assert credential not in "".join(
        path.read_text(encoding="utf-8", errors="ignore")
        for path in _trial_root(root).rglob("*")
        if path.is_file()
    )


def test_pi_openai_codex_completes_real_docker_lifecycle_with_admitted_oauth(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    admit_capability(
        monkeypatch,
        "pi-openai-codex-oauth",
        protocol="openai-codex-responses",
    )
    credential = _credential()
    _install_scan_environment(monkeypatch)
    monkeypatch.setenv(CREDENTIAL_ENV, credential)
    _install_first_cli_observer(monkeypatch)
    counts = _track_routes(monkeypatch)
    with _Upstream() as upstream:
        result = _run_document(tmp_path, _document(tmp_path, upstream.base_url))

    assert result["trials"][0]["outcome_state"] == "terminal-success"  # type: ignore[index]
    assert result["trials"][0]["verifier_rewards"] == {"reward": 1.0}  # type: ignore[index]
    assert counts == {"arm": 1, "revoke": 1}
    assert [request["model"] for request in upstream.requests] == [MODEL]
    reasoning = upstream.requests[0]["reasoning"]  # type: ignore[index]
    assert reasoning["effort"] == "xhigh"  # type: ignore[index]
    assert "max_output_tokens" not in upstream.requests[0]

    trial_root = _trial_root(tmp_path)
    auth = _read_json(trial_root / "agent/trial-home/pi-agent/auth.json")
    models = _read_json(trial_root / "agent/trial-home/pi-agent/models.json")
    provider = models["providers"]["openai-codex"]  # type: ignore[index]

    assert auth["openai-codex"]["type"] == "oauth"  # type: ignore[index]
    assert auth["openai-codex"]["access"] != credential  # type: ignore[index]
    assert provider["baseUrl"].startswith(  # type: ignore[index]
        f"http://{TRIAL_ID}.proxy.invalid:"
    )
    assert provider["modelOverrides"] == {MODEL: {"maxTokens": 65_536}}  # type: ignore[index]
    assert "models" not in provider
    _assert_host_credential_absent(tmp_path, credential)
