# input:  the committed capability ceiling policy document
# output: per-capability envelope ceilings, or a refusal to read one
# pos:    Capability ceiling policy loader
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# The ceilings are configuration, not code: this module only reads them. It reads strictly, because
# the failure it must not have is a document that parses into "no ceiling" — an unreadable, partial
# or non-positive ceiling is refused here rather than treated as permission.

from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Mapping

import yaml

CAPABILITY_CEILINGS_SCHEMA_VERSION = "cortex-bench-capability-ceilings/1"
# benchmark/policy/capability-ceilings.yaml, beside the harness that reads it.
DEFAULT_CAPABILITY_CEILINGS_PATH = (
    Path(__file__).resolve().parents[4] / "policy" / "capability-ceilings.yaml"
)

INTEGER_CEILING_FIELDS = (
    "max_provider_requests", "deadline_seconds", "max_output_tokens",
    "request_body_limit_bytes", "response_body_limit_bytes",
)
# The one decimal ceiling left. It bounds the INNER run's own spend, which the run prices with the
# provider's cache-aware rates; the proxy prices nothing and so has no cost ceiling of its own.
DECIMAL_CEILING_FIELDS = ("max_cost_usd",)
CEILING_FIELDS = frozenset(INTEGER_CEILING_FIELDS + DECIMAL_CEILING_FIELDS)

CapabilityCeilings = Mapping[str, int | Decimal]


def load_capability_ceilings(
    path: Path | None = None,
) -> Mapping[str, CapabilityCeilings]:
    """Read the committed ceiling policy, keyed by capability id.

    A missing file raises rather than yielding an empty policy: a paid run that cannot read its
    ceilings is refused, never admitted unbounded.
    """
    source = DEFAULT_CAPABILITY_CEILINGS_PATH if path is None else path
    document = yaml.safe_load(source.read_text(encoding="utf-8"))
    if not isinstance(document, Mapping):
        raise ValueError(f"capability ceiling policy {source} is not a mapping")
    version = document.get("schema_version")
    if version != CAPABILITY_CEILINGS_SCHEMA_VERSION:
        raise ValueError(
            f"capability ceiling policy declares schema_version {version!r}; "
            f"this launcher reads {CAPABILITY_CEILINGS_SCHEMA_VERSION}")
    capabilities = document.get("capabilities")
    if not isinstance(capabilities, Mapping):
        raise ValueError("capability ceiling policy requires a capabilities mapping")
    return {
        str(capability_id): _ceilings(str(capability_id), values)
        for capability_id, values in capabilities.items()
    }


def _ceilings(capability_id: str, values: object) -> CapabilityCeilings:
    if not isinstance(values, Mapping):
        raise ValueError(f"capability ceilings for {capability_id} must be a mapping")
    declared = set(values)
    missing = sorted(CEILING_FIELDS - declared)
    if missing:
        raise ValueError(f"capability ceilings for {capability_id} require fields {missing}")
    rejected = sorted(declared - CEILING_FIELDS)
    if rejected:
        raise ValueError(f"capability ceilings for {capability_id} reject fields {rejected}")
    ceilings: dict[str, int | Decimal] = {
        field: _positive_int(capability_id, field, values[field])
        for field in INTEGER_CEILING_FIELDS
    }
    ceilings.update({
        field: _positive_decimal(capability_id, field, values[field])
        for field in DECIMAL_CEILING_FIELDS
    })
    return ceilings


def _positive_int(capability_id: str, field: str, value: Any) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ValueError(
            f"capability ceiling {capability_id}.{field} must be a positive integer")
    return value



def _positive_decimal(capability_id: str, field: str, value: Any) -> Decimal:
    # Decimal strings only: a YAML float ceiling would compare against a declared decimal through
    # a binary approximation of the number the reviewer of this file read.
    if not isinstance(value, str):
        raise ValueError(
            f"capability ceiling {capability_id}.{field} must be a decimal string")
    try:
        parsed = Decimal(value)
    except InvalidOperation as error:
        raise ValueError(
            f"capability ceiling {capability_id}.{field} must be a decimal string") from error
    if not parsed.is_finite() or parsed <= 0:
        raise ValueError(
            f"capability ceiling {capability_id}.{field} must be a positive decimal")
    return parsed
