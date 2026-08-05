# input:  a row-four trial armed through the launcher and driven over its own refusal flows
# output: closed-inventory scan proofs for every source this row's flows create
# pos:    Leak-scan extension over the codex responses row
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# No container, no Docker and no network egress: the upstream is a synthetic loopback server. The
# row's `??` protocol member is filled for the duration of a test only — the shipped registry is
# never written, because filling it is the act of the gate that owns the raise checklist.

import json
from pathlib import Path

import pytest

from capability_admission import admit_capability
from cortex_bench_harness.launcher.trial_proxy import (
    PROXY_ARTIFACT_SOURCES,
    PROXY_AUDIT_LOG_SOURCE,
    arm_trial_proxy,
    capture_trial_inventory,
    parse_trial_proxy_spec,
    revoke_trial_proxy,
)
from cortex_bench_harness.proxy.adapters.openai_codex_responses import (
    RESPONSES_PATH,
    TOKEN_PATH,
    ZSTD_MAGIC,
)
from cortex_bench_harness.proxy.lease import LEASE_ECHO_SCHEMA_VERSION, LEASE_ECHO_TARGET
from cortex_bench_harness.scan.models import ScanPolicy
from cortex_bench_harness.scan.scanner import scan_trial_artifacts
from synthetic import SyntheticUpstream, proxy_request
from test_lease_echo import post_echo
from test_openai_codex_adapter import (
    CODEX_MODEL,
    HOST_ACCESS_TOKEN,
    serve_stream,
    sse_stream,
    terminal_event,
)

CAPABILITY_ID = "pi-openai-codex-oauth"
PROTOCOL = "openai-codex-responses"
TRIAL_ID = "trial-row-four-scan"
CREDENTIAL_ENV = "CORTEX_BENCH_ROW_FOUR_CREDENTIAL"
DEADLINE_SECONDS = 600
COMPILED_AT_EPOCH_MS = 1_800_000_240_000

# The audit outcomes this row's flows add over the shipped set, each asserted below against the
# file the trial actually wrote. A body refusal reaches the audit log under the adapter's own
# reason and only reaches the container as the generic `request_model_rejected`
# (`proxy/server.py:308-309`), so the model-mismatch flow is checked on both sides rather than
# assumed to carry one name through.
ROW_FOUR_AUDIT_OUTCOMES = (
    "route_denied_token_endpoint",
    "route_denied_responses_query",
    "request_model_mismatch",
    "request_body_zstd_undecodable",
    "budget_accounting_unavailable",
)
MODEL_REJECTED_WIRE_REASON = "request_model_rejected"


def row_four_arm() -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-arm/2",
        "kind": "cortex", "name": "cortex-direct", "backend": "pi",
        "provider": "openai-codex", "model": CODEX_MODEL,
        "credential_capability": CAPABILITY_ID,
        "orchestration": {"mode": "direct", "ask_manager": False},
        "limits": {
            "max_thread_starts": 0, "max_parent_questions": 0, "max_task_depth": 0,
            "max_tasks": 0, "max_provider_requests": 8, "max_resident_agent_processes": 1,
            "max_cost_usd": "50.00", "deadline_seconds": DEADLINE_SECONDS,
        },
    }


def proxy_spec() -> dict[str, object]:
    return {
        "credential_env": CREDENTIAL_ENV, "bound_source_ip": "127.0.0.1",
        "max_request_cost_usd": "5.00", "input_cost_per_million_usd": "1000000",
        "output_cost_per_million_usd": "1000000",
    }


def lease_echo_document() -> dict[str, object]:
    budget_ms = DEADLINE_SECONDS * 1000
    return {
        "schema_version": LEASE_ECHO_SCHEMA_VERSION, "trial_id": TRIAL_ID,
        "compiled_at_epoch_ms": COMPILED_AT_EPOCH_MS,
        "absolute_epoch_ms": COMPILED_AT_EPOCH_MS + budget_ms,
        "remaining_ms": budget_ms - 5_000,
    }


def drive_row_four_flows(handle, upstream: SyntheticUpstream) -> dict[str, tuple[int, bytes]]:
    """Every flow this row adds, in the one order they can share a route.

    The unaccounted stream deactivates the route by design, so it runs last; the metered call runs
    before it so the export has a request to account for.
    """
    base, token = handle.base_url, handle.dummy_token
    echo_status, echo_body = post_echo(base, token, lease_echo_document())
    calls: dict[str, tuple[int, bytes]] = {
        "lease_echo": (echo_status, json.dumps(echo_body).encode()),
    }

    def call(name: str, **kwargs: object) -> None:
        kwargs.setdefault("target", RESPONSES_PATH)
        kwargs.setdefault("model", CODEX_MODEL)
        calls[name] = proxy_request(base, token, "row-four", **kwargs)

    call("route_denied_token_endpoint", target=TOKEN_PATH)
    call("route_denied_responses_query", target=f"{RESPONSES_PATH}?stream=true")
    call("request_model_mismatch", model="gpt-not-the-frozen-model")
    call("request_body_zstd_undecodable", body=ZSTD_MAGIC + b"not a frame")

    serve_stream(upstream, sse_stream([terminal_event(input_tokens=1, output_tokens=1)]))
    call("metered")
    serve_stream(upstream, sse_stream([{"type": "response.output_text.delta"}], done=False))
    call("budget_accounting_unavailable")
    return calls


