# input:  decimal budget values, UTC deadline, aggregate usage
# output: validated proxy policy and safe manifest metadata
# pos:    Proxy value types
# >>> If I am updated, update my header and folder CORTEX.md <<<

from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal

PROXY_SCHEMA_VERSION = "cortex-bench-trial-proxy/1"
MILLION = Decimal("1000000")


@dataclass(frozen=True)
class ProxyBudget:
    max_cost_usd: Decimal
    max_request_cost_usd: Decimal
    input_cost_per_million_usd: Decimal
    output_cost_per_million_usd: Decimal

    def __post_init__(self) -> None:
        if min(self.max_cost_usd, self.max_request_cost_usd) <= 0:
            raise ValueError("budget limits must be greater than zero")
        if min(self.input_cost_per_million_usd,
               self.output_cost_per_million_usd) < 0:
            raise ValueError("token prices must not be negative")

    def cost(self, input_tokens: int, output_tokens: int) -> Decimal:
        input_cost = Decimal(input_tokens) * self.input_cost_per_million_usd / MILLION
        output_cost = Decimal(output_tokens) * self.output_cost_per_million_usd / MILLION
        return input_cost + output_cost

    def as_manifest(self) -> dict[str, str]:
        return {
            "max_cost_usd": decimal_text(self.max_cost_usd),
            "max_request_cost_usd": decimal_text(self.max_request_cost_usd),
            "input_cost_per_million_usd": decimal_text(
                self.input_cost_per_million_usd),
            "output_cost_per_million_usd": decimal_text(
                self.output_cost_per_million_usd),
        }


@dataclass(frozen=True)
class ProxyUsage:
    upstream_model: str | None
    input_tokens: int
    output_tokens: int
    accounted: bool


@dataclass(frozen=True)
class ProxyMetadata:
    trial_id: str
    upstream_base_url: str
    bound_source_ip: str
    absolute_deadline: datetime
    budget: ProxyBudget
    log_filename: str

    def manifest_block(self, base_url: str) -> dict[str, object]:
        return {
            "schema_version": PROXY_SCHEMA_VERSION,
            "base_url": base_url,
            "upstream_base_url": self.upstream_base_url,
            "source_binding": {"kind": "ip", "value": self.bound_source_ip},
            "budget": self.budget.as_manifest(),
            "absolute_deadline": utc_text(self.absolute_deadline),
            "log_filename": self.log_filename,
        }


def decimal_text(value: Decimal) -> str:
    return format(value.normalize(), "f")


def utc_text(value: datetime) -> str:
    if value.tzinfo is None:
        raise ValueError("absolute_deadline must include a timezone")
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")
