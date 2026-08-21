# input:  DeepSeek request targets, JSON bodies, and SSE payloads
# output: route, auth, and usage decisions
# pos:    DeepSeek OpenAI chat-completions API-key adapter
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
from collections.abc import Mapping
from urllib.parse import urlsplit

from ..models import PROXY_SCHEMA_VERSION, ProxyDiagnosticCode, ProxyUsage
from .base import AuthInjectionUnavailable, BodyDecision, RouteDecision

ADAPTER_ID = "deepseek-chat-completions/api-key"
CHAT_COMPLETIONS_ROUTE = "chat_completions"
CHAT_COMPLETIONS_PATHS = frozenset({"/chat/completions", "/v1/chat/completions"})
FORWARDED_HEADERS = frozenset({"accept", "content-type"})


class DeepSeekChatCompletionsApiKeyAdapter:
    adapter_id = ADAPTER_ID
    schema_version = PROXY_SCHEMA_VERSION

    def __init__(
        self, upstream_base_url: str | None = None, credential: str | None = None,
        frozen_model: str | None = None, frozen_completion_cap: int | None = None,
    ) -> None:
        self.upstream_hosts = _upstream_hosts(upstream_base_url)
        self._credential = _validated_credential(credential)
        self._frozen_model = frozen_model
        # The completion cap has the same shape as the frozen model: it is a per-trial datum the
        # launcher hands in, never a value compiled into this module. Absent means no request is
        # admitted, rather than a shipped default the trial never declared.
        self._frozen_completion_cap = _validated_completion_cap(frozen_completion_cap)

    def validate_route(self, method: str, path: str) -> RouteDecision:
        target = urlsplit(path)
        if target.path not in CHAT_COMPLETIONS_PATHS or target.query:
            return RouteDecision(False, None, "route_not_allowed")
        if method != "POST":
            return RouteDecision(False, None, "route_denied_method")
        return RouteDecision(True, CHAT_COMPLETIONS_ROUTE, None)

    def validate_body(self, route_id: str, body: bytes) -> BodyDecision:
        if route_id != CHAT_COMPLETIONS_ROUTE:
            return BodyDecision(False, None, "request_route_unknown")
        document = _json_object(body)
        if document is None:
            return BodyDecision(False, None, "request_body_unparsable")
        model = document.get("model")
        reason = self._body_reason(document, model)
        return BodyDecision(reason is None, model if isinstance(model, str) else None, reason)

    def _body_reason(self, document: dict[str, object], model: object) -> str | None:
        if not isinstance(model, str) or not model:
            return "request_model_absent"
        if self._frozen_model is None:
            return "request_model_unfrozen"
        if model != self._frozen_model:
            return "request_model_mismatch"
        return self._request_policy_reason(document)

    def _request_policy_reason(self, document: dict[str, object]) -> str | None:
        if document.get("stream") is not True:
            return "request_stream_required"
        options = document.get("stream_options")
        if not isinstance(options, dict) or options.get("include_usage") is not True:
            return "request_stream_usage_required"
        # A body defect is named before the adapter's own missing cap, so the conflict refusal
        # keeps its meaning whether or not a cap was frozen.
        if "max_tokens" in document:
            return "request_completion_cap_conflict"
        if self._frozen_completion_cap is None:
            return "request_completion_cap_unfrozen"
        if document.get("max_completion_tokens") != self._frozen_completion_cap:
            return "request_completion_cap_mismatch"
        return None

    def inject_auth(self, headers: Mapping[str, str], route_id: str) -> dict[str, str]:
        if route_id != CHAT_COMPLETIONS_ROUTE:
            raise AuthInjectionUnavailable("route carries no auth form")
        if self._credential is None:
            raise AuthInjectionUnavailable("no api key is bound to this adapter")
        outbound = {
            key: value for key, value in headers.items()
            if key.lower() in FORWARDED_HEADERS
        }
        outbound["authorization"] = f"Bearer {self._credential}"
        return outbound

    def extract_usage(self, body: bytes, content_type: str) -> ProxyUsage:
        if "text/event-stream" not in content_type:
            return ProxyUsage(
                None, 0, 0, False,
                diagnostic_code="deepseek_content_type_not_sse",
            )
        stream = _parse_stream(body)
        models = _stream_models(stream.documents)
        usages = _stream_usages(stream.documents)
        accounted = _stream_accounted(stream, models, usages, self._frozen_model)
        diagnostic_code = (
            None if accounted else _stream_diagnostic(
                stream, models, usages, self._frozen_model)
        )
        model = next(iter(models), None)
        if len(usages) != 1:
            return ProxyUsage(model, 0, 0, False, diagnostic_code=diagnostic_code)
        input_tokens, output_tokens, cached_tokens = usages[0]
        return ProxyUsage(
            model, input_tokens, output_tokens, accounted, cached_tokens, diagnostic_code,
        )

    def clear_credential(self) -> None:
        self._credential = None


