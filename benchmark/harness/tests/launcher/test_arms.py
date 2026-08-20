# input:  parsed arms, trial pins, trial seed, Harbor config
# output: immutable selection, seed binding, routing, refusal proofs
# pos:    Contract tests for launcher arm construction
# >>> If I am updated, update my header and folder CORTEX.md <<<

import copy
from pathlib import Path

import pytest

from cortex_bench_harness.launcher.arms import (
    BackendUnsupportedForKindError,
    ImageDigestUnpinnedError,
    backend_cli_binary,
    build_agent_config,
    require_pinned_image,
    select_arm,
    select_task,
)

def cortex_arm() -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-arm/2",
        "kind": "cortex",
        "name": "cortex-direct",
        "backend": "pi",
        "provider": "deepseek",
        "model": "deepseek-v4-flash",
        "credential_capability": "pi-deepseek-api-key",
        "orchestration": {"mode": "direct", "ask_manager": False},
        "limits": {
            "max_provider_requests": 8,
            "max_cost_usd": "2.50",
            "deadline_seconds": 90,
            "max_output_tokens": 65536,
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


def baseline_arm(
    vendor_agent: str, provider: str | None = None, vendor_cli_version: str = "1.2.3",
) -> dict[str, object]:
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
        "vendor_cli_version": vendor_cli_version,
        "provider": provider,
        "model": "representative-model",
        "credential_capability": capabilities[vendor_agent],
        "limits": {
            "max_provider_requests": 8,
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
        "credential": {"upstream_base_url": "https://api.deepseek.com",
                       "route_identity_host": "api.deepseek.com",
                       "proxy_base_url": "http://trial-proxy.invalid",
                       "dummy_token_ref": "offline-token-handle"},
        "model_alias_policy": {"kind": "exact"},
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


def test_cortex_config_carries_only_a_nonsecret_credential_handle(tmp_path: Path) -> None:
    manifest_value = manifest(tmp_path)
    seed = trial_seed()
    config = build_agent_config(
        cortex_arm(), cli_version="2026.8.3", artifact_dir=tmp_path / "artifacts",
        manifest=manifest_value, trial_seed=seed, credential_handle="vault-handle-1",
    )
    assert config.kwargs["credential_handle"] == "vault-handle-1"
    assert "credential" not in config.kwargs


def test_cortex_config_rejects_selected_arm_seed_mismatch(tmp_path: Path) -> None:
    seed = trial_seed()
    seed["arm"] = {**cortex_arm(), "name": "different-direct-arm"}

    with pytest.raises(ValueError, match="trial_seed.arm"):
        build_agent_config(
            cortex_arm(), cli_version="2026.8.3",
            artifact_dir=tmp_path / "artifacts", manifest=manifest(tmp_path),
            trial_seed=seed,
        )


def test_pi_backed_direct_arms_compose_on_the_host(tmp_path: Path) -> None:
    arm = copy.deepcopy(cortex_arm())
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
        backend_cli_binary(arm)

    assert error.value.reason == "backend_unsupported_for_kind"
    assert "cortex-unknown-direct" in str(error.value)
    assert "its owning gate" in str(error.value)
