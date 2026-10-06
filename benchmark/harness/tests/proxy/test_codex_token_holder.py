#
# A token host that rotates refresh tokens accepts each one once. A campaign's trials all run on
# the same host login, so if each trial refreshed from the host's ORIGINAL refresh token, the
# first refresh would spend it and every later trial's refresh would be refused -- each such trial
# then fails at its first expiry with nothing measured. One host-side holder, shared by the
# trials, keeps the rotated token; these tests pin that against a fake host that rotates.

import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

import pytest

from cortex_bench_harness.launcher.host_credential_vault import HostTokenHolders
from cortex_bench_harness.proxy.adapters import AuthInjectionUnavailable
from cortex_bench_harness.proxy.adapters import openai_codex_responses as codex
from cortex_bench_harness.proxy.adapters.openai_codex_responses import (
    RESPONSES_ROUTE,
    TOKEN_PATH,
    CodexTokenHolder,
    OpenAICodexResponsesOAuthAdapter,
)
from test_openai_codex_adapter import CODEX_MODEL, HOST_ACCESS_TOKEN, codex_token

CLIENT_ID = "app_synthetic_client"
MODEL_URL = "http://127.0.0.1:9"
NOW_MS = 1_900_000_000_000
LIFETIME_SECONDS = 60


class RotatingTokenHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        host: "RotatingTokenHost" = self.server  # type: ignore[assignment]
        length = int(self.headers.get("content-length", "0"))
        presented = parse_qs(self.rfile.read(length).decode())["refresh_token"][0]
        status, document = host.exchange(presented)
        payload = (
            b"{}" if document is None else
            ('{"access_token":"%s","refresh_token":"%s","expires_in":%d}' % (
                document["access_token"], document["refresh_token"], LIFETIME_SECONDS,
            )).encode())
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, _format: str, *_args: object) -> None:
        return


class RotatingTokenHost(ThreadingHTTPServer):
    """Accepts only the newest refresh token, once, and answers it with a rotated pair."""

    daemon_threads = True

    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), RotatingTokenHandler)
        self.generation = 0
        self.presented: list[str] = []
        self._lock = threading.Lock()

    @property
    def url(self) -> str:
        host, port = self.server_address[:2]
        return f"http://{host}:{port}{TOKEN_PATH}"

    def exchange(self, presented: str) -> tuple[int, dict[str, str] | None]:
        with self._lock:
            self.presented.append(presented)
            if presented != f"rt-{self.generation}":
                return 400, None
            self.generation += 1
            return 200, {
                "access_token": codex_token(f"acct-{self.generation}", nonce=str(self.generation)),
                "refresh_token": f"rt-{self.generation}",
            }


@pytest.fixture
def token_host() -> Iterator[RotatingTokenHost]:
    host = RotatingTokenHost()
    thread = threading.Thread(target=host.serve_forever, daemon=True)
    thread.start()
    try:
        yield host
    finally:
        host.shutdown()
        host.server_close()
        thread.join(timeout=2)


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    now = [NOW_MS]
    monkeypatch.setattr(codex, "_now_ms", lambda: now[0])
    return now


def expired_holder(token_host: RotatingTokenHost) -> CodexTokenHolder:
    return CodexTokenHolder(
        HOST_ACCESS_TOKEN, access_expires_at_ms=0, refresh_token="rt-0",
        client_id=CLIENT_ID, token_endpoint_url=token_host.url,
    )


def trial_adapter(**bindings: object) -> OpenAICodexResponsesOAuthAdapter:
    return OpenAICodexResponsesOAuthAdapter(MODEL_URL, HOST_ACCESS_TOKEN, CODEX_MODEL, **bindings)


def account(adapter: OpenAICodexResponsesOAuthAdapter) -> str:
    return adapter.inject_auth({}, RESPONSES_ROUTE)["chatgpt-account-id"]


def test_trials_sharing_a_holder_present_the_refresh_token_the_last_refresh_rotated(
    token_host: RotatingTokenHost, clock: list[int],
) -> None:
    holder = expired_holder(token_host)
    first, second = trial_adapter(token_holder=holder), trial_adapter(token_holder=holder)

    assert account(first) == "acct-1"
    clock[0] += (LIFETIME_SECONDS + 1) * 1000
    assert account(second) == "acct-2"
    assert token_host.presented == ["rt-0", "rt-1"]

    first.clear_credential()
    assert account(second) == "acct-2", "one trial ending does not take the login from the rest"


def test_trials_that_each_refresh_from_the_original_token_fail_after_the_first(
    token_host: RotatingTokenHost, clock: list[int],
) -> None:
    """The failure the shared holder removes: the second trial presents a spent token."""
    def own_refresh() -> OpenAICodexResponsesOAuthAdapter:
        return trial_adapter(
            access_expires_at_ms=0, refresh_token="rt-0", client_id=CLIENT_ID,
            token_endpoint_url=token_host.url)

    assert account(own_refresh()) == "acct-1"
    with pytest.raises(AuthInjectionUnavailable, match="answered 400"):
        account(own_refresh())


def test_concurrent_callers_on_an_expired_token_refresh_once(
    token_host: RotatingTokenHost, clock: list[int],
) -> None:
    holder = expired_holder(token_host)
    adapters = [trial_adapter(token_holder=holder) for _ in range(6)]
    accounts: list[str] = []
    start = threading.Barrier(len(adapters))

    def call(adapter: OpenAICodexResponsesOAuthAdapter) -> None:
        start.wait()
        accounts.append(account(adapter))

    threads = [threading.Thread(target=call, args=(adapter,)) for adapter in adapters]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)

    assert accounts == ["acct-1"] * len(adapters)
    assert token_host.presented == ["rt-0"]


def test_releasing_the_campaign_handle_clears_the_rotated_tokens(
    token_host: RotatingTokenHost, clock: list[int],
) -> None:
    holders = HostTokenHolders()
    holder = expired_holder(token_host)
    handle = holders.register(holder)
    adapter = trial_adapter(token_holder=holders.get(handle))
    assert account(adapter) == "acct-1"

    holders.release(handle)

    with pytest.raises(LookupError):
        holders.get(handle)
    with pytest.raises(AuthInjectionUnavailable, match="no codex access token is held"):
        account(adapter)


def test_a_shared_holder_refuses_refresh_material_of_its_own() -> None:
    holder = CodexTokenHolder(HOST_ACCESS_TOKEN, access_expires_at_ms=None)

    with pytest.raises(ValueError, match="carries its own refresh material"):
        trial_adapter(token_holder=holder, refresh_token="rt-other")