def row_four_trial(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Arm through the shipped launcher entry, drive the row's flows, then revoke through the
    shipped revoke — so every file the scan reads was written by the production path."""
    admit_capability(monkeypatch, CAPABILITY_ID, protocol=PROTOCOL)
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    with SyntheticUpstream() as upstream:
        session = arm_trial_proxy(
            arm=row_four_arm(), trial_id=TRIAL_ID, upstream_base_url=upstream.base_url,
            spec=parse_trial_proxy_spec(proxy_spec()), proxy_dir=artifacts / "proxy",
            trial_roots=(artifacts,), environ={CREDENTIAL_ENV: HOST_ACCESS_TOKEN},
        )
        calls = drive_row_four_flows(session.handle, upstream)
        revocation = revoke_trial_proxy(session, capture_inventory=lambda: (
            capture_trial_inventory(sources={}, session=session, trial_roots=(artifacts,))
        ))
    return revocation.inventory, calls


def scan_policy() -> ScanPolicy:
    return ScanPolicy(
        secrets={"provider_credential": HOST_ACCESS_TOKEN},
        repository_checkout=str(Path(__file__).resolve().parents[4]),
        hostname="a-host-name-no-artifact-carries",
    )


def audit_outcomes(inventory) -> list[str]:
    lines = inventory.sources[PROXY_AUDIT_LOG_SOURCE].read_text().splitlines()
    return [json.loads(line).get("outcome") for line in lines if line]


def test_this_rows_flows_reach_the_audit_log_as_distinct_outcomes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The anti-vacuity precondition for everything below: a scan over a log that never recorded
    this row's refusals would be clean because it never looked at them."""
    inventory, calls = row_four_trial(tmp_path, monkeypatch)

    assert calls["lease_echo"][0] == 200
    # The metered call proves the row's own route really is admitted, so the refusals above are
    # refusals of specific flows rather than of everything.
    assert calls["metered"][0] == 200
    assert set(ROW_FOUR_AUDIT_OUTCOMES) <= set(audit_outcomes(inventory))


def test_a_body_refusal_names_the_adapters_reason_in_the_log_and_the_generic_one_on_the_wire(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The two names are not interchangeable, and a scan declaring only the wire one would be
    declaring an outcome the log never carries."""
    inventory, calls = row_four_trial(tmp_path, monkeypatch)
    status, payload = calls["request_model_mismatch"]

    assert (status, json.loads(payload)) == (400, {"error": MODEL_REJECTED_WIRE_REASON})
    assert "request_model_mismatch" in audit_outcomes(inventory)
    assert MODEL_REJECTED_WIRE_REASON not in audit_outcomes(inventory)


def test_the_scan_is_clean_and_looked_at_every_source_this_row_creates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    inventory, _calls = row_four_trial(tmp_path, monkeypatch)

    report = scan_trial_artifacts(inventory, scan_policy())

    assert set(inventory.expected_sources) == set(PROXY_ARTIFACT_SOURCES)
    assert report.clean, report.as_dict()
    scanned = {source.source: source.bytes_scanned for source in report.sources}
    # bytes_scanned is what tells a clean report apart from one that never looked.
    assert all(scanned[source] > 0 for source in PROXY_ARTIFACT_SOURCES), scanned


@pytest.mark.parametrize("source", PROXY_ARTIFACT_SOURCES)
def test_removing_any_source_this_row_creates_fails_the_scan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, source: str,
) -> None:
    inventory, _calls = row_four_trial(tmp_path, monkeypatch)
    inventory.sources[source].unlink()

    report = scan_trial_artifacts(inventory, scan_policy())

    assert not report.clean
    assert report.missing_sources == (source,)
    assert report.exit_code == 1


def test_no_source_this_row_creates_carries_the_host_access_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The refresh credential and the account claim are decoded from the same token the proxy
    injects, so a record that widened to carry either would put it in a trial artifact."""
    inventory, _calls = row_four_trial(tmp_path, monkeypatch)

    for source in PROXY_ARTIFACT_SOURCES:
        payload = inventory.sources[source].read_bytes()
        assert HOST_ACCESS_TOKEN.encode() not in payload, source
