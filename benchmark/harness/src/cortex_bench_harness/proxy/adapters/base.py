# input:  one provider protocol expressed as five request-path duties
# output: the provider adapter interface and its decision value types
# pos:    Provider adapter contract
# >>> If I am updated, update my header and folder CORTEX.md <<<

from dataclasses import dataclass
from typing import Mapping, Protocol

from ..models import ProxyUsage


class AdapterUnavailable(LookupError):
    # No adapter carries this capability key: the proxy must not start, because
    # an unadapted route is never opened.
    pass


class AdapterVersionMismatch(AdapterUnavailable):
    # The key's proxy_adapter_version is not the running schema version. This is
    # a start-time refusal, never a warning: evidence gathered under one version
    # does not describe another.
    pass


class AuthInjectionUnavailable(RuntimeError):
    # The adapter has no usable auth form for its credential: forward nothing.
    pass


@dataclass(frozen=True)
class RouteDecision:
    allow: bool
    route_id: str | None
    reason: str | None


@dataclass(frozen=True)
class BodyDecision:
    allow: bool
    requested_model: str | None
    reason: str | None


@dataclass(frozen=True)
class Billable:
    input_tokens: int
    output_tokens: int


class ProviderAdapter(Protocol):
    # Every duty fails closed: a duty that cannot decide refuses, and never
    # falls through to a shipped default or opens an upstream connection.
    # An adapter declares billable quantities but never applies a budget: limit
    # enforcement stays with the single shipped enforcer.
    adapter_id: str
    schema_version: str
    # The closed host set an adapter may address. It is frozen at proxy start
    # from host-side inputs and is never learned from a container request or an
    # upstream response, which is what makes host-set closure assertable.
    upstream_hosts: tuple[str, ...]

    def validate_route(self, method: str, path: str) -> RouteDecision: ...

    def validate_body(self, route_id: str, body: bytes) -> BodyDecision: ...

    def inject_auth(self, headers: Mapping[str, str], route_id: str) -> dict[str, str]: ...

    def extract_usage(self, body: bytes, content_type: str) -> ProxyUsage: ...

    def billable(self, usage: ProxyUsage) -> Billable: ...
