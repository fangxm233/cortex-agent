# input:  ceiling policy, vendor campaigns, malformed variants
# output: approved-ceiling and refusal proofs for the policy loader
# pos:    Capability ceiling policy loader tests
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# The ceilings are configuration, not code: this file proves the shipped document says what the
# approved envelope allows, and that a document which cannot be read as a ceiling is refused
# rather than silently treated as "no ceiling".

from copy import deepcopy
from decimal import Decimal
from pathlib import Path
import re

import pytest

from cortex_bench_harness.campaign_config import load_campaign_config
from cortex_bench_harness.launcher.capability_ceilings import (
    CAPABILITY_CEILINGS_SCHEMA_VERSION,
    CEILING_FIELDS,
    DEFAULT_CAPABILITY_CEILINGS_PATH,
    load_capability_ceilings,
)
from cortex_bench_harness.launcher.trial_proxy import (
    PAID_ENVELOPE_FIELDS,
    PaidEnvelopeRefused,
    parse_trial_proxy_spec,
    validate_paid_envelope,
)

APPROVED_DEEPSEEK_CEILINGS = {
    "max_provider_requests": 1000,
    "max_cost_usd": Decimal("100.00"),
    "deadline_seconds": 7200,
    "max_output_tokens": 131072,
    "request_body_limit_bytes": 64 * 1024 * 1024,
    "response_body_limit_bytes": 64 * 1024 * 1024,
}
APPROVED_VENDOR_CEILINGS = {
    "max_provider_requests": 500,
    "max_cost_usd": Decimal("2.00"),
    "deadline_seconds": 1800,
    "max_output_tokens": 65536,
    "request_body_limit_bytes": 64 * 1024 * 1024,
    "response_body_limit_bytes": 64 * 1024 * 1024,
}
APPROVED_DEEPSEEK_POLICY_BLOCK = """  pi-deepseek-api-key:
    # A request counter, and now written as one. This used to be a pair of dollar figures,
    # `max_cost_usd` and `max_request_cost_usd`, and admission reserved one whole per-request
    # figure against the per-trial one. Since the reservation was never reconciled against what a
    # request actually cost, the pair could only ever express
    # `floor(max_cost_usd / max_request_cost_usd)` requests — which `max_provider_requests` states
    # directly. Two campaign-config refusals existed solely to stop the two expressions of that one
    # number from contradicting each other, and both are gone with it.
    #
    # Holding a price list at the proxy was also actively harmful: it charged cached prompt tokens
    # at the full input rate, over-stated a 99.2%-cached trial by 12.7x, and the resulting
    # disagreement with the run's own cache-aware accounting discarded a finished benchmark trial.
    # The proxy now counts requests and measures tokens, and prices nothing.
    #
    # The INNER run's own spend limit, which the run prices with the provider's cache-aware rates.
    # The proxy holds no price list and enforces no cost, so this is the only money figure left.
    max_cost_usd: "100.00"
    # median session ~12k output tokens at ~268 tokens/response ~ 45 responses
    max_provider_requests: 1000
    # per-request latency median ~1.1 s, max 58 s; a multi-turn task needs room for commands
    deadline_seconds: 7200
    # per-response median 268, p99.9 14.5k, max 28.2k; the model supports 384k
    max_output_tokens: 131072
    # input median ~0.40 MiB, max ~2.04 MiB; 64 MiB
    request_body_limit_bytes: 67108864
    # streamed SSE framing multiplies raw output text several times over; 64 MiB
    response_body_limit_bytes: 67108864
""".encode()
APPROVED_VENDOR_POLICY_COMMENT = b"""    # Approved per-trial bounds; no broader than the envelope the committed vendor campaign
    # document for this capability already declares.
"""
REPO_ROOT = Path(__file__).resolve().parents[4]
VENDOR_CAMPAIGNS_DIR = REPO_ROOT / "benchmark" / "campaigns"
VENDOR_CAMPAIGNS = (
    VENDOR_CAMPAIGNS_DIR / "terminal-bench-2.1-vendor-claude-code.yaml",
    VENDOR_CAMPAIGNS_DIR / "terminal-bench-2.1-vendor-codex.yaml",
)


def repo_root() -> Path:
    return REPO_ROOT


def policy_document(**overrides: object) -> str:
    lines = [f"schema_version: {CAPABILITY_CEILINGS_SCHEMA_VERSION}", "capabilities:",
             "  pi-deepseek-api-key:"]
    values = {
        "max_provider_requests": 1000, "max_cost_usd": '"100.00"', "deadline_seconds": 7200,
        "max_output_tokens": 131072,
        "request_body_limit_bytes": 67108864, "response_body_limit_bytes": 67108864,
        **overrides,
    }
    lines.extend(f"    {field}: {value}" for field, value in values.items())
    return "\n".join(lines) + "\n"


def write_policy(tmp_path: Path, text: str) -> Path:
    path = tmp_path / "capability-ceilings.yaml"
    path.write_text(text, encoding="utf-8")
    return path


def test_the_default_path_is_the_committed_policy_file() -> None:
    assert DEFAULT_CAPABILITY_CEILINGS_PATH == (
        repo_root() / "benchmark" / "policy" / "capability-ceilings.yaml"
    )
    assert DEFAULT_CAPABILITY_CEILINGS_PATH.is_file()


def test_the_committed_policy_declares_the_approved_deepseek_ceilings() -> None:
    ceilings = load_capability_ceilings()

    assert ceilings["pi-deepseek-api-key"] == APPROVED_DEEPSEEK_CEILINGS
    assert set(APPROVED_DEEPSEEK_CEILINGS) == set(CEILING_FIELDS)


