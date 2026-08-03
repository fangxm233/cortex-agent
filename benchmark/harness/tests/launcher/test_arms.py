# input:  parsed arm sets, compiled run-config projection, Harbor config
# output: immutable selection, image pin, and kind-routing assertions
# pos:    Contract tests for launcher arm construction
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
from pathlib import Path

import pytest
from harbor.agents.factory import AgentFactory
from harbor.models.trial.config import AgentConfig

from cortex_bench_harness.harbor_agent import CortexBenchAgent
from cortex_bench_harness.launcher.arms import (
    ImageDigestUnpinnedError,
    build_agent_config,
    require_pinned_image,
    select_arm,
    select_task,
)

REPO_ROOT = Path(__file__).resolve().parents[4]
GOLDEN_RUN_CONFIG = REPO_ROOT / "agent-server/tests/benchmark-resolved-run-config.golden.json"


def golden_projection() -> dict[str, object]:
    return json.loads(GOLDEN_RUN_CONFIG.read_text())


def cortex_arm() -> dict[str, object]:
    return golden_projection()["bundle"]["run_config"]  # type: ignore[index,return-value]


def manifest(tmp_path: Path) -> dict[str, object]:
    files = {
        "wheel_path": tmp_path / "harness.whl",
        "lockfile_path": tmp_path / "uv.lock",
        "npm_artifact_path": tmp_path / "server.tgz",
    }
    for file in files.values():
        file.write_bytes(b"fixture")
    return {
        "root_run_id": "trial-001.cortex-direct",
        "trial_id": "trial-001",
        "arm": "cortex-direct",
        **{name: str(file) for name, file in files.items()},
        "lockfile_manifest_path": "benchmark/harness/uv.lock",
        "image_ref": f"registry.invalid/task@sha256:{'a' * 64}",
        "image_digest": f"sha256:{'a' * 64}",
        "image_size_bytes": 1024,
    }


def baseline_arm(vendor_agent: str, provider: str | None = None) -> dict[str, object]:
    capabilities = {
        "claude-code": "claude-api-key",
        "pi": "pi-api-key",
        "codex": "codex-subscription",
    }
    return {
        "schema_version": "cortex-benchmark-arm/2",
        "kind": "vendor-baseline",
        "name": f"pure-{vendor_agent}",
        "vendor_agent": vendor_agent,
        "provider": provider,
        "model": "representative-model",
        "credential_capability": capabilities[vendor_agent],
        "limits": {
            "max_thread_starts": 0,
            "max_parent_questions": 0,
            "max_task_depth": 0,
            "max_tasks": 0,
            "max_provider_requests": 8,
            "max_resident_agent_processes": 1,
            "max_cost_usd": "2.50",
            "deadline_seconds": 90,
        },
    }


def test_select_arm_is_explicit_unique_and_immutable() -> None:
    selected = select_arm([cortex_arm(), baseline_arm("codex")], "cortex-direct")

    assert selected["name"] == "cortex-direct"
    with pytest.raises(TypeError):
        selected["name"] = "changed"  # type: ignore[index]
    with pytest.raises(LookupError, match="missing"):
        select_arm([cortex_arm()], "missing")
    with pytest.raises(ValueError, match="unique"):
        select_arm([cortex_arm(), cortex_arm()], "cortex-direct")


def test_select_task_requires_one_explicit_identifier() -> None:
    tasks = [{"task_id": "terminal-task-a"}, {"task_id": "terminal-task-b"}]

    selected = select_task(tasks, "terminal-task-b")
    assert selected["task_id"] == "terminal-task-b"
    with pytest.raises(LookupError, match="missing"):
        select_task(tasks, "missing")


def test_image_selection_requires_a_sha256_digest() -> None:
    digest = f"sha256:{'a' * 64}"
    assert require_pinned_image("registry.invalid/task:latest", digest) == (
        "registry.invalid/task:latest", digest,
    )

    with pytest.raises(ImageDigestUnpinnedError) as error:
        require_pinned_image("registry.invalid/task:latest", "")
    assert error.value.reason == "image_digest_unpinned"


def cortex_config(tmp_path: Path) -> tuple[AgentConfig, dict[str, object], dict[str, object]]:
    projection = golden_projection()
    manifest_value = manifest(tmp_path)
    config = build_agent_config(
        cortex_arm(), cli_version="2026.8.3",
        artifact_dir=tmp_path / "artifacts", manifest=manifest_value,
        run_config_projection=projection,
        env={"ANTHROPIC_BASE_URL": "http://trial-proxy.invalid"},
        override_timeout_sec=90, override_setup_timeout_sec=30,
        max_timeout_sec=120, extra_allowed_hosts=["trial-proxy.invalid"],
    )
    return config, projection, manifest_value


def test_cortex_config_uses_public_import_and_compiled_projection(tmp_path: Path) -> None:
    config, projection, manifest_value = cortex_config(tmp_path)

    assert config.name is None
    assert config.import_path == "cortex_bench_harness:CortexBenchAgent"
    assert config.model_name == "claude-sonnet"
    assert config.kwargs == {
        "artifact_dir": tmp_path / "artifacts", "manifest": manifest_value,
        "run_config": projection, "version": "2026.8.3",
    }
    assert config.env == {"ANTHROPIC_BASE_URL": "http://trial-proxy.invalid"}
    assert config.extra_allowed_hosts == ["trial-proxy.invalid"]
    assert config.override_timeout_sec == 90
    assert config.override_setup_timeout_sec == 30
    assert config.max_timeout_sec == 120


def test_harbor_factory_constructs_the_public_cortex_agent(tmp_path: Path) -> None:
    config, _, _ = cortex_config(tmp_path)
    agent = AgentFactory.create_agent_from_config(config, logs_dir=tmp_path / "logs")

    assert isinstance(agent, CortexBenchAgent)


@pytest.mark.parametrize(
    ("vendor_agent", "provider", "expected_model"),
    [
        ("claude-code", None, "representative-model"),
        ("pi", "openai", "openai/representative-model"),
        ("codex", None, "representative-model"),
    ],
)
def test_vendor_config_routes_by_harbor_name_without_cortex_kwargs(
    tmp_path: Path,
    vendor_agent: str,
    provider: str | None,
    expected_model: str,
) -> None:
    config = build_agent_config(
        baseline_arm(vendor_agent, provider),
        cli_version="1.2.3",
        env={"BASE_URL": "http://trial-proxy.invalid"},
    )

    agent = AgentFactory.create_agent_from_config(
        config, logs_dir=tmp_path / vendor_agent,
    )
    assert config.name == vendor_agent
    assert config.import_path is None
    assert config.model_name == expected_model
    assert config.kwargs == {"version": "1.2.3"}
    assert agent.name() == vendor_agent
