# input:  Docker PI fixture, admitted 65536 cap, synthetic upstream
# output: cap-aligned models.json and proxy traversal proof
# pos:    Real-container regression for PI completion-cap projection
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
from pathlib import Path

import pytest

from cortex_bench_harness.launcher.trial_admission import ADMISSION_EVIDENCE_FILENAME
from cortex_bench_harness.synthetic_deepseek import SyntheticDeepSeekUpstream
from docker_gate import docker_opt_in
from launcher.test_vendor_lifecycle_docker import (
    _campaign_document,
    _install_first_cli_observer,
    _install_scan_environment,
    _run_document,
    _trial_root,
)

pytestmark = docker_opt_in


def _campaign_with_completion_cap(
    root: Path, upstream: str, completion_cap: int,
) -> dict[str, object]:
    document = _campaign_document(root, upstream)
    arm = dict(document["arms"][0])  # type: ignore[index]
    limits = dict(arm["limits"])  # type: ignore[arg-type]
    limits["max_output_tokens"] = completion_cap
    arm["limits"] = limits
    document["arms"] = [arm]
    return document


def _read_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def _proxy_audit(root: Path) -> str:
    return (root / "artifacts/proxy/proxy-audit.jsonl").read_text(
        encoding="utf-8"
    )


def test_pi_65536_cap_reaches_synthetic_upstream_without_cap_mismatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_scan_environment(monkeypatch)
    _install_first_cli_observer(monkeypatch)
    with SyntheticDeepSeekUpstream() as upstream:
        document = _campaign_with_completion_cap(tmp_path, upstream.base_url, 65_536)
        result = _run_document(tmp_path, document)

    assert result["trials"][0]["outcome_state"] == "terminal-success"  # type: ignore[index]
    assert upstream.request_count == 2
    root = _trial_root(tmp_path)
    models = _read_json(root / "agent/trial-home/pi-agent/models.json")
    assert (
        models["providers"]["deepseek"]["models"][0]["maxTokens"]  # type: ignore[index]
        == 65_536
    )
    assert "request_completion_cap_mismatch" not in _proxy_audit(root)
    evidence = _read_json(root / "artifacts" / ADMISSION_EVIDENCE_FILENAME)
    projection = evidence["environment"]["runtime_projection"]  # type: ignore[index]
    assert isinstance(projection, dict)
    assert set(projection["environment"]) == {
        "PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY",
    }
