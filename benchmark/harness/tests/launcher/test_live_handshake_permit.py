# input:  offline rows, one-use permits, synthetic response failures
# output: admission, bounds, provider-identifier-safe diagnostics, and evidence proofs
# pos:    Live-handshake bootstrap authorization tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

import base64
import hashlib
import json
import threading
from contextlib import contextmanager
from http.client import IncompleteRead
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Iterator

import pytest

import cortex_bench_harness.launcher.live_handshake as live_handshake
from cortex_bench_harness.launcher.capability_evidence import validate_capability_evidence
from cortex_bench_harness.launcher.credential_capabilities import (
    CAPABILITY_REGISTRY,
    capability_key_for,
)
from cortex_bench_harness.launcher.live_handshake import (
    LiveHandshakePermit,
    LiveHandshakePermitRefused,
    LiveHandshakeRequest,
    issue_live_handshake_permit,
    run_live_handshake,
)
from cortex_bench_harness.launcher.trial_proxy import (
    CapabilityStateRefused,
    arm_trial_proxy,
    parse_trial_proxy_spec,
)
from cortex_bench_harness.scan.models import ArtifactInventory, ScanPolicy
from trial_fixtures import closed_upstream

CAPABILITY_ID = "claude-subscription"
HOST_CREDENTIAL = "sk-ant-oat01-LIVE-HANDSHAKE-HOST-ONLY"
MODEL = "claude-sonnet-5"
BODY_LIMIT = 67_108_864
CODEX_CAPABILITY_ID = "codex-subscription"
CODEX_MODEL = "gpt-5.6-sol"
CODEX_EXPIRY_SECONDS = 2_000_000_000
CODEX_HOST_CREDENTIAL = ".".join((
    base64.b64encode(b'{"alg":"none","typ":"JWT"}').decode().rstrip("="),
    base64.b64encode(json.dumps({
        "https://api.openai.com/auth": {"chatgpt_account_id": "acct-synthetic"},
        "exp": CODEX_EXPIRY_SECONDS,
    }, separators=(",", ":")).encode()).decode().rstrip("="),
    base64.b64encode(b'{"dummy":true}').decode().rstrip("="),
))
PARTIAL_SSE = b"data: " + b"x" * 45 + b"\n\n"
TRUNCATED_SSE_53_BYTES = (
    b'data: {"type":"error","code":"synthetic_refusal_1"}\n\n'
)


def handshake_limits(**overrides: object) -> dict[str, object]:
    return {
        "max_provider_requests": 1,
        "deadline_seconds": 120,
        "max_output_tokens": 256,
        **overrides,
    }


def handshake_spec(**overrides: object):
    return parse_trial_proxy_spec({
        "credential_env": "HOST_ONLY_UNUSED",
        "bound_source_ip": "127.0.0.1",
        "request_body_limit_bytes": BODY_LIMIT,
        "response_body_limit_bytes": BODY_LIMIT,
        **overrides,
    })


def request_body(max_tokens: int = 256) -> bytes:
    return json.dumps({
        "model": MODEL,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": "Reply with ok."}],
    }).encode()


def handshake_request(max_tokens: int = 256) -> LiveHandshakeRequest:
    return LiveHandshakeRequest(
        target="/v1/messages?beta=true",
        headers={
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        body=request_body(max_tokens),
    )


class HandshakeUpstreamHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length)
        self.server.requests.append(body)  # type: ignore[attr-defined]
        self.server.authorization = self.headers.get("authorization")  # type: ignore[attr-defined]
        status = self.server.response_status  # type: ignore[attr-defined]
        payload = self.server.response_body  # type: ignore[attr-defined]
        self.send_response(status)
        for name, value in self.server.response_headers.items():  # type: ignore[attr-defined]
            self.send_header(name, value)
        if self.server.truncate_chunked:  # type: ignore[attr-defined]
            self.send_header("transfer-encoding", "chunked")
            self.end_headers()
            self.wfile.write(f"{len(payload):x}\r\n".encode() + payload + b"\r\n")
            self.wfile.flush()
            self.server.response_bytes_sent += len(payload)  # type: ignore[attr-defined]
            self.close_connection = True
            return
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        self.wfile.flush()
        self.server.response_bytes_sent += len(payload)  # type: ignore[attr-defined]

    def log_message(self, _format: str, *_args: object) -> None:
        return


