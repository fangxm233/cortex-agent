# input:  an expired codex credential, a synthetic token host, and a model host
# output: refresh-shape proofs and CP1, CP2, CP3 containment proofs
# pos:    OpenAI Codex second-upstream containment tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
import select
import socket
import threading
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from http.client import HTTPConnection, HTTPResponse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

from cortex_bench_harness.proxy import ProxyBudget, start_trial_proxy
from cortex_bench_harness.proxy.adapters.openai_codex_responses import (
    ACCOUNT_ID_HEADER,
    RESPONSES_PATH,
    TOKEN_PATH,
    OpenAICodexResponsesOAuthAdapter,
)
from synthetic import SyntheticUpstream
from test_openai_codex_adapter import (
    CODEX_MODEL,
    HOST_ACCESS_TOKEN,
    codex_request,
    codex_token,
    serve_stream,
    sse_stream,
    terminal_event,
)

MODEL_HOST = "127.0.0.1"
TOKEN_HOST = "127.0.0.3"
LEARNED_HOST = "127.0.0.4"
REFRESH_TOKEN = "rt-synthetic-longer-lived-secret"
CLIENT_ID = "app_synthetic_client"
REFRESHED_ACCOUNT_ID = "acct-synthetic-refreshed-9"
REFRESHED_ACCESS_TOKEN = codex_token(REFRESHED_ACCOUNT_ID, nonce="refreshed")
FAR_FUTURE_MS = 4102444800000


class TokenHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        endpoint: "TokenServer" = self.server  # type: ignore[assignment]
        length = int(self.headers.get("content-length", "0"))
        endpoint.requests.append({
            "path": self.path,
            "headers": dict(self.headers.items()),
            "body": self.rfile.read(length).decode(),
        })
        payload = json.dumps(endpoint.document).encode()
        self.send_response(endpoint.status)
        self.send_header("content-type", "application/json")
        for key, value in endpoint.extra_headers.items():
            self.send_header(key, value)
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, _format: str, *_args: object) -> None:
        return


class TokenServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self) -> None:
        super().__init__((TOKEN_HOST, 0), TokenHandler)
        self.requests: list[dict[str, object]] = []
        self.status = 200
        self.extra_headers: dict[str, str] = {}
        self.document: dict[str, object] = {
            "access_token": REFRESHED_ACCESS_TOKEN,
            "refresh_token": "rt-synthetic-rotated",
            "expires_in": 3600,
        }


class SyntheticTokenEndpoint:
    def __init__(self) -> None:
        self.server = TokenServer()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        host, port = self.server.server_address
        return f"http://{host}:{port}{TOKEN_PATH}"

    @property
    def requests(self) -> list[dict[str, object]]:
        return self.server.requests

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def __enter__(self) -> "SyntheticTokenEndpoint":
        return self

    def __exit__(self, *_args: object) -> None:
        self.stop()


class Listener:
    # A bare socket that accepts nothing: any connection attempt to it is
    # observable, which is what makes "never reached" assertable.
    def __init__(self, host: str) -> None:
        self.socket = socket.socket()
        self.socket.bind((host, 0))
        self.socket.listen(1)

    @property
    def authority(self) -> str:
        host, port = self.socket.getsockname()
        return f"{host}:{port}"

    @property
    def attempts(self) -> int:
        ready, _, _ = select.select([self.socket], [], [], 0)
        return len(ready)

    def __enter__(self) -> "Listener":
        return self

    def __exit__(self, *_args: object) -> None:
        self.socket.close()


def refreshing_adapter(
    model_base_url: str, token_endpoint_url: str | None, *,
    access_expires_at_ms: int = 0, credential: str = HOST_ACCESS_TOKEN,
) -> OpenAICodexResponsesOAuthAdapter:
    return OpenAICodexResponsesOAuthAdapter(
        model_base_url, credential, CODEX_MODEL,
        token_endpoint_url=token_endpoint_url,
        refresh_token=REFRESH_TOKEN,
        client_id=CLIENT_ID,
        access_expires_at_ms=access_expires_at_ms,
    )


