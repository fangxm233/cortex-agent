# input:  H3 manifest file and live trial proxy handle
# output: exact credential-free proxy block assertions
# pos:    Proxy manifest integration test
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

from cortex_bench_harness.proxy import ProxyBudget, fill_proxy_manifest, start_trial_proxy
from synthetic import SyntheticUpstream

REAL_CREDENTIAL = "sk-ant-SYNTHETIC-MANIFEST-UNIQUE"


def test_fills_h3_proxy_block_without_credentials(tmp_path: Path) -> None:
    manifest_path = tmp_path / "cortex-bench-harness-manifest.json"
    manifest_path.write_text(json.dumps(_base_manifest()))
    deadline = datetime(2099, 1, 2, 3, 4, 5, tzinfo=UTC)
    with SyntheticUpstream() as upstream:
        handle = _start_proxy(tmp_path, upstream.base_url, deadline)
        try:
            document = fill_proxy_manifest(manifest_path, handle)
        finally:
            handle.stop()
    assert document["proxy"] == _expected_block(handle, upstream.base_url)
    persisted = manifest_path.read_bytes()
    assert json.loads(persisted) == document
    assert REAL_CREDENTIAL.encode() not in persisted
    assert handle.dummy_token.encode() not in persisted


def _base_manifest() -> dict[str, object]:
    return {
        "schema_version": "cortex-bench-harness-manifest/1",
        "trial_id": "trial-manifest",
        "proxy": None,
    }


def _start_proxy(tmp_path: Path, upstream_url: str, deadline: datetime):
    budget = ProxyBudget(
        Decimal("5"), Decimal("5"), Decimal("1000000"), Decimal("2000000"),
    )
    return start_trial_proxy(
        trial_id="trial-manifest", upstream_base_url=upstream_url,
        real_credential=REAL_CREDENTIAL, bound_source_ip="127.0.0.1",
        absolute_deadline=deadline, budget=budget,
        log_path=tmp_path / "proxy.jsonl",
    )


def _expected_block(handle, upstream_url: str) -> dict[str, object]:
    return {
        "schema_version": "cortex-bench-trial-proxy/1",
        "base_url": handle.base_url,
        "upstream_base_url": upstream_url,
        "source_binding": {"kind": "ip", "value": "127.0.0.1"},
        "budget": {
            "max_cost_usd": "5",
            "max_request_cost_usd": "5",
            "input_cost_per_million_usd": "1000000",
            "output_cost_per_million_usd": "2000000",
        },
        "absolute_deadline": "2099-01-02T03:04:05Z",
        "log_filename": "proxy.jsonl",
    }
