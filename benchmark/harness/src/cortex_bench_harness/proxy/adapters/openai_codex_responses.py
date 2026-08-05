# input:  codex request targets, request bodies, and streamed upstream payloads
# output: row-4 route, body, auth, usage, and billable decisions
# pos:    OpenAI Codex responses adapter for an OAuth credential
# >>> If I am updated, update my header and folder CORTEX.md <<<

import base64
import binascii
import json
import secrets
import threading
import time
from http.client import HTTPConnection, HTTPException, HTTPSConnection
from typing import Iterator, Mapping
from urllib.parse import SplitResult, urlencode, urlsplit

import zstandard

from ..models import PROXY_SCHEMA_VERSION, ProxyUsage
from .base import AuthInjectionUnavailable, Billable, BodyDecision, RouteDecision

ADAPTER_ID = "openai-codex-responses/oauth"
RESPONSES_ROUTE = "codex_responses"
RESPONSES_PATH = "/codex/responses"
TOKEN_PATH = "/oauth/token"
ACCOUNT_ID_HEADER = "chatgpt-account-id"
JWT_ACCOUNT_CLAIM = "https://api.openai.com/auth"
ACCOUNT_ID_FIELD = "chatgpt_account_id"
# The client normalizes its terminal event to response.completed internally, so
# reading its downstream code alone would name the wrong event on the wire.
TERMINAL_WIRE_EVENT = "response.done"
TERMINAL_EVENTS = frozenset({
    TERMINAL_WIRE_EVENT, "response.completed", "response.incomplete",
})
FAILURE_EVENTS = frozenset({"error", "response.failed"})
ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"
MAX_DECOMPRESSED_BODY_BYTES = 32 * 1024 * 1024
REFRESH_TIMEOUT_SECONDS = 10.0


def extract_account_id(token: str) -> str:
    # The account id is decoded from the access token's own payload and is never
    # fetched, so a credential that cannot yield it fails before any request is
    # built. A dummy that is merely an opaque string therefore produces no
    # traffic at all, which is indistinguishable from perfect containment.
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("codex access token must be a three-part JWT")
    claim = _jwt_payload(parts[1]).get(JWT_ACCOUNT_CLAIM)
    account_id = claim.get(ACCOUNT_ID_FIELD) if isinstance(claim, dict) else None
    if not isinstance(account_id, str) or not account_id:
        raise ValueError("codex access token carries no account id claim")
    return account_id


def mint_dummy_codex_token() -> str:
    # The container's dummy must satisfy the same local decode as a real token,
    # or the client never emits the request the proxy exists to bound.
    account_id = f"dummy-account-{secrets.token_hex(8)}"
    return ".".join((
        _jwt_segment({"alg": "none", "typ": "JWT"}),
        _jwt_segment({
            JWT_ACCOUNT_CLAIM: {ACCOUNT_ID_FIELD: account_id},
            "nonce": secrets.token_hex(16),
        }),
        _jwt_segment({"dummy": True}),
    ))