def start_proxy(tmp_path: Path, upstream: SyntheticUpstream, adapter):
    return start_trial_proxy(
        trial_id="trial-codex-refresh", upstream_base_url=upstream.base_url,
        adapter=adapter, bound_source_ip=MODEL_HOST,
        absolute_deadline=datetime.now(UTC) + timedelta(minutes=5),
        budget=ProxyBudget(
            Decimal("20"), Decimal("5"), Decimal("1000000"), Decimal("1000000")),
        log_path=tmp_path / "codex-refresh.jsonl",
    )


# --- R4-P9: the refresh request shape, against a synthetic token host ---


def test_an_expired_token_is_refreshed_with_a_form_urlencoded_grant(
    tmp_path: Path,
) -> None:
    with SyntheticUpstream() as upstream, SyntheticTokenEndpoint() as endpoint:
        serve_stream(upstream, sse_stream([terminal_event()]))
        handle = start_proxy(
            tmp_path, upstream, refreshing_adapter(upstream.base_url, endpoint.url))
        try:
            status, _ = codex_request(handle)
        finally:
            handle.stop()
    assert status == 200
    assert len(endpoint.requests) == 1
    exchange = endpoint.requests[0]
    assert exchange["path"] == TOKEN_PATH
    assert exchange["headers"]["content-type"] == "application/x-www-form-urlencoded"
    assert parse_qs(exchange["body"]) == {
        "grant_type": ["refresh_token"],
        "refresh_token": [REFRESH_TOKEN],
        "client_id": [CLIENT_ID],
    }
    assert upstream.requests[0].headers["authorization"] == f"Bearer {REFRESHED_ACCESS_TOKEN}"
    assert upstream.requests[0].headers[ACCOUNT_ID_HEADER] == REFRESHED_ACCOUNT_ID