def policy_block(capability_id: str) -> bytes:
    source = DEFAULT_CAPABILITY_CEILINGS_PATH.read_bytes()
    marker = f"  {capability_id}:\n".encode()
    start = source.index(marker)
    following = source[start + len(marker):]
    next_row = re.search(rb"(?m)^  [a-z0-9][a-z0-9-]*:\n", following)
    end = len(source) if next_row is None else start + len(marker) + next_row.start()
    return source[start:end]


def test_the_existing_deepseek_policy_row_is_byte_for_byte_unchanged() -> None:
    assert policy_block("pi-deepseek-api-key") == APPROVED_DEEPSEEK_POLICY_BLOCK


@pytest.mark.parametrize("campaign_path", VENDOR_CAMPAIGNS)
def test_committed_vendor_envelopes_are_accepted(campaign_path: Path) -> None:
    config = load_campaign_config(campaign_path)
    (arm,) = config.arms
    capability_id = str(arm["credential_capability"])
    declared = validate_paid_envelope(
        arm, parse_trial_proxy_spec(config.slot_proxy(config.slot(0))), capability_id,
    )

    assert declared == APPROVED_VENDOR_CEILINGS
    assert APPROVED_VENDOR_POLICY_COMMENT in policy_block(capability_id)


@pytest.mark.parametrize("campaign_path", VENDOR_CAMPAIGNS)
@pytest.mark.parametrize("field", sorted(CEILING_FIELDS))
def test_vendor_envelope_one_unit_over_any_ceiling_is_refused(
    campaign_path: Path, field: str,
) -> None:
    config = load_campaign_config(campaign_path)
    arm = deepcopy(config.arms[0])
    proxy = dict(config.slot_proxy(config.slot(0)))
    if field in proxy:
        proxy[field] = int(proxy[field]) + 1
    else:
        limits = dict(arm["limits"])
        arm["limits"] = limits
        value = limits[field]
        limits[field] = str(Decimal(str(value)) + 1) if field == "max_cost_usd" else int(value) + 1

    with pytest.raises(PaidEnvelopeRefused, match=f"paid envelope {field}=.* exceeds"):
        validate_paid_envelope(
            arm, parse_trial_proxy_spec(proxy), str(arm["credential_capability"]),
        )


def test_every_paid_envelope_field_has_a_ceiling_and_nothing_else_does() -> None:
    """The two sets are declared in different modules, and a field in one but not the other is
    either an unbounded envelope field or a ceiling nothing validates."""
    assert set(PAID_ENVELOPE_FIELDS) == set(CEILING_FIELDS)
    assert set(PAID_ENVELOPE_FIELDS) == {
        "max_provider_requests", "max_cost_usd", "deadline_seconds", "max_output_tokens",
        "request_body_limit_bytes", "response_body_limit_bytes",
    }


def test_a_declared_capability_reads_back_exactly(tmp_path: Path) -> None:
    ceilings = load_capability_ceilings(write_policy(tmp_path, policy_document()))

    assert ceilings == {"pi-deepseek-api-key": APPROVED_DEEPSEEK_CEILINGS}


@pytest.mark.parametrize("field", sorted(CEILING_FIELDS))
def test_a_ceiling_field_that_is_absent_is_refused(tmp_path: Path, field: str) -> None:
    text = "\n".join(
        line for line in policy_document().splitlines() if not line.strip().startswith(f"{field}:")
    ) + "\n"

    with pytest.raises(ValueError, match=field):
        load_capability_ceilings(write_policy(tmp_path, text))


@pytest.mark.parametrize(
    "overrides",
    [
        {"max_provider_requests": 0},
        {"max_provider_requests": -1},
        {"max_provider_requests": '"1000"'},
        {"deadline_seconds": "true"},
        {"max_cost_usd": '"0"'},
        {"max_cost_usd": '"-1.00"'},
        {"max_cost_usd": 10.0},
        {"max_cost_usd": '"not-a-decimal"'},
    ],
)
def test_a_ceiling_that_is_not_a_positive_number_is_refused(
    tmp_path: Path, overrides: dict[str, object],
) -> None:
    with pytest.raises(ValueError):
        load_capability_ceilings(write_policy(tmp_path, policy_document(**overrides)))


@pytest.mark.parametrize(
    "text",
    [
        "schema_version: cortex-bench-capability-ceilings/999\ncapabilities: {}\n",
        "capabilities: {}\n",
        f"schema_version: {CAPABILITY_CEILINGS_SCHEMA_VERSION}\n",
        f"schema_version: {CAPABILITY_CEILINGS_SCHEMA_VERSION}\ncapabilities: []\n",
        f"schema_version: {CAPABILITY_CEILINGS_SCHEMA_VERSION}\n"
        "capabilities:\n  pi-deepseek-api-key: 10\n",
        "[]\n",
    ],
)
def test_a_document_that_is_not_a_ceiling_policy_is_refused(tmp_path: Path, text: str) -> None:
    with pytest.raises(ValueError):
        load_capability_ceilings(write_policy(tmp_path, text))


def test_an_undeclared_field_is_refused(tmp_path: Path) -> None:
    text = policy_document() + "    max_thread_starts: 4\n"

    with pytest.raises(ValueError, match="max_thread_starts"):
        load_capability_ceilings(write_policy(tmp_path, text))


def test_a_missing_policy_file_is_refused(tmp_path: Path) -> None:
    with pytest.raises(OSError):
        load_capability_ceilings(tmp_path / "absent.yaml")