class OpenAICodexResponsesOAuthAdapter:
    adapter_id = ADAPTER_ID
    schema_version = PROXY_SCHEMA_VERSION

    def __init__(
        self, upstream_base_url: str | None = None, credential: str | None = None,
        frozen_model: str | None = None, *, token_endpoint_url: str | None = None,
        refresh_token: str | None = None, client_id: str | None = None,
        access_expires_at_ms: int | None = None,
        refresh_timeout_seconds: float = REFRESH_TIMEOUT_SECONDS,
    ) -> None:
        self._token_target = _token_target(token_endpoint_url)
        self.upstream_hosts = _upstream_hosts(upstream_base_url, self._token_target)
        self._access_token = _validated_credential(credential)
        self._account_id = (
            extract_account_id(self._access_token) if self._access_token else None
        )
        self._frozen_model = frozen_model
        self._refresh_token = refresh_token
        self._client_id = client_id
        self._expires_at_ms = access_expires_at_ms
        self._refresh_timeout_seconds = refresh_timeout_seconds
        self._lock = threading.Lock()

    def mint_dummy_credential(self) -> str:
        return mint_dummy_codex_token()

    def validate_route(self, method: str, path: str) -> RouteDecision:
        target = urlsplit(path)
        if target.path == TOKEN_PATH:
            return _refused_route("route_denied_token_endpoint")
        if target.path != RESPONSES_PATH:
            return _refused_route("route_not_allowed")
        if method != "POST":
            return _refused_route("route_denied_responses_method")
        if target.query:
            return _refused_route("route_denied_responses_query")
        return RouteDecision(True, RESPONSES_ROUTE, None)

    def validate_body(self, route_id: str, body: bytes) -> BodyDecision:
        if route_id != RESPONSES_ROUTE:
            return BodyDecision(False, None, "request_route_unknown")
        payload = _decompressed(body)
        if payload is None:
            return BodyDecision(False, None, "request_body_zstd_undecodable")
        document = _json_object(payload)
        if document is None:
            return BodyDecision(False, None, "request_body_unparsable")
        model = document.get("model")
        if not isinstance(model, str) or not model.strip():
            return BodyDecision(False, None, "request_model_absent")
        if self._frozen_model is None:
            return BodyDecision(False, model, "request_model_unfrozen")
        if model != self._frozen_model:
            return BodyDecision(False, model, "request_model_mismatch")
        return BodyDecision(True, model, None)

    def inject_auth(self, headers: Mapping[str, str], route_id: str) -> dict[str, str]:
        if route_id != RESPONSES_ROUTE:
            raise AuthInjectionUnavailable("route carries no auth form")
        token, account_id = self._current_credential()
        denied = {"authorization", ACCOUNT_ID_HEADER}
        outbound = {
            key: value for key, value in headers.items() if key.lower() not in denied
        }
        outbound["authorization"] = f"Bearer {token}"
        outbound[ACCOUNT_ID_HEADER] = account_id
        return outbound

    def extract_usage(self, body: bytes, content_type: str) -> ProxyUsage:
        # This row has no non-streaming shape: the request body sets stream true
        # unconditionally, so a non-SSE payload carries no usage to read.
        if "text/event-stream" not in content_type:
            return ProxyUsage(None, 0, 0, False)
        model: str | None = None
        input_tokens = 0
        output_tokens = 0
        terminal = False
        malformed = False
        for payload in _sse_payloads(body):
            document = _json_object(payload)
            if document is None:
                malformed = True
                continue
            event = document.get("type")
            if event in FAILURE_EVENTS:
                # A failed, cancelled or deadline-killed stream carries no usage
                # anywhere on the wire, so it is unmetered rather than zero.
                return ProxyUsage(model, 0, 0, False)
            if event not in TERMINAL_EVENTS:
                continue
            response = document.get("response")
            usage = response.get("usage") if isinstance(response, dict) else None
            if not isinstance(usage, dict):
                continue
            counted = _token_counts(usage)
            if counted is None:
                malformed = True
                continue
            terminal = True
            input_tokens, output_tokens = counted
            model = _model_of(response)
        if not terminal or malformed:
            return ProxyUsage(model, 0, 0, False)
        return ProxyUsage(model, input_tokens, output_tokens, True)

    def billable(self, usage: ProxyUsage) -> Billable:
        if not usage.accounted:
            raise ValueError("billable is never called on an unaccounted usage")
        # The wire's input_tokens already contains the cached and cache-write
        # counts and the response carries no cost field, so the whole input count
        # is billed at the input rate rather than discounted to the client's own
        # cache-aware split.
        return Billable(usage.input_tokens, usage.output_tokens)

    def _current_credential(self) -> tuple[str, str]:
        with self._lock:
            if self._access_token is None or self._account_id is None:
                raise AuthInjectionUnavailable(
                    "no codex access token is bound to this adapter")
            if self._expires_at_ms is None or _now_ms() < self._expires_at_ms:
                return self._access_token, self._account_id
            self._refresh()
            return self._access_token, self._account_id

    def _refresh(self) -> None:
        if self._token_target is None or not self._refresh_token or not self._client_id:
            raise AuthInjectionUnavailable(
                "the bound codex access token is expired and no token host is bound")
        document = self._token_exchange(self._token_target)
        access = document.get("access_token")
        refresh = document.get("refresh_token")
        expires_in = document.get("expires_in")
        if not _non_empty_text(access) or not _non_empty_text(refresh) \
                or type(expires_in) is not int:
            raise AuthInjectionUnavailable("codex token response is missing fields")
        try:
            account_id = extract_account_id(access)
        except ValueError as error:
            raise AuthInjectionUnavailable(
                "refreshed codex token carries no account id claim") from error
        self._access_token = access
        self._account_id = account_id
        self._refresh_token = refresh
        self._expires_at_ms = _now_ms() + expires_in * 1000

    def _token_exchange(self, target: SplitResult) -> dict[str, object]:
        # The token host is addressed by the adapter itself rather than through
        # the fixed model upstream, and it never receives the messages
        # credential: the two hosts are bound to two different secrets.
        body = urlencode({
            "grant_type": "refresh_token",
            "refresh_token": self._refresh_token,
            "client_id": self._client_id,
        }).encode()
        connection = _token_connection(target, self._refresh_timeout_seconds)
        try:
            connection.request("POST", target.path, body, {
                "content-type": "application/x-www-form-urlencoded",
                "content-length": str(len(body)),
                "accept": "application/json",
            })
            response = connection.getresponse()
            status = response.status
            payload = response.read()
        except (HTTPException, OSError) as error:
            raise AuthInjectionUnavailable("codex token host is unreachable") from error
        finally:
            connection.close()
        # A 3xx is a refusal, never a redirect to follow: following one is how a
        # host outside the frozen set would be reached.
        if status != 200:
            raise AuthInjectionUnavailable(f"codex token host answered {status}")
        document = _json_object(payload)
        if document is None:
            raise AuthInjectionUnavailable("codex token response is not a JSON object")
        return document