def test_a_valid_token_is_never_exchanged(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream, SyntheticTokenEndpoint() as endpoint:
        serve_stream(upstream, sse_stream([terminal_event()]))
        handle = start_proxy(
            tmp_path, upstream,
            refreshing_adapter(
                upstream.base_url, endpoint.url, access_expires_at_ms=FAR_FUTURE_MS))
        try:
            status, _ = codex_request(handle)
        finally:
            handle.stop()
    assert status == 200
    assert endpoint.requests == []
    assert upstream.requests[0].headers["authorization"] == f"Bearer {HOST_ACCESS_TOKEN}"


def test_one_refresh_serves_the_calls_that_follow_it(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream, SyntheticTokenEndpoint() as endpoint:
        serve_stream(upstream, sse_stream([terminal_event()]))
        handle = start_proxy(
            tmp_path, upstream, refreshing_adapter(upstream.base_url, endpoint.url))
        try:
            first, _ = codex_request(handle)
            second, _ = codex_request(handle)
        finally:
            handle.stop()
    assert (first, second) == (200, 200)
    assert len(endpoint.requests) == 1
    assert len(upstream.requests) == 2


@pytest.mark.parametrize(
    "document",
    [
        {"refresh_token": "rt-next", "expires_in": 3600},
        {"access_token": REFRESHED_ACCESS_TOKEN, "expires_in": 3600},
        {"access_token": REFRESHED_ACCESS_TOKEN, "refresh_token": "rt-next"},
        {"access_token": REFRESHED_ACCESS_TOKEN, "refresh_token": "rt-next",
         "expires_in": "3600"},
    ],
)
def test_an_incomplete_token_document_refuses_the_model_call(
    tmp_path: Path, document: dict[str, object],
) -> None:
    with SyntheticUpstream() as upstream, SyntheticTokenEndpoint() as endpoint:
        endpoint.server.document = document
        handle = start_proxy(
            tmp_path, upstream, refreshing_adapter(upstream.base_url, endpoint.url))
        try:
            status, payload = codex_request(handle)
        finally:
            handle.stop()
    assert status == 502
    assert json.loads(payload) == {"error": "auth_injection_unavailable"}
    assert upstream.requests == []


def test_a_refreshed_token_without_the_account_claim_refuses_the_model_call(
    tmp_path: Path,
) -> None:
    with SyntheticUpstream() as upstream, SyntheticTokenEndpoint() as endpoint:
        endpoint.server.document = {
            "access_token": codex_token(None, nonce="claimless"),
            "refresh_token": "rt-next", "expires_in": 3600,
        }
        handle = start_proxy(
            tmp_path, upstream, refreshing_adapter(upstream.base_url, endpoint.url))
        try:
            status, payload = codex_request(handle)
        finally:
            handle.stop()
    assert status == 502
    assert json.loads(payload) == {"error": "auth_injection_unavailable"}
    assert upstream.requests == []


def test_a_non_2xx_token_response_refuses_the_model_call(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream, SyntheticTokenEndpoint() as endpoint:
        endpoint.server.status = 400
        endpoint.server.document = {"error": "invalid_grant"}
        handle = start_proxy(
            tmp_path, upstream, refreshing_adapter(upstream.base_url, endpoint.url))
        try:
            status, payload = codex_request(handle)
        finally:
            handle.stop()
    assert status == 502
    assert json.loads(payload) == {"error": "auth_injection_unavailable"}
    assert upstream.requests == []


def test_an_expired_token_with_no_bound_token_host_refuses_rather_than_sending_it(
    tmp_path: Path,
) -> None:
    with SyntheticUpstream() as upstream:
        handle = start_proxy(
            tmp_path, upstream, refreshing_adapter(upstream.base_url, None))
        try:
            status, payload = codex_request(handle)
        finally:
            handle.stop()
    assert status == 502
    assert json.loads(payload) == {"error": "auth_injection_unavailable"}
    assert upstream.requests == []


# --- CP1: host-set closure ---


def test_cp1_the_host_set_is_declared_from_frozen_inputs_alone() -> None:
    with SyntheticTokenEndpoint() as endpoint:
        adapter = refreshing_adapter("http://127.0.0.1:9000", endpoint.url)
        twin = refreshing_adapter("http://127.0.0.1:9001", endpoint.url)
    assert adapter.upstream_hosts == (MODEL_HOST, TOKEN_HOST)
    assert adapter.upstream_hosts == twin.upstream_hosts


def test_cp1_a_single_host_adapter_declares_only_the_model_host() -> None:
    adapter = refreshing_adapter("http://127.0.0.1:9000", None)
    assert adapter.upstream_hosts == (MODEL_HOST,)


def test_cp1_the_host_set_survives_a_container_request_and_both_upstreams(
    tmp_path: Path,
) -> None:
    with SyntheticUpstream() as upstream, SyntheticTokenEndpoint() as endpoint, \
            Listener(LEARNED_HOST) as learned:
        serve_stream(upstream, sse_stream([terminal_event()]))
        endpoint.server.document = {
            **endpoint.server.document,
            "discovery": {"api_host": learned.authority},
        }
        adapter = refreshing_adapter(upstream.base_url, endpoint.url)
        declared = adapter.upstream_hosts
        handle = start_proxy(tmp_path, upstream, adapter)
        try:
            status, _ = codex_request(
                handle, extra_headers={"x-forwarded-host": learned.authority})
            after = adapter.upstream_hosts
            attempts = learned.attempts
        finally:
            handle.stop()
    assert status == 200
    assert after == declared == (MODEL_HOST, TOKEN_HOST)
    assert attempts == 0


def test_cp1_a_redirect_from_the_token_host_is_never_followed(
    tmp_path: Path,
) -> None:
    with SyntheticUpstream() as upstream, SyntheticTokenEndpoint() as endpoint, \
            Listener(LEARNED_HOST) as learned:
        endpoint.server.status = 302
        endpoint.server.extra_headers = {
            "location": f"http://{learned.authority}{TOKEN_PATH}"}
        handle = start_proxy(
            tmp_path, upstream, refreshing_adapter(upstream.base_url, endpoint.url))
        try:
            status, payload = codex_request(handle)
            attempts = learned.attempts
        finally:
            handle.stop()
    assert status == 502
    assert json.loads(payload) == {"error": "auth_injection_unavailable"}
    assert attempts == 0
    assert upstream.requests == []


def test_cp1_a_redirect_from_the_model_host_is_relayed_and_never_followed(
    tmp_path: Path,
) -> None:
    with SyntheticUpstream() as upstream, SyntheticTokenEndpoint() as endpoint, \
            Listener(LEARNED_HOST) as learned:
        redirect_url = f"http://{learned.authority}{RESPONSES_PATH}"
        serve_stream(upstream, sse_stream([terminal_event()]))
        upstream.server.status = 302
        upstream.server.extra_headers = {"location": redirect_url}
        handle = start_proxy(
            tmp_path, upstream,
            refreshing_adapter(
                upstream.base_url, endpoint.url, access_expires_at_ms=FAR_FUTURE_MS))
        try:
            response = _raw_response(handle)
            status = response.status
            location = response.getheader("location")
            response.read()
            attempts = learned.attempts
        finally:
            handle.stop()
    assert (status, location) == (302, redirect_url)
    assert attempts == 0
    assert len(upstream.requests) == 1


# --- CP2: credential partition ---


def test_cp2_the_two_credentials_never_cross_hosts(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream, SyntheticTokenEndpoint() as endpoint:
        serve_stream(upstream, sse_stream([terminal_event()]))
        handle = start_proxy(
            tmp_path, upstream, refreshing_adapter(upstream.base_url, endpoint.url))
        try:
            status, _ = codex_request(handle)
        finally:
            handle.stop()
    assert status == 200
    exchange = endpoint.requests[0]
    token_text = json.dumps(exchange)
    assert HOST_ACCESS_TOKEN not in token_text
    assert REFRESHED_ACCESS_TOKEN not in token_text
    assert "authorization" not in {key.lower() for key in exchange["headers"]}
    assert REFRESH_TOKEN in str(exchange["body"])
    model_text = json.dumps(upstream.requests[0].headers) + upstream.requests[0].body.decode()
    assert REFRESH_TOKEN not in model_text
    assert CLIENT_ID not in model_text
    assert upstream.requests[0].headers["authorization"] == f"Bearer {REFRESHED_ACCESS_TOKEN}"


# --- CP3: container initiation ---


@pytest.mark.parametrize(
    "target", [TOKEN_PATH, f"{TOKEN_PATH}?grant_type=refresh_token", "/oauth/authorize"],
)
def test_cp3_a_container_request_naming_the_token_route_is_refused(
    tmp_path: Path, target: str,
) -> None:
    with SyntheticUpstream() as upstream, SyntheticTokenEndpoint() as endpoint:
        handle = start_proxy(
            tmp_path, upstream,
            refreshing_adapter(
                upstream.base_url, endpoint.url, access_expires_at_ms=FAR_FUTURE_MS))
        try:
            status, payload = codex_request(handle, target=target)
        finally:
            handle.stop()
    assert status == 403
    assert json.loads(payload) == {"error": "route_not_allowed"}
    assert endpoint.requests == []
    assert upstream.requests == []


def test_cp3_every_allowed_route_resolves_to_the_first_declared_host(
    tmp_path: Path,
) -> None:
    with SyntheticUpstream() as upstream, SyntheticTokenEndpoint() as endpoint:
        serve_stream(upstream, sse_stream([terminal_event()]))
        adapter = refreshing_adapter(
            upstream.base_url, endpoint.url, access_expires_at_ms=FAR_FUTURE_MS)
        handle = start_proxy(tmp_path, upstream, adapter)
        try:
            allowed = [
                path for path in
                (RESPONSES_PATH, TOKEN_PATH, "/codex", "/v1/messages", "/oauth/authorize")
                if adapter.validate_route("POST", path).allow
            ]
            status, _ = codex_request(handle)
        finally:
            handle.stop()
    assert allowed == [RESPONSES_PATH]
    assert status == 200
    assert urlsplit(upstream.base_url).hostname == adapter.upstream_hosts[0]
    assert endpoint.requests == []


def _raw_response(handle) -> HTTPResponse:
    listen = urlsplit(handle.base_url)
    connection = HTTPConnection(listen.hostname, listen.port, timeout=3)
    connection.request(
        "POST", RESPONSES_PATH,
        body=json.dumps({"model": CODEX_MODEL, "stream": True}).encode(),
        headers={"authorization": f"Bearer {handle.dummy_token}",
                 "content-type": "application/json"},
    )
    return connection.getresponse()
