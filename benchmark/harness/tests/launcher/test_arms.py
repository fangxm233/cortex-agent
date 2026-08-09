# input:  parsed arms, trial pins, trial seed, Harbor config
# output: immutable selection, seed binding, routing, refusal proofs
# pos:    Contract tests for launcher arm construction
# >>> If I am updated, update my header and folder CORTEX.md <<<

import copy
import inspect
from pathlib import Path

import pytest
from harbor.agents.factory import AgentFactory
from harbor.models.trial.config import AgentConfig

from cortex_bench_harness.harbor_agent import CortexBenchAgent
from cortex_bench_harness.launcher.arms import (
    COMPOSABLE_MODES,
    MODE_LIFTING_GATES,
    BackendUnsupportedForKindError,
    ImageDigestUnpinnedError,
    backend_cli_binary,
    build_agent_config,
    require_composable_arm,
    require_pinned_image,
    select_arm,
    select_task,
)

def cortex_arm() -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-arm/2",
        "kind": "cortex",
        "name": "cortex-direct",
        "backend": "claude",
        "provider": "anthropic",
        "model": "claude-sonnet",
        "credential_capability": "claude-api-key",
        "orchestration": {"mode": "direct", "ask_manager": False},
        "limits": {
            "max_thread_starts": 0,
            "max_parent_questions": 0,
            "max_task_depth": 0,
            "max_tasks": 0,
            "max_provider_requests": 8,
            "max_resident_agent_processes": 3,
            "max_cost_usd": "2.50",
            "deadline_seconds": 90,
        },
    }


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


def trial_seed() -> dict[str, object]:
    digest = f"sha256:{'a' * 64}"
    return {
        "arm": cortex_arm(), "arm_path": "arm://cortex-direct",
        "trial_id": "trial-001", "root_run_id": "trial-001.cortex-direct",
        "task": {"task_id": "terminal-task", "image_ref": f"registry.invalid/task@{digest}",
                 "image_digest": digest},
        "profile_name": "benchmark", "paid_run": False,
        "credential": {"upstream_base_url": "https://api.anthropic.com",
                       "route_identity_host": "api.anthropic.com",
                       "proxy_base_url": "http://trial-proxy.invalid",
                       "dummy_token_ref": "offline-token-handle"},
        "model_alias_policy": {"kind": "exact"},
    }


def test_host_agent_config_takes_the_seed_not_a_composed_document() -> None:
    parameters = inspect.signature(build_agent_config).parameters

    assert "trial_seed" in parameters
    assert "arm_resolution" not in parameters
    assert "run_config_projection" not in parameters


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


def test_image_selection_requires_the_reference_to_match_its_digest() -> None:
    digest = f"sha256:{'a' * 64}"
    image_ref = f"registry.invalid/task@{digest}"
    assert require_pinned_image(image_ref, digest) == (image_ref, digest)

    for unpinned_ref, recorded_digest in (
        ("registry.invalid/task:latest", digest),
        (f"registry.invalid/task@sha256:{'b' * 64}", digest),
        (image_ref, ""),
    ):
        with pytest.raises(ImageDigestUnpinnedError) as error:
            require_pinned_image(unpinned_ref, recorded_digest)
        assert error.value.reason == "image_digest_unpinned"


def cortex_config(
    tmp_path: Path,
) -> tuple[AgentConfig, dict[str, object], dict[str, object]]:
    manifest_value = manifest(tmp_path)
    seed = trial_seed()
    config = build_agent_config(
        cortex_arm(), cli_version="2026.8.3",
        artifact_dir=tmp_path / "artifacts", manifest=manifest_value,
        trial_seed=seed,
        env={"ANTHROPIC_BASE_URL": "http://trial-proxy.invalid"},
        override_timeout_sec=90, override_setup_timeout_sec=30,
        max_timeout_sec=120, extra_allowed_hosts=["trial-proxy.invalid"],
    )
    return config, manifest_value, seed


