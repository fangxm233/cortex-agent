# input:  container request lines, request bodies, and upstream payloads
# output: row-1 route, body, auth, usage, and billable decisions
# pos:    Anthropic messages adapter for a static API key
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
from urllib.parse import urlsplit

from ..models import PROXY_SCHEMA_VERSION, ProxyUsage
from .base import AuthInjectionUnavailable, Billable, BodyDecision, RouteDecision

MESSAGES_BETA_ROUTE = "messages_beta"
MESSAGES_PATH = "/v1/messages"
COUNT_TOKENS_PATH = "/v1/messages/count_tokens"
BATCHES_PATH = "/v1/messages/batches"
BETA_QUERY = "beta=true"


class AnthropicMessagesApiKeyAdapter:
    # The credential kind is named api-key-bearer by the capability key, but the
    # wire form for a static key is x-api-key; the key member is not renamed here.
    adapter_id = "anthropic-messages/api-key-bearer"
    schema_version = PROXY_SCHEMA_VERSION

    def __init__(
        self, upstream_base_url: str | None = None, credential: str | None = None,
        frozen_model: str | None = None,
    ) -> None:
        self.upstream_hosts = _upstream_hosts(upstream_base_url)
        self._credential = _validated_credential(credential)
        self._frozen_model = frozen_model

    def validate_route(self, method: str, path: str) -> RouteDecision:
        target = urlsplit(path)
        if target.path == COUNT_TOKENS_PATH:
            return _refused_route("route_denied_count_tokens")
        if target.path == BATCHES_PATH or target.path.startswith(f"{BATCHES_PATH}/"):
            return _refused_route("route_denied_batches")
        if target.path != MESSAGES_PATH:
            return _refused_route("route_not_allowed")
        if method != "POST":
            return _refused_route("route_denied_messages_method")
        if target.query != BETA_QUERY:
            return _refused_route("route_denied_messages_non_beta")
        return RouteDecision(True, MESSAGES_BETA_ROUTE, None)

    def validate_body(self, route_id: str, body: bytes) -> BodyDecision:
        if route_id != MESSAGES_BETA_ROUTE:
            return BodyDecision(False, None, "request_route_unknown")
        document = _json_object(body)
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

    def inject_auth(self, headers, route_id: str) -> dict[str, str]:
        if route_id != MESSAGES_BETA_ROUTE:
            raise AuthInjectionUnavailable("route carries no auth form")
        if self._credential is None:
            raise AuthInjectionUnavailable("no api key is bound to this adapter")
        outbound = {
            key: value for key, value in headers.items() if key.lower() != "x-api-key"
        }
        outbound["x-api-key"] = self._credential
        return outbound

    def extract_usage(self, body: bytes, content_type: str) -> ProxyUsage:
        documents = (
            _sse_documents(body) if "text/event-stream" in content_type
            else [_json_object(body) or {}]
        )
        model: str | None = None
        input_tokens = 0
        output_tokens = 0
        seen_input = False
        seen_output = False
        malformed = False
        for document in documents:
            usage = _usage(document)
            malformed = malformed or _invalid_present_token(usage)
            seen_input = seen_input or _valid_token(usage, "input_tokens")
            seen_output = seen_output or _valid_token(usage, "output_tokens")
            model, input_tokens, output_tokens = _merge_usage(
                document, model, input_tokens, output_tokens)
        accounted = (
            seen_input and seen_output and not malformed and bool(model and model.strip())
        )
        return ProxyUsage(model, input_tokens, output_tokens, accounted)

    def billable(self, usage: ProxyUsage) -> Billable:
        if not usage.accounted:
            raise ValueError("billable is never called on an unaccounted usage")
        return Billable(usage.input_tokens, usage.output_tokens)


def _upstream_hosts(upstream_base_url: str | None) -> tuple[str, ...]:
    if upstream_base_url is None:
        return ()
    host = urlsplit(upstream_base_url).hostname
    if not host:
        raise ValueError("upstream_base_url must name a host")
    return (host,)


def _validated_credential(credential: str | None) -> str | None:
    if credential is None:
        return None
    if not credential or "\r" in credential or "\n" in credential:
        raise ValueError("credential must be a non-empty single line")
    return credential


def _refused_route(reason: str) -> RouteDecision:
    return RouteDecision(False, None, reason)


def _sse_documents(body: bytes) -> list[dict[str, object]]:
    documents: list[dict[str, object]] = []
    for line in body.splitlines():
        if line.startswith(b"data:") and line[5:].strip() != b"[DONE]":
            documents.append(_json_object(line[5:].strip()) or {})
    return documents


def _json_object(payload: bytes) -> dict[str, object] | None:
    try:
        value = json.loads(payload)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _merge_usage(
    document: dict[str, object], model: str | None,
    input_tokens: int, output_tokens: int,
) -> tuple[str | None, int, int]:
    source = _message_source(document)
    next_model = source.get("model")
    usage = _usage(document)
    model = next_model if isinstance(next_model, str) else model
    if usage is None:
        return model, input_tokens, output_tokens
    return model, _token_value(usage, "input_tokens", input_tokens), _token_value(
        usage, "output_tokens", output_tokens)


def _message_source(document: dict[str, object]) -> dict[str, object]:
    message = document.get("message")
    return message if isinstance(message, dict) else document


def _usage(document: dict[str, object]) -> dict[str, object] | None:
    source_usage = _message_source(document).get("usage")
    if isinstance(source_usage, dict):
        return source_usage
    document_usage = document.get("usage")
    return document_usage if isinstance(document_usage, dict) else None


def _valid_token(usage: dict[str, object] | None, key: str) -> bool:
    if usage is None:
        return False
    value = usage.get(key)
    return type(value) is int and value >= 0


def _invalid_present_token(usage: dict[str, object] | None) -> bool:
    if usage is None:
        return False
    keys = ("input_tokens", "output_tokens")
    return any(key in usage and not _valid_token(usage, key) for key in keys)


def _token_value(usage: dict[str, object], key: str, previous: int) -> int:
    value = usage.get(key, previous)
    return value if type(value) is int and value >= 0 else previous
