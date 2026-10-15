import argparse
import json
import os
import uuid
from collections.abc import Mapping
from pathlib import Path

import pytest
import yaml

from cortex_bench_harness import campaign
from cortex_bench_harness.artifact_build import (
    build_harness_wheel,
    build_offline_npm_artifact,
)
from cortex_bench_harness.synthetic_deepseek import SyntheticDeepSeekUpstream
from docker_gate import docker_opt_in

pytestmark = docker_opt_in

REPO_ROOT = Path(__file__).resolve().parents[4]
HARNESS_ROOT = REPO_ROOT / "benchmark/harness"
CAMPAIGNS_ROOT = REPO_ROOT / "benchmark/campaigns"
CAMPAIGN = "zero-paid-production-direct.yaml"
CAP = 65_536
# The synthetic upstream answers the task with one `write` call, then closes the turn on the
# tool result: one session, one run, two provider requests.
EXPECTED_REQUESTS = 2
# The campaign pins the runtime image its own host built. Another host builds the same inputs with
# `scripts/build-zero-paid-runtime-image.sh`, gets its own digest, and names that image here.
IMAGE_REF_ENV = "CORTEX_BENCH_DIRECT_IMAGE_REF"


@pytest.fixture(scope="module")
def production_artifacts(tmp_path_factory: pytest.TempPathFactory) -> Mapping[str, Path]:
    root = tmp_path_factory.mktemp("production-direct-artifacts")
    return {
        "npm": build_offline_npm_artifact(REPO_ROOT, root / "npm"),
        "wheel": build_harness_wheel(HARNESS_ROOT),
    }


def _write_task(root: Path, image_ref: str) -> Path:
    task = root / "task"
    tests = task / "tests"
    tests.mkdir(parents=True)
    (task / "instruction.md").write_text(
        "Write the exact text `one` into `/tmp/answer.txt`.\n", encoding="utf-8",
    )
    (task / "task.toml").write_text(
        "[environment]\n"
        f"docker_image = {json.dumps(image_ref)}\n"
        'network_mode = "public"\n'
        'os = "linux"\n\n'
        "[agent]\n"
        "timeout_sec = 240\n\n"
        "[verifier]\n"
        "timeout_sec = 30\n",
        encoding="utf-8",
    )
    verifier = tests / "test.sh"
    verifier.write_text(
        "#!/bin/sh\nset -eu\n"
        'test "$(cat /tmp/answer.txt)" = one\n'
        "printf '1\\n' > /logs/verifier/reward.txt\n",
        encoding="utf-8",
    )
    verifier.chmod(0o755)
    return task


def _install_scan_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    values = {
        "CORTEX_BENCH_ZERO_PAID_CREDENTIAL": "synthetic-only-credential",
        "CORTEX_BENCH_ZERO_PAID_FORBIDDEN": "forbidden-environment-literal",
        "CORTEX_BENCH_ZERO_PAID_FORBIDDEN_ARGV": "forbidden-argv-literal",
        "CORTEX_BENCH_ZERO_PAID_CHECKOUT": "/private/production-child-checkout",
        "CORTEX_BENCH_ZERO_PAID_IDENTITY": "private-production-child-machine",
    }
    for key, value in values.items():
        monkeypatch.setenv(key, value)


def _campaign_document(
    root: Path, upstream: str, artifacts: Mapping[str, Path],
) -> dict[str, object]:
    document = yaml.safe_load((CAMPAIGNS_ROOT / CAMPAIGN).read_text(encoding="utf-8"))
    image_ref = os.environ.get(IMAGE_REF_ENV) or document["tasks"][0]["image_ref"]
    document["campaign"] = f"pc-{uuid.uuid4().hex[:6]}"
    document["trials_dir"] = str(root / "trials")
    document["network"] = {"mode": "filtered"}
    subnet = uuid.uuid4().int % 512
    document["docker_network"] = {
        "subnet_pool": f"10.{64 + subnet // 256}.{subnet % 256}.0/24",
        "subnet_prefix": 24,
    }
    document["credential"]["upstream_base_url"] = upstream
    document["manifest"] = {
        "wheel_path": str(artifacts["wheel"]),
        "npm_artifact_path": str(artifacts["npm"]),
        "lockfile_path": str(HARNESS_ROOT / "uv.lock"),
        "lockfile_manifest_path": "benchmark/harness/uv.lock",
    }
    arm = document["arms"][0]
    arm["limits"] = {
        "max_provider_requests": 12, "max_cost_usd": "0.01",
        "deadline_seconds": 180, "max_output_tokens": CAP,
    }
    document["tasks"] = [{
        "task_id": "one", "path": str(_write_task(root, image_ref)), "image_ref": image_ref,
    }]
    document["timeouts"] = {"agent_seconds": 240, "verifier_seconds": 30}
    return document


def _trial_root(root: Path) -> Path:
    trials = [path for path in (root / "trials").iterdir() if path.is_dir()]
    assert len(trials) == 1
    return trials[0]


def _json_lines(path: Path) -> list[dict[str, object]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def test_real_production_direct_trial_runs_one_session_and_exports_its_evidence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    production_artifacts: Mapping[str, Path],
) -> None:
    _install_scan_environment(monkeypatch)

    with SyntheticDeepSeekUpstream() as upstream:
        document = _campaign_document(tmp_path, upstream.base_url, production_artifacts)
        config = tmp_path / "campaign.yaml"
        config.write_text(yaml.safe_dump(document), encoding="utf-8")
        result = campaign.run(argparse.Namespace(config=str(config), dry_run=False))
        request_count = upstream.request_count

    assert result["trials"][0]["outcome_state"] == "terminal-success"
    assert result["trials"][0]["verifier_rewards"] == {"reward": 1.0}
    assert request_count == EXPECTED_REQUESTS

    trial = _trial_root(tmp_path)
    audit = _json_lines(trial / "artifacts/proxy/proxy-audit.jsonl")
    assert sum(item.get("outcome") == "request_completion_cap_conflict" for item in audit) == 0
    assert sum(item["upstream_model"] is not None for item in audit) == EXPECTED_REQUESTS

    pi_dir = trial / "agent/production-cortex-home/data/pi"
    generated = json.loads((pi_dir / "models.json").read_text(encoding="utf-8"))
    provider = generated["providers"]["deepseek"]
    assert provider["modelOverrides"]["deepseek-v4-flash"]["maxTokens"] == CAP

    identities = _json_lines(
        trial / "agent/production-cortex-home/data/benchmark-attempt-identities.jsonl",
    )
    assert len(identities) == 1
    identity = identities[0]
    assert identity["schema_version"] == "cortex-production-attempt-identity/5"
    assert identity["thinking"] == "off"
    assert identity["mode"] == "trial"
    assert identity["session_id"]
    assert identity["spawn_parent_attempt_id"] is None
    assert "thread_id" not in identity and "role" not in identity

    trajectory = trial / "agent/trajectory"
    composite = json.loads((trajectory / "composite-manifest.json").read_text(encoding="utf-8"))
    assert composite["schema_version"] == "cortex-bench-composite-manifest/3"
    assert composite["predicate"]["mode"] == "direct"
    assert [node["session_id"] for node in composite["nodes"]] == [identity["session_id"]]
    assert [node["execution_id"] for node in composite["nodes"]] == [identity["execution_id"]]
    header = _json_lines(trajectory / "events.jsonl")[0]
    assert header["schema_version"] == "cortex-bench-journal/2"
    assert header["session_id"] == identity["session_id"]
    assert header["resolved_cwd"] == "/app"
