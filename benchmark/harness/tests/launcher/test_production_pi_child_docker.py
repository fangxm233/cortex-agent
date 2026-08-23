# input:  production Cortex package, two coder-review bundles, synthetic DeepSeek
# output: real child-stage cap preservation with zero paid provider traffic
# pos:    Docker gate for production PI multi-stage child execution
# >>> If I am updated, update my header and folder CORTEX.md <<<

import argparse
import json
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
CAP = 65_536
PRODUCTION_IMAGE = (
    "cortex-terminal-bench-2.1:constraints-scheduling-cortex-pi-0.82.1@"
    "sha256:6cad45f1f79e0c178d4b23ec1c930179d7d5dba2e0bdf27900dfc29c6a1bd04c"
)
CASES = (
    (
        "zero-paid-production-coder-review.yaml",
        "benchmark-coder-review",
        ("benchmark-coder", "benchmark-reviewer", "benchmark-coder", "benchmark-reviewer"),
        5,
    ),
    (
        "zero-paid-production-coder-review-fix.yaml",
        "benchmark-coder-review-fix",
        ("benchmark-coder", "benchmark-fixer"),
        3,
    ),
)


@pytest.fixture(scope="module")
def production_artifacts(tmp_path_factory: pytest.TempPathFactory) -> Mapping[str, Path]:
    root = tmp_path_factory.mktemp("production-child-artifacts")
    return {
        "npm": build_offline_npm_artifact(REPO_ROOT, root / "npm"),
        "wheel": build_harness_wheel(HARNESS_ROOT),
    }


def _write_task(root: Path) -> Path:
    task = root / "task"
    tests = task / "tests"
    tests.mkdir(parents=True)
    (task / "instruction.md").write_text(
        "Write the exact text `one` into `/tmp/answer.txt`.\n", encoding="utf-8",
    )
    (task / "task.toml").write_text(
        "[environment]\n"
        f"docker_image = {json.dumps(PRODUCTION_IMAGE)}\n"
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
    root: Path, source_name: str, upstream: str, artifacts: Mapping[str, Path],
) -> dict[str, object]:
    document = yaml.safe_load((CAMPAIGNS_ROOT / source_name).read_text(encoding="utf-8"))
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
        "task_id": "one", "path": str(_write_task(root)),
        "image_ref": PRODUCTION_IMAGE,
    }]
    document["timeouts"] = {"agent_seconds": 240, "verifier_seconds": 30}
    return document


def _write_catalog_refresh(root: Path) -> None:
    stores = list((root / "trials").glob(
        "*/agent/production-cortex-home/data/pi/models-store.json",
    ))
    assert len(stores) == 1
    refreshed = stores[0].with_name(".models-store-refresh.json")
    refreshed.write_text(json.dumps({
        "deepseek": {
            "checkedAt": 1,
            "models": [{
                "id": "deepseek-v4-flash", "name": "deepseek-v4-flash",
                "api": "openai-completions", "provider": "deepseek",
                "baseUrl": "https://api.deepseek.com/v1", "reasoning": True,
                "input": ["text"],
                "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                "contextWindow": 128_000, "maxTokens": 32_768,
                "compat": {
                    "supportsDeveloperRole": False,
                    "maxTokensField": "max_tokens",
                },
            }],
        },
    }), encoding="utf-8")
    refreshed.replace(stores[0])


def _trial_root(root: Path) -> Path:
    trials = [path for path in (root / "trials").iterdir() if path.is_dir()]
    assert len(trials) == 1
    return trials[0]


def _json_lines(path: Path) -> list[dict[str, object]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


@pytest.mark.parametrize(
    ("campaign_name", "expected_template", "expected_roles", "expected_requests"),
    CASES,
    ids=["audit-retry", "reviewer-fix"],
)
def test_real_production_child_preserves_frozen_cap_across_catalog_refresh(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    production_artifacts: Mapping[str, Path], campaign_name: str,
    expected_template: str, expected_roles: tuple[str, ...], expected_requests: int,
) -> None:
    _install_scan_environment(monkeypatch)
    refreshed = False

    def refresh_after_root_request(count: int, _request: Mapping[str, object]) -> None:
        nonlocal refreshed
        if count == 1:
            _write_catalog_refresh(tmp_path)
            refreshed = True

    with SyntheticDeepSeekUpstream(request_hook=refresh_after_root_request) as upstream:
        document = _campaign_document(
            tmp_path, campaign_name, upstream.base_url, production_artifacts,
        )
        config = tmp_path / "campaign.yaml"
        config.write_text(yaml.safe_dump(document), encoding="utf-8")
        result = campaign.run(argparse.Namespace(config=str(config), dry_run=False))
        request_count = upstream.request_count

    assert refreshed is True
    assert result["trials"][0]["outcome_state"] == "terminal-success"
    assert result["trials"][0]["verifier_rewards"] == {"reward": 1.0}
    assert request_count == expected_requests

    trial = _trial_root(tmp_path)
    audit = _json_lines(trial / "artifacts/proxy/proxy-audit.jsonl")
    assert sum(item.get("outcome") == "request_completion_cap_conflict" for item in audit) == 0
    assert sum(item["upstream_model"] is not None for item in audit) == expected_requests

    pi_dir = trial / "agent/production-cortex-home/data/pi"
    stored = json.loads((pi_dir / "models-store.json").read_text(encoding="utf-8"))
    assert stored["deepseek"]["models"][0]["compat"]["maxTokensField"] == "max_tokens"
    generated = json.loads((pi_dir / "models.json").read_text(encoding="utf-8"))
    provider = generated["providers"]["deepseek"]
    assert provider["compat"]["maxTokensField"] == "max_completion_tokens"
    assert provider["modelOverrides"]["deepseek-v4-flash"]["maxTokens"] == CAP

    identities = _json_lines(
        trial / "agent/production-cortex-home/data/benchmark-attempt-identities.jsonl",
    )
    assert tuple(item["role"] for item in identities) == expected_roles
    assert all(item["template"] == expected_template for item in identities)