class TimeoutConnection:
    def __init__(self, *_args, **_kwargs) -> None:
        return

    def request(self, *_args, **_kwargs) -> None:
        return

    def getresponse(self):
        raise TimeoutError("synthetic timeout")

    def close(self) -> None:
        return


@contextmanager
def handshake_upstream(
    status: int = 200, *, body: bytes | None = None,
    headers: dict[str, str] | None = None, truncate_chunked: bool = False,
) -> Iterator[ThreadingHTTPServer]:
    response = {
        "model": MODEL,
        "usage": {"input_tokens": 9, "output_tokens": 2},
        "content": [{"type": "text", "text": "ok"}],
    }
    default_body = json.dumps(response if status == 200 else {"error": "refused"}).encode()
    server = ThreadingHTTPServer(("127.0.0.1", 0), HandshakeUpstreamHandler)
    server.requests = []  # type: ignore[attr-defined]
    server.response_status = status  # type: ignore[attr-defined]
    server.response_body = default_body if body is None else body  # type: ignore[attr-defined]
    server.response_headers = headers or {"content-type": "application/json"}  # type: ignore[attr-defined]
    server.truncate_chunked = truncate_chunked  # type: ignore[attr-defined]
    server.response_bytes_sent = 0  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def scan_policy(
    credential: str = HOST_CREDENTIAL, **overrides: object,
) -> ScanPolicy:
    values = {
        "secrets": {"host_credential": credential},
        "repository_checkout": "REPOSITORY-CHECKOUT-PRIVATE",
        "hostname": "HOSTNAME-PRIVATE",
        **overrides,
    }
    return ScanPolicy(**values)


def codex_request() -> LiveHandshakeRequest:
    document = {
        "model": CODEX_MODEL,
        "instructions": "Reply with exactly ok.",
        "input": [{
            "role": "user",
            "content": [{"type": "input_text", "text": "Reply with exactly ok."}],
        }],
        "tools": [],
        "tool_choice": "none",
        "parallel_tool_calls": False,
        "reasoning": {"effort": "low"},
        "store": False,
        "stream": True,
    }
    import zstandard
    return LiveHandshakeRequest(
        target="/codex/responses",
        headers={
            "accept": "text/event-stream",
            "content-type": "application/json",
            "content-encoding": "zstd",
            "originator": "codex_exec",
            "user-agent": "codex_exec/0.148.0",
        },
        body=zstandard.ZstdCompressor().compress(
            json.dumps(document, separators=(",", ":")).encode()),
    )


def run_codex_handshake(tmp_path: Path, upstream: str) -> Path:
    spec = handshake_spec(access_expires_at_ms=CODEX_EXPIRY_SECONDS * 1000)
    permit = issue_live_handshake_permit(
        capability_id=CODEX_CAPABILITY_ID, model=CODEX_MODEL,
        limits=handshake_limits(max_output_tokens=65_536), upstream_base_url=upstream,
        spec=spec, request=codex_request(),
    )
    return run_live_handshake(
        permit=permit, capability_id=CODEX_CAPABILITY_ID,
        artifact_dir=tmp_path / "artifacts", evidence_dir=tmp_path / "evidence",
        host_credential=CODEX_HOST_CREDENTIAL,
        scan_policy=scan_policy(CODEX_HOST_CREDENTIAL),
        implementation_commit="a" * 40, conservative_cost_usd="0",
    )


def issue_permit(
    *, capability_id: str = CAPABILITY_ID, upstream: str | None = None,
    limits: dict[str, object] | None = None, spec=None,
    request: LiveHandshakeRequest | None = None,
) -> LiveHandshakePermit:
    return issue_live_handshake_permit(
        capability_id=capability_id,
        model=MODEL,
        limits=handshake_limits() if limits is None else limits,
        upstream_base_url=closed_upstream() if upstream is None else upstream,
        spec=handshake_spec() if spec is None else spec,
        request=handshake_request() if request is None else request,
    )