def _token_target(token_endpoint_url: str | None) -> SplitResult | None:
    if token_endpoint_url is None:
        return None
    target = urlsplit(token_endpoint_url)
    if target.scheme not in {"http", "https"} or not target.hostname or not target.path:
        raise ValueError("token_endpoint_url must be an http or https URL with a path")
    if target.username or target.password or target.query or target.fragment:
        raise ValueError(
            "token_endpoint_url must not contain credentials, query, or fragment")
    return target


def _token_connection(target: SplitResult, timeout_seconds: float) -> HTTPConnection:
    host = target.hostname or ""
    timeout = max(timeout_seconds, 0.001)
    if target.scheme == "https":
        return HTTPSConnection(host, target.port, timeout=timeout)
    return HTTPConnection(host, target.port, timeout=timeout)


def _upstream_hosts(
    upstream_base_url: str | None, token_target: SplitResult | None,
) -> tuple[str, ...]:
    # Frozen from host-side inputs at construction. Nothing in a container
    # request or an upstream response can add a member.
    hosts: list[str] = []
    if upstream_base_url is not None:
        host = urlsplit(upstream_base_url).hostname
        if not host:
            raise ValueError("upstream_base_url must name a host")
        hosts.append(host)
    if token_target is not None and token_target.hostname not in hosts:
        hosts.append(token_target.hostname or "")
    return tuple(hosts)


def _validated_credential(credential: str | None) -> str | None:
    if credential is None:
        return None
    if not credential or "\r" in credential or "\n" in credential:
        raise ValueError("credential must be a non-empty single line")
    return credential


def _refused_route(reason: str) -> RouteDecision:
    return RouteDecision(False, None, reason)


def _jwt_segment(document: dict[str, object]) -> str:
    # Standard base64 rather than base64url: the client decodes the payload with
    # a decoder that rejects the url-safe alphabet.
    encoded = base64.b64encode(json.dumps(document, separators=(",", ":")).encode())
    return encoded.decode().rstrip("=")


def _jwt_payload(segment: str) -> dict[str, object]:
    try:
        decoded = base64.b64decode(segment + "=" * (-len(segment) % 4), validate=True)
        payload = json.loads(decoded)
    except (binascii.Error, ValueError) as error:
        raise ValueError("codex access token payload is not decodable") from error
    if not isinstance(payload, dict):
        raise ValueError("codex access token payload is not an object")
    return payload


def _decompressed(body: bytes) -> bytes | None:
    # The SSE path may compress the request body, so the frozen model is only
    # visible after decoding. A frame that will not decode is refused, never
    # forwarded unvalidated.
    if not body.startswith(ZSTD_MAGIC):
        return body
    try:
        return zstandard.ZstdDecompressor().decompress(
            body, max_output_size=MAX_DECOMPRESSED_BODY_BYTES)
    except zstandard.ZstdError:
        return None


def _json_object(payload: bytes) -> dict[str, object] | None:
    try:
        value = json.loads(payload)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _sse_payloads(body: bytes) -> Iterator[bytes]:
    for line in body.splitlines():
        if not line.startswith(b"data:"):
            continue
        payload = line[5:].strip()
        if payload and payload != b"[DONE]":
            yield payload


def _token_counts(usage: dict[str, object]) -> tuple[int, int] | None:
    input_tokens = usage.get("input_tokens")
    output_tokens = usage.get("output_tokens")
    if type(input_tokens) is not int or type(output_tokens) is not int:
        return None
    if input_tokens < 0 or output_tokens < 0:
        return None
    return input_tokens, output_tokens


def _model_of(response: dict[str, object]) -> str | None:
    model = response.get("model")
    return model if isinstance(model, str) and model.strip() else None


def _non_empty_text(value: object) -> bool:
    return isinstance(value, str) and bool(value)


def _now_ms() -> int:
    return int(time.time() * 1000)