class _ParsedStream:
    def __init__(
        self, documents: list[dict[str, object]], *, done: bool,
        malformed: bool, data_after_done: bool, error_event: bool,
    ) -> None:
        self.documents = documents
        self.done = done
        self.malformed = malformed
        self.data_after_done = data_after_done
        self.error_event = error_event


def _parse_stream(body: bytes) -> _ParsedStream:
    documents: list[dict[str, object]] = []
    done = malformed = data_after_done = error_event = False
    for line in body.splitlines():
        if not line.startswith(b"data:"):
            continue
        payload = line[5:].strip()
        if payload == b"[DONE]":
            done = True
            continue
        if done and payload:
            data_after_done = True
        document = _json_object(payload)
        malformed = malformed or document is None
        if document is not None:
            error_event = error_event or document.get("type") == "error"
            documents.append(document)
    return _ParsedStream(
        documents, done=done, malformed=malformed, data_after_done=data_after_done,
        error_event=error_event,
    )


def _stream_models(documents: list[dict[str, object]]) -> set[str]:
    return {
        model for document in documents
        if isinstance((model := document.get("model")), str) and model
    }


def _stream_usages(documents: list[dict[str, object]]) -> list[tuple[int, int, int | None]]:
    usages: list[tuple[int, int, int | None]] = []
    for document in documents:
        usage = document.get("usage")
        if not isinstance(usage, dict):
            continue
        prompt = usage.get("prompt_tokens")
        completion = usage.get("completion_tokens")
        if _token(prompt) and _token(completion):
            usages.append((prompt, completion, _cached_tokens(usage)))
        else:
            usages.append((-1, -1, None))
    return usages


def _cached_tokens(usage: dict[str, object]) -> int | None:
    """What of the prompt the provider served from cache, if it said so.

    Two spellings reach us for the same fact: the OpenAI-compatible
    `usage.prompt_tokens_details.cached_tokens` and DeepSeek's own
    `usage.prompt_cache_hit_tokens`. Either is read; absence is reported as absence.

    This is recorded, not priced. The proxy states how much of the prompt was cached and stops
    there, because turning that into money needs a price list, and the last time this boundary
    held one it charged cached tokens at the full input rate and over-stated a trial by 12.7x.
    """
    details = usage.get("prompt_tokens_details")
    if isinstance(details, dict):
        cached = details.get("cached_tokens")
        if _token(cached):
            return cached
    hit = usage.get("prompt_cache_hit_tokens")
    return hit if _token(hit) else None


def _stream_accounted(
    stream: _ParsedStream, models: set[str], usages: list[tuple[int, int, int | None]],
    frozen_model: str | None,
) -> bool:
    valid_usage = len(usages) == 1 and min(usages[0][0], usages[0][1]) >= 0
    return (
        stream.done and not stream.malformed and not stream.data_after_done
        and models == {frozen_model} and valid_usage
    )


def _stream_diagnostic(
    stream: _ParsedStream, models: set[str], usages: list[tuple[int, int, int | None]],
    frozen_model: str | None,
) -> ProxyDiagnosticCode | None:
    """Name one failed protocol predicate without retaining any provider content."""
    if stream.malformed:
        return "deepseek_sse_malformed"
    if stream.data_after_done:
        return "deepseek_data_after_done"
    if stream.error_event:
        return "deepseek_error_event"
    if not stream.done:
        return "deepseek_done_missing"
    if models != {frozen_model}:
        return "deepseek_model_mismatch"
    if not usages:
        return "deepseek_usage_missing"
    if len(usages) != 1:
        return "deepseek_usage_duplicate"
    if min(usages[0][0], usages[0][1]) < 0:
        return "deepseek_usage_invalid"
    return None


def _token(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _json_object(payload: bytes) -> dict[str, object] | None:
    try:
        value = json.loads(payload)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _upstream_hosts(upstream_base_url: str | None) -> tuple[str, ...]:
    if upstream_base_url is None:
        return ()
    host = urlsplit(upstream_base_url).hostname
    if not host:
        raise ValueError("upstream_base_url must name a host")
    return (host,)


def _validated_completion_cap(frozen_completion_cap: object) -> int | None:
    if frozen_completion_cap is None:
        return None
    if (
        not isinstance(frozen_completion_cap, int)
        or isinstance(frozen_completion_cap, bool)
        or frozen_completion_cap <= 0
    ):
        raise ValueError("frozen_completion_cap must be a positive integer")
    return frozen_completion_cap


def _validated_credential(credential: str | None) -> str | None:
    if credential is None:
        return None
    if not credential or "\r" in credential or "\n" in credential:
        raise ValueError("credential must be a non-empty single line")
    return credential