def run_handshake(
    tmp_path: Path, *, permit: LiveHandshakePermit | None = None,
    capability_id: str = CAPABILITY_ID, upstream: str | None = None,
    limits: dict[str, object] | None = None, spec=None,
    request: LiveHandshakeRequest | None = None,
    policy: ScanPolicy | None = None,
) -> Path:
    sealed = permit or issue_permit(
        capability_id=capability_id, upstream=upstream, limits=limits,
        spec=spec, request=request)
    return run_live_handshake(
        permit=sealed, capability_id=capability_id,
        artifact_dir=tmp_path / "artifacts", evidence_dir=tmp_path / "evidence",
        host_credential=HOST_CREDENTIAL, scan_policy=policy or scan_policy(),
        implementation_commit="a" * 40, conservative_cost_usd="0.00000182",
    )


def response_diagnostic(tmp_path: Path) -> dict[str, object]:
    path = tmp_path / "artifacts" / live_handshake.RESPONSE_DIAGNOSTIC_FILENAME
    return json.loads(path.read_bytes())


def diagnostic_body(document: dict[str, object]) -> bytes:
    return base64.b64decode(document["body_base64"])


def capture_scan_inventories(
    monkeypatch: pytest.MonkeyPatch,
) -> list[ArtifactInventory]:
    inventories = []
    original = live_handshake.scan_trial_artifacts

    def capture(inventory, policy):
        inventories.append(inventory)
        return original(inventory, policy)

    monkeypatch.setattr(live_handshake, "scan_trial_artifacts", capture)
    return inventories


def assert_live_evidence(tmp_path: Path, evidence_path: Path) -> None:
    evidence = json.loads(evidence_path.read_bytes())
    row = next(row for row in CAPABILITY_REGISTRY.values() if row.id == CAPABILITY_ID)
    assert evidence_path.name == f"{CAPABILITY_ID}.live-handshake-passed.json"
    assert (evidence["request_count"], evidence["input_tokens"],
            evidence["output_tokens"]) == (1, 9, 2)
    assert evidence["scan_clean"] is True
    assert evidence["revocation_proven"] is True
    assert evidence["adapter_id"] == "anthropic-messages/subscription-oauth"
    assert evidence["capability_key"]["runner_or_backend"] == "claude-code"
    assert evidence["claude_code_version"] == "2.1.232"
    assert row.state == "offline-contract-passed"
    assert HOST_CREDENTIAL not in "".join(
        path.read_text(errors="ignore") for path in tmp_path.rglob("*") if path.is_file())
    validate_capability_evidence(
        evidence_path,
        hashlib.sha256(evidence_path.read_bytes()).hexdigest(),
        capability_id=CAPABILITY_ID,
        key=capability_key_for(CAPABILITY_ID),
        state="live-handshake-passed",
        adapter_id="anthropic-messages/subscription-oauth",
    )


def test_offline_capability_consumes_one_request_and_writes_schema_v2_evidence(
    tmp_path: Path,
) -> None:
    with handshake_upstream() as upstream:
        url = f"http://127.0.0.1:{upstream.server_port}"
        evidence_path = run_handshake(tmp_path, upstream=url)

    assert len(upstream.requests) == 1  # type: ignore[attr-defined]
    assert upstream.authorization == f"Bearer {HOST_CREDENTIAL}"  # type: ignore[attr-defined]
    run_config = json.loads(
        (tmp_path / "artifacts" / "live-handshake-run-config.json").read_bytes())
    assert run_config["absolute_deadline_epoch_ms"] - run_config["armed_at_epoch_ms"] == 120_000
    assert run_config["proxy"]["retry"] is False
    diagnostic = response_diagnostic(tmp_path)
    assert diagnostic["status"] == 200
    assert diagnostic["complete"] is True
    assert diagnostic_body(diagnostic).startswith(b'{"model":')
    assert_live_evidence(tmp_path, evidence_path)


