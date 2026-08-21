# input:  the declared request cap, UTC deadline, aggregate usage
# output: validated proxy policy, its request bound, and safe manifest metadata
# pos:    Proxy value types
# >>> If I am updated, update my header and folder CORTEX.md <<<

from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Literal

PROXY_SCHEMA_VERSION = "cortex-bench-trial-proxy/2"
ProxyDiagnosticCode = Literal[
    "deepseek_content_type_not_sse",
    "deepseek_sse_malformed",
    "deepseek_data_after_done",
    "deepseek_error_event",
    "deepseek_done_missing",
    "deepseek_model_mismatch",
    "deepseek_usage_missing",
    "deepseek_usage_duplicate",
    "deepseek_usage_invalid",
]
PROXY_DIAGNOSTIC_CODES = frozenset({
    "deepseek_content_type_not_sse",
    "deepseek_sse_malformed",
    "deepseek_data_after_done",
    "deepseek_error_event",
    "deepseek_done_missing",
    "deepseek_model_mismatch",
    "deepseek_usage_missing",
    "deepseek_usage_duplicate",
    "deepseek_usage_invalid",
})


@dataclass(frozen=True)
class ProxyLimits:
    """What bounds one trial's route: a count of requests, not an amount of money.

    This was a pair of declared costs, and admission reserved one whole `max_request_cost_usd`
    against `max_cost_usd` per request. The reservation was never reconciled against what a request
    actually cost, so that arithmetic could only ever answer
    `floor(max_cost_usd / max_request_cost_usd)` — a request counter written in dollars. It
    duplicated the arm's own `max_provider_requests`, and two config refusals existed purely to stop
    the two expressions of that one number from contradicting each other.

    Pricing in dollars also obliged the proxy to hold a price list, which is the one thing a
    metering boundary cannot keep correct. DeepSeek bills cached prompt tokens at a reduced rate;
    the proxy charged every prompt token at the full input rate; at a 99.2% cache hit rate it
    over-stated one trial's spend by 12.7x. That figure then disagreed with the run's own
    cache-aware accounting, and the disagreement — between two correct numbers computed under
    different price lists — failed reconciliation and discarded a finished trial.

    So the proxy no longer prices anything. It counts requests and measures tokens, both of which
    it observes directly, and leaves cost to whoever holds a price list.
    """

    max_requests: int

    def __post_init__(self) -> None:
        if isinstance(self.max_requests, bool) or not isinstance(self.max_requests, int):
            raise ValueError("max_requests must be an integer")
        if self.max_requests <= 0:
            raise ValueError("max_requests must be greater than zero")

    def as_manifest(self) -> dict[str, object]:
        return {"max_requests": self.max_requests}


@dataclass(frozen=True)
class ProxyUsage:
    upstream_model: str | None
    input_tokens: int
    output_tokens: int
    accounted: bool
    # What the provider said it served from its prompt cache, when it said anything at all. `None`
    # means the response carried no cache breakdown, which is not the same as a cache that missed;
    # the record says so rather than reporting a zero it never observed.
    cached_tokens: int | None = None
    # A closed, content-free explanation for an unaccounted provider response. Adapters may name
    # only protocol predicates here; prompts, response text, headers, and provider error text do
    # not cross into the durable audit record.
    diagnostic_code: ProxyDiagnosticCode | None = None

    def __post_init__(self) -> None:
        if self.diagnostic_code is not None and self.diagnostic_code not in PROXY_DIAGNOSTIC_CODES:
            raise ValueError("diagnostic_code must be a closed proxy diagnostic code")


@dataclass(frozen=True)
class ProxyMetadata:
    trial_id: str
    upstream_base_url: str
    bound_source_ip: str
    absolute_deadline: datetime
    limits: ProxyLimits
    log_filename: str
    adapter_id: str
    # The two byte limits the run declared. They are per-run parameters rather than properties of
    # the adapter, so this block — not the capability's promotion evidence — is where they are
    # recorded. `None` means the route was armed unlimited on that side.
    request_body_limit_bytes: int | None = None
    response_body_limit_bytes: int | None = None

    def manifest_block(self, base_url: str) -> dict[str, object]:
        return {
            "schema_version": PROXY_SCHEMA_VERSION,
            "adapter_id": self.adapter_id,
            "base_url": base_url,
            "upstream_base_url": self.upstream_base_url,
            "source_binding": {"kind": "ip", "value": self.bound_source_ip},
            "limits": self.limits.as_manifest(),
            "absolute_deadline": utc_text(self.absolute_deadline),
            "request_body_limit_bytes": self.request_body_limit_bytes,
            "response_body_limit_bytes": self.response_body_limit_bytes,
            "log_filename": self.log_filename,
        }


def decimal_text(value: Decimal) -> str:
    return format(value.normalize(), "f")


def utc_text(value: datetime) -> str:
    if value.tzinfo is None:
        raise ValueError("absolute_deadline must include a timezone")
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")