def test_cortex_config_uses_public_import_and_launcher_inputs(tmp_path: Path) -> None:
    config, manifest_value, seed = cortex_config(tmp_path)

    assert config.name is None
    assert config.import_path == "cortex_bench_harness:CortexBenchAgent"
    assert config.model_name == "claude-sonnet"
    assert config.kwargs == {
        "artifact_dir": tmp_path / "artifacts", "manifest": manifest_value,
        "trial_seed": seed, "version": "2026.8.3",
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


def test_cortex_config_rejects_selected_arm_seed_mismatch(tmp_path: Path) -> None:
    seed = trial_seed()
    seed["arm"] = {**cortex_arm(), "name": "different-direct-arm"}

    with pytest.raises(ValueError, match="trial_seed.arm"):
        build_agent_config(
            cortex_arm(), cli_version="2026.8.3",
            artifact_dir=tmp_path / "artifacts", manifest=manifest(tmp_path),
            trial_seed=seed,
        )


def build_unsupported(tmp_path: Path, arm: dict[str, object]) -> AgentConfig:
    return build_agent_config(
        arm, cli_version="2026.8.3", artifact_dir=tmp_path / "artifacts",
        manifest=manifest(tmp_path), trial_seed=trial_seed(),
    )


@pytest.mark.parametrize("ask_manager", [False, True])
@pytest.mark.parametrize("backend", ["claude", "pi"])
def test_manager_bootstrap_arms_compose_on_both_backends(
    tmp_path: Path, backend: str, ask_manager: bool,
) -> None:
    arm = copy.deepcopy(cortex_arm())
    arm["name"] = f"cortex-{backend}-manager-qa-{'on' if ask_manager else 'off'}"
    arm["backend"] = backend
    arm["orchestration"] = {"mode": "manager", "ask_manager": ask_manager}
    arm["limits"] = {
        **arm["limits"],
        "max_thread_starts": 1,
        "max_parent_questions": 2 if ask_manager else 0,
        "max_task_depth": 2,
        "max_tasks": 8,
    }
    seed = {**trial_seed(), "arm": copy.deepcopy(arm)}

    config = build_agent_config(
        arm, cli_version="2026.8.3", artifact_dir=tmp_path / "artifacts",
        manifest=manifest(tmp_path), trial_seed=seed,
    )

    assert isinstance(config, AgentConfig)
    assert config.kwargs["trial_seed"]["arm"]["orchestration"] == {
        "mode": "manager", "ask_manager": ask_manager,
    }
    assert backend_cli_binary(arm) == backend


# Design section 3.1(h.5) row 2 lifts at this gate, and RB6 makes the lift's BOUNDS a done-when
# rather than a nicety: a test that only proves the new pairs compose is half a test.
@pytest.mark.parametrize("variant", ["audit-retry", "reviewer-fix"])
@pytest.mark.parametrize("backend", ["claude", "pi"])
def test_coder_review_arms_compose_on_both_backends(
    tmp_path: Path, backend: str, variant: str,
) -> None:
    arm = copy.deepcopy(cortex_arm())
    arm["name"] = f"cortex-{backend}-{variant}"
    arm["backend"] = backend
    arm["orchestration"] = {
        "mode": "coder-review", "coder_review_variant": variant, "ask_manager": False,
    }
    arm["limits"] = {**arm["limits"], "max_thread_starts": 1}
    seed = {**trial_seed(), "arm": copy.deepcopy(arm)}

    config = build_agent_config(
        arm, cli_version="2026.8.3", artifact_dir=tmp_path / "artifacts",
        manifest=manifest(tmp_path), trial_seed=seed,
    )

    assert isinstance(config, AgentConfig)
    assert backend_cli_binary(arm) == backend


def test_every_declared_cortex_mode_is_composable() -> None:
    assert MODE_LIFTING_GATES == {}
    assert COMPOSABLE_MODES == frozenset({"direct", "coder-review", "manager"})


def test_vendor_baselines_are_unaffected_by_the_mode_lift(tmp_path: Path) -> None:
    # RB6's other half: a baseline declares no orchestration at all, so a change to which modes
    # compose must leave it exactly where it was.
    arm = baseline_arm("claude-code")

    config = build_agent_config(
        arm, cli_version="2026.8.3", artifact_dir=tmp_path / "artifacts",
        manifest=manifest(tmp_path),
    )

    assert isinstance(config, AgentConfig)
    with pytest.raises(ValueError, match="Cortex arm"):
        require_composable_arm(arm)


def test_pi_backed_direct_arms_compose_on_the_host(tmp_path: Path) -> None:
    arm = copy.deepcopy(cortex_arm())
    arm["name"] = "cortex-pi-direct"
    arm["backend"] = "pi"
    seed = {**trial_seed(), "arm": copy.deepcopy(arm)}

    config = build_agent_config(
        arm, cli_version="2026.8.3", artifact_dir=tmp_path / "artifacts",
        manifest=manifest(tmp_path), trial_seed=seed,
    )

    assert config.import_path == "cortex_bench_harness:CortexBenchAgent"
    assert config.kwargs["trial_seed"]["arm"]["backend"] == "pi"
    assert backend_cli_binary(arm) == "pi"


def test_undeclared_backends_still_refuse_on_the_host(tmp_path: Path) -> None:
    # The refusal must outlive the backends it was written for: a backend with no CLI binary
    # declaration falls through to the generic gate wording rather than composing.
    arm = copy.deepcopy(cortex_arm())
    arm["name"] = "cortex-unknown-direct"
    arm["backend"] = "unknown-backend"

    with pytest.raises(BackendUnsupportedForKindError) as error:
        build_unsupported(tmp_path, arm)

    assert error.value.reason == "backend_unsupported_for_kind"
    assert "cortex-unknown-direct" in str(error.value)
    assert "its owning gate" in str(error.value)


def test_vendor_baselines_need_no_seed_and_no_composition(tmp_path: Path) -> None:
    config = build_agent_config(baseline_arm("claude-code"), cli_version="1.2.3")

    assert config.kwargs == {"version": "1.2.3"}
    assert config.import_path is None


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