class DriftingLimits(dict):
    def get(self, key, default=None):
        if key == "deadline_seconds":
            return 120
        return super().get(key, default)


def test_issuer_validates_the_snapshot_it_seals() -> None:
    limits = DriftingLimits(handshake_limits(deadline_seconds=999))
    with pytest.raises(LiveHandshakePermitRefused, match="deadline_seconds"):
        issue_permit(limits=limits)


def test_permit_cannot_be_minted_outside_the_validating_issuer() -> None:
    with pytest.raises(TypeError, match="issue_live_handshake_permit"):
        LiveHandshakePermit(CAPABILITY_ID)  # type: ignore[call-arg]


def test_issued_permit_fields_cannot_be_rebound() -> None:
    permit = issue_permit()
    with pytest.raises(AttributeError):
        permit.request = handshake_request(999_999)  # type: ignore[attr-defined]
    with pytest.raises(AttributeError):
        permit.upstream = "http://attacker.invalid"  # type: ignore[attr-defined]


def test_permit_refuses_an_unsupported_row_before_credential_use(tmp_path: Path) -> None:
    with pytest.raises(LiveHandshakePermitRefused, match="unsupported"):
        run_handshake(tmp_path, capability_id="pi-openai-codex-oauth")


def test_permit_refuses_a_capability_it_does_not_name(tmp_path: Path) -> None:
    permit = issue_permit()
    with pytest.raises(LiveHandshakePermitRefused, match="does not name"):
        run_handshake(tmp_path, permit=permit, capability_id="pi-deepseek-api-key")


def test_permit_refuses_second_use_without_a_second_provider_request(tmp_path: Path) -> None:
    with handshake_upstream() as upstream:
        url = f"http://127.0.0.1:{upstream.server_port}"
        permit = issue_permit(upstream=url)
        run_handshake(tmp_path / "first", permit=permit)
        with pytest.raises(LiveHandshakePermitRefused, match="already consumed"):
            run_handshake(tmp_path / "second", permit=permit, upstream=url)
    assert len(upstream.requests) == 1  # type: ignore[attr-defined]


@pytest.mark.parametrize(
    ("limits", "spec", "message"),
    [
        (handshake_limits(max_provider_requests=2), handshake_spec(), "max_provider_requests"),
        (handshake_limits(deadline_seconds=121), handshake_spec(), "deadline_seconds"),
        (handshake_limits(max_output_tokens=257), handshake_spec(), "max_output_tokens"),
        (handshake_limits(), handshake_spec(request_body_limit_bytes=BODY_LIMIT + 1),
         "request_body_limit_bytes"),
        (handshake_limits(), handshake_spec(response_body_limit_bytes=BODY_LIMIT + 1),
         "response_body_limit_bytes"),
    ],
    ids=["request-count", "deadline", "output-tokens", "request-body", "response-body"],
)
def test_permit_refuses_each_bound_excess(
    tmp_path: Path, limits: dict[str, object], spec, message: str,
) -> None:
    with pytest.raises(LiveHandshakePermitRefused, match=message):
        run_handshake(tmp_path, limits=limits, spec=spec)


def test_permit_refuses_a_request_exceeding_the_output_cap(tmp_path: Path) -> None:
    with pytest.raises(LiveHandshakePermitRefused, match="request output cap"):
        run_handshake(tmp_path, request=handshake_request(257))


def test_failed_provider_attempt_is_not_retried_or_promoted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    inventories = capture_scan_inventories(monkeypatch)
    with handshake_upstream(status=500) as upstream:
        url = f"http://127.0.0.1:{upstream.server_port}"
        with pytest.raises(
            LiveHandshakePermitRefused,
            match="proxy ended HTTP 500 response.*usage_accounting_unavailable",
        ):
            run_handshake(tmp_path, upstream=url)
    diagnostic = response_diagnostic(tmp_path)
    assert diagnostic["status"] == 500
    assert b"refused" in diagnostic_body(diagnostic)
    assert "response_diagnostic" in inventories[0].expected_sources
    assert len(upstream.requests) == 1  # type: ignore[attr-defined]
    assert not (tmp_path / "evidence").exists()


