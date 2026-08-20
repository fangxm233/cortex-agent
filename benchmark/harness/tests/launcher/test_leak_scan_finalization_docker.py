# input:  real Docker vendor lifecycle and verifier-created uvx alias
# output: clean gradable outer-envelope publication proof
# pos:    Real-container regression for leak-scan finalization
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
import uuid
from pathlib import Path

import pytest

import test_vendor_lifecycle_docker as lifecycle
from docker_gate import docker_opt_in

pytestmark = docker_opt_in

VERIFIER_WITH_UVX_ALIAS = (
    "#!/bin/sh\nset -eu\n"
    "test \"$(cat /tmp/answer.txt)\" = one\n"
    "mkdir -p /logs/agent/trial-home/home/.local/bin\n"
    "ln -sf /opt/terminal-bench-verifier/bin/uvx "
    "/logs/agent/trial-home/home/.local/bin/uvx\n"
    "printf '1\\n' > /logs/verifier/reward.txt\n"
)


def _read_envelope(root: Path, trial_id: str) -> dict[str, object]:
    path = (
        root / "trials" / trial_id / "artifacts"
        / lifecycle.OUTER_ENVELOPE_FILENAME
    )
    return json.loads(path.read_text())


def _assert_clean_without_alias(envelope: dict[str, object]) -> None:
    scan = envelope["leak_scan"]
    assert isinstance(scan, dict)
    assert scan["clean"] is True
    assert scan["matches"] == []
    assert scan["missing_sources"] == []
    assert scan["unclassified_files"] == []
    evidence = envelope["evidence"]
    assert isinstance(evidence, dict)
    assert not any(
        item["relative_path"] == "trial-home/home/.local/bin/uvx"
        for item in evidence["files"]
    )


def test_real_docker_zero_paid_trial_publishes_after_verifier_alias_cleanup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    lifecycle._install_scan_environment(monkeypatch)
    lifecycle._install_first_cli_observer(monkeypatch)
    counts = lifecycle._track_routes(monkeypatch)
    with lifecycle.SyntheticDeepSeekUpstream() as upstream:
        document = lifecycle._campaign_document(
            tmp_path, upstream.base_url, verifier=VERIFIER_WITH_UVX_ALIAS,
        )
        task = document["tasks"][0]
        assert isinstance(task, dict)
        task["task_id"] = f"leak-scan-{uuid.uuid4().hex[:12]}"
        result = lifecycle._run_document(tmp_path, document)

    assert counts["arm"] <= 1, result
    assert counts["revoke"] == 1, result
    trial = result["trials"][0]
    assert trial["outcome_state"] == "terminal-success"
    assert trial["verifier_rewards"] == {"reward": 1.0}
    assert isinstance(trial["trial_id"], str)
    _assert_clean_without_alias(_read_envelope(tmp_path, trial["trial_id"]))