def test_codex_53_byte_complete_upstream_refusal_is_attributed_to_proxy_accounting(
    tmp_path: Path,
) -> None:
    assert len(TRUNCATED_SSE_53_BYTES) == 53
    with handshake_upstream(
        body=TRUNCATED_SSE_53_BYTES,
        headers={"content-type": "text/event-stream"},
    ) as upstream:
        url = f"http://127.0.0.1:{upstream.server_port}"
        with pytest.raises(
            LiveHandshakePermitRefused,
            match=(
                "proxy ended HTTP 200 response after 53 bytes: "
                "usage_accounting_unavailable"
            ),
        ) as raised:
            run_codex_handshake(tmp_path, url)

    assert len(upstream.requests) == 1  # type: ignore[attr-defined]
    forwarded = live_handshake._request_document(  # type: ignore[attr-defined]
        upstream.requests[0], "openai-codex-responses")  # type: ignore[attr-defined]
    assert "max_output_tokens" not in forwarded
    assert upstream.response_bytes_sent == 53  # type: ignore[attr-defined]
    assert isinstance(raised.value.__cause__, IncompleteRead)
    assert raised.value.__cause__.partial == TRUNCATED_SSE_53_BYTES
    audit = json.loads(
        (tmp_path / "artifacts" / "proxy" / "proxy-audit.jsonl").read_text())
    assert audit["outcome"] == "usage_accounting_unavailable"
    assert not (tmp_path / "evidence").exists()


def test_codex_completed_sse_is_the_offline_gate_for_a_new_live_permit(
    tmp_path: Path,
) -> None:
    event = {
        "type": "response.completed",
        "response": {
            "model": CODEX_MODEL,
            "usage": {"input_tokens": 3, "output_tokens": 2},
        },
    }
    body = (
        f"event: response.completed\ndata: {json.dumps(event)}\n\n"
        "data: [DONE]\n\n"
    ).encode()
    with handshake_upstream(
        body=body, headers={"content-type": "text/event-stream"},
    ) as upstream:
        path = run_codex_handshake(
            tmp_path, f"http://127.0.0.1:{upstream.server_port}")

    evidence = json.loads(path.read_bytes())
    assert upstream.response_bytes_sent == len(body)  # type: ignore[attr-defined]
    assert evidence["capability_id"] == CODEX_CAPABILITY_ID
    assert evidence["adapter_id"] == "openai-codex-responses/oauth"
    assert (evidence["request_count"], evidence["input_tokens"],
            evidence["output_tokens"]) == (1, 3, 2)


def test_truncated_chunked_response_persists_partial_status_headers_and_body(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    inventories = capture_scan_inventories(monkeypatch)
    with handshake_upstream(
        body=PARTIAL_SSE,
        headers={"content-type": "text/event-stream", "x-upstream": "synthetic"},
        truncate_chunked=True,
    ) as upstream:
        url = f"http://127.0.0.1:{upstream.server_port}"
        with pytest.raises(LiveHandshakePermitRefused, match="proxy ended HTTP 200"):
            run_handshake(tmp_path, upstream=url)

    diagnostic = response_diagnostic(tmp_path)
    assert diagnostic["status"] == 200
    assert diagnostic["complete"] is False
    assert diagnostic["failure"] == "IncompleteRead"
    assert diagnostic["body_bytes_received"] == 53
    assert diagnostic_body(diagnostic) == PARTIAL_SSE
    assert ["x-upstream", "synthetic"] in diagnostic["headers"]
    assert "response_diagnostic" in inventories[0].expected_sources


def test_timeout_persists_an_empty_response_diagnostic(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    inventories = capture_scan_inventories(monkeypatch)
    monkeypatch.setattr(live_handshake, "HTTPConnection", TimeoutConnection)
    with pytest.raises(LiveHandshakePermitRefused):
        run_handshake(tmp_path)

    diagnostic = response_diagnostic(tmp_path)
    assert diagnostic == {
        "body_base64": "",
        "body_bytes_received": 0,
        "body_latin1": "",
        "complete": False,
        "failure": "TimeoutError",
        "headers": [],
        "schema_version": "cortex-bench-live-handshake-response/1",
        "status": None,
    }
    assert "response_diagnostic" in inventories[0].expected_sources


def test_omitting_response_diagnostic_from_inventory_fails_the_scan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = live_handshake._inventory

    def omit_response(*args, **kwargs):
        inventory = original(*args, **kwargs)
        sources = dict(inventory.sources)
        sources.pop("response_diagnostic")
        return ArtifactInventory(
            sources, inventory.expected_sources - {"response_diagnostic"},
            inventory.trial_roots, inventory.container_roots,
        )

    monkeypatch.setattr(live_handshake, "_inventory", omit_response)
    with handshake_upstream() as upstream:
        url = f"http://127.0.0.1:{upstream.server_port}"
        with pytest.raises(LiveHandshakePermitRefused, match="scan was not clean"):
            run_handshake(tmp_path, upstream=url)


def test_response_diagnostic_blanks_provider_identifiers_in_headers_and_error_body(
    tmp_path: Path,
) -> None:
    identifiers = {
        "request": "req_01SYNTHETIC",
        "organization": "org_01SYNTHETIC",
        "workspace": "wrkspc_01SYNTHETIC",
        "trace": "00-synthetic-trace-response",
        "cdn": "synthetic-cdn-ray",
    }
    body = json.dumps({
        "type": "error",
        "error": {"type": "rate_limit_error", "message": "Error"},
        "request_id": identifiers["request"],
    }, separators=(",", ":")).encode()
    path = tmp_path / live_handshake.RESPONSE_DIAGNOSTIC_FILENAME

    live_handshake._write_response_diagnostic(
        path,
        429,
        (
            ("Content-Type", "application/json"),
            ("x-should-retry", "true"),
            ("Retry-After", "90"),
            ("anthropic-ratelimit-requests-reset", "2026-08-20T03:00:00Z"),
            ("anthropic-ratelimit-tokens-reset", "2026-08-20T03:00:00Z"),
            ("request-id", identifiers["request"]),
            ("anthropic-organization-id", identifiers["organization"]),
            ("anthropic-workspace-id", identifiers["workspace"]),
            ("traceresponse", identifiers["trace"]),
            ("CF-RAY", identifiers["cdn"]),
            ("transfer-encoding", "chunked"),
            ("connection", "close"),
        ),
        body,
        "IncompleteRead",
        scan_policy(),
    )

    artifact = path.read_bytes()
    diagnostic = json.loads(artifact)
    headers = {name.lower(): value for name, value in diagnostic["headers"]}
    structured_body = json.loads(diagnostic_body(diagnostic))
    for value in identifiers.values():
        assert value.encode() not in artifact
    assert diagnostic["status"] == 429
    assert diagnostic["body_bytes_received"] == len(body)
    assert diagnostic["complete"] is False
    assert diagnostic["failure"] == "IncompleteRead"
    assert structured_body == {
        "type": "error",
        "error": {"type": "rate_limit_error", "message": "Error"},
        "request_id": "",
    }
    assert headers == {
        "content-type": "application/json",
        "x-should-retry": "true",
        "retry-after": "90",
        "anthropic-ratelimit-requests-reset": "2026-08-20T03:00:00Z",
        "anthropic-ratelimit-tokens-reset": "2026-08-20T03:00:00Z",
        "request-id": "",
        "anthropic-organization-id": "",
        "anthropic-workspace-id": "",
        "traceresponse": "",
        "cf-ray": "",
        "transfer-encoding": "chunked",
        "connection": "close",
    }


def test_response_diagnostic_redacts_secrets_account_and_host_paths(tmp_path: Path) -> None:
    authorization = "Bearer RESPONSE-AUTHORIZATION-PRIVATE"
    account_id = "acct-RESPONSE-PRIVATE"
    host_path = "/home/private-user/provider/auth.json"
    response = {
        "model": MODEL,
        "usage": {"input_tokens": 9, "output_tokens": 2},
        "content": [{"type": "text", "text": "ok"}],
        "diagnostic": [HOST_CREDENTIAL, authorization, account_id, host_path],
    }
    policy = scan_policy(
        secrets={
            "host_credential": HOST_CREDENTIAL,
            "response_authorization": authorization,
        },
        home_path="/home/private-user",
        host_identities={"account_id": account_id},
    )
    with handshake_upstream(
        body=json.dumps(response).encode(),
        headers={
            "content-type": "application/json",
            "authorization": authorization,
            account_id: "synthetic",
        },
    ) as upstream:
        url = f"http://127.0.0.1:{upstream.server_port}"
        run_handshake(tmp_path, upstream=url, policy=policy)

    artifact = (
        tmp_path / "artifacts" / live_handshake.RESPONSE_DIAGNOSTIC_FILENAME
    ).read_bytes()
    for sensitive in (HOST_CREDENTIAL, authorization, account_id, host_path):
        assert sensitive.encode() not in artifact


def test_scan_policy_must_name_the_actual_host_credential(tmp_path: Path) -> None:
    with handshake_upstream() as upstream:
        url = f"http://127.0.0.1:{upstream.server_port}"
        with pytest.raises(LiveHandshakePermitRefused, match="host credential"):
            run_live_handshake(
                permit=issue_permit(upstream=url), capability_id=CAPABILITY_ID,
                artifact_dir=tmp_path / "artifacts",
                evidence_dir=tmp_path / "evidence", host_credential=HOST_CREDENTIAL,
                scan_policy=ScanPolicy({"other": "OTHER-SECRET"}, "REPO", "HOST"),
                implementation_commit="a" * 40, conservative_cost_usd="0.1",
            )
    assert upstream.requests == []  # type: ignore[attr-defined]


def test_artifact_failure_still_revokes_the_credential_route(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = {}
    original = live_handshake._start_session

    def capture(*args, **kwargs):
        captured["session"] = original(*args, **kwargs)
        return captured["session"]

    monkeypatch.setattr(live_handshake, "_start_session", capture)
    monkeypatch.setattr(
        live_handshake, "_write_run_artifacts",
        lambda *_args: (_ for _ in ()).throw(OSError("artifact failure")),
    )
    with pytest.raises(OSError, match="artifact failure"):
        run_handshake(tmp_path)
    evidence = captured["session"].proxy.handle.revocation_evidence
    assert evidence["route_active"] is False
    assert evidence["listener_present"] is False


def test_inventory_failure_still_revokes_the_credential_route(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = {}
    original = live_handshake._start_session

    def capture(*args, **kwargs):
        captured["session"] = original(*args, **kwargs)
        return captured["session"]

    monkeypatch.setattr(live_handshake, "_start_session", capture)
    monkeypatch.setattr(
        live_handshake, "_inventory",
        lambda *_args: (_ for _ in ()).throw(OSError("inventory failure")),
    )
    with pytest.raises(OSError, match="inventory failure"):
        run_handshake(tmp_path)
    evidence = captured["session"].proxy.handle.revocation_evidence
    assert evidence["route_active"] is False
    assert evidence["listener_present"] is False


def paid_task_arm() -> dict[str, object]:
    return {
        "kind": "vendor-baseline",
        "vendor_agent": "claude-code",
        "provider": "anthropic",
        "model": MODEL,
        "credential_capability": CAPABILITY_ID,
        "limits": handshake_limits(),
    }


def test_paid_task_or_campaign_route_still_refuses_the_offline_row(tmp_path: Path) -> None:
    artifacts = tmp_path / "task-artifacts"
    artifacts.mkdir()
    with pytest.raises(CapabilityStateRefused, match="live-handshake-passed"):
        arm_trial_proxy(
            arm=paid_task_arm(),
            trial_id="benchmark-task-route",
            upstream_base_url=closed_upstream(),
            spec=handshake_spec(),
            proxy_dir=artifacts / "proxy",
            trial_roots=(artifacts,),
            environ={},
            paid_run=True,
        )
