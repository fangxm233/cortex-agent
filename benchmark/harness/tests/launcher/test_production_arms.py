import json
from pathlib import Path

import pytest

from cortex_bench_harness.launcher.production_arms import (
    PRODUCTION_ARM_BUNDLES,
    ProductionArmError,
    production_arm_bundle,
    production_arm_candidate,
    require_production_arm,
    resolve_production_arm,
)

EXECUTION_LIMITS = {
    "max_provider_requests": 200, "max_cost_usd": "2.00",
    "deadline_seconds": 1800, "max_output_tokens": 65536,
}


def arm(
    orchestration: dict[str, object],
    **overrides: object,
) -> dict[str, object]:
    value: dict[str, object] = {
        "schema_version": "cortex-benchmark-arm/2", "kind": "cortex",
        "name": "an-arm", "backend": "pi", "provider": "deepseek",
        "model": "deepseek-v4-flash", "credential_capability": "pi-deepseek-api-key",
        "orchestration": orchestration,
        "limits": dict(EXECUTION_LIMITS),
    }
    value.update(overrides)
    return value


def direct_arm(**overrides: object) -> dict[str, object]:
    return arm({"mode": "direct", "ask_manager": False}, **overrides)


def direct_codex_arm(**overrides: object) -> dict[str, object]:
    return arm(
        {"mode": "direct", "ask_manager": False},
        provider="openai-codex",
        model="gpt-5.6-sol",
        credential_capability="pi-openai-codex-oauth",
        **overrides,
    )


def read_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def test_direct_arm_resolves_to_the_committed_direct_bundle() -> None:
    bundle = require_production_arm(direct_arm())

    assert bundle.key == "direct-pi-deepseek"
    assert bundle.bundle_dir.name == "cortex-home"
    assert bundle.environment == "main"
    assert bundle.profile_name == "direct"
    assert bundle.thinking == "off"


def test_direct_openai_codex_arm_resolves_to_its_committed_bundle() -> None:
    bundle = require_production_arm(direct_codex_arm())

    assert bundle.key == "direct-pi-openai-codex"
    assert bundle.bundle_dir.name == "cortex-home"
    assert bundle.environment == "main"
    assert bundle.profile_name == "direct"
    assert bundle.provider == "openai-codex"
    assert bundle.model == "gpt-5.6-sol"
    assert bundle.credential_capability == "pi-openai-codex-oauth"
    assert bundle.thinking == "xhigh"
    assert bundle.bundle_dir != require_production_arm(direct_arm()).bundle_dir


@pytest.mark.parametrize("orchestration", [
    {"mode": "coder-review", "coder_review_variant": "audit-retry", "ask_manager": False},
    {"mode": "coder-review", "coder_review_variant": "reviewer-fix", "ask_manager": False},
    {"mode": "manager", "ask_manager": False},
    {"mode": "manager", "ask_manager": True},
    {"mode": "direct", "ask_manager": True},
])
def test_only_the_direct_orchestration_is_a_production_arm(
    orchestration: dict[str, object],
) -> None:
    other = arm(orchestration)

    assert production_arm_candidate(other) is None
    with pytest.raises(ProductionArmError, match="committed PI arm"):
        require_production_arm(other)


def test_every_arm_records_the_one_session_endpoint_it_needs_open() -> None:
    for bundle in PRODUCTION_ARM_BUNDLES:
        assert bundle.confinement_record() == {
            "webhook_endpoints": ["POST /webhook/benchmark-session"],
        }
        assert bundle.attested_record() == {
            "key": bundle.key, "profile_name": "direct", "environment": "main",
        }


def test_a_non_pi_deepseek_arm_is_not_a_production_candidate() -> None:
    claude = direct_arm(backend="claude")

    assert production_arm_candidate(claude) is None
    assert resolve_production_arm(claude) is None


def test_an_unknown_bundle_key_is_refused() -> None:
    with pytest.raises(ProductionArmError, match="bundle"):
        production_arm_bundle("no-such-bundle")


def test_every_bundle_exposes_only_its_normal_named_environment_surface() -> None:
    for bundle in PRODUCTION_ARM_BUNDLES:
        home = bundle.bundle_dir
        config = sorted(path.relative_to(home / "config").as_posix()
                        for path in (home / "config").rglob("*") if path.is_file())
        assert config == [
            "environments/main.json", "machines.json", "profiles.json", "settings.json",
        ]
        surface_files = [
            *(home / "config/environments").glob("*.json"),
            *(home / "prompts/directives").glob("*.md"),
            *(home / "prompts/systemPrompts").glob("*.md"),
        ]
        assert all("benchmark" not in path.name.lower() for path in surface_files)
        assert all("benchmark" not in path.read_text(encoding="utf-8").lower()
                   for path in surface_files)


def test_every_committed_bundle_ships_what_its_arm_declares() -> None:
    """The bundle is the arm: the environment its session opens in, a prompt file for each prompt
    that environment names, and the profile it runs under all live in the committed tree.
    """
    for bundle in PRODUCTION_ARM_BUNDLES:
        home = bundle.bundle_dir
        assert production_arm_bundle(bundle.key) is bundle
        environment = read_json(home / f"config/environments/{bundle.environment}.json")
        assert environment["name"] == bundle.environment
        assert environment["profile"] == bundle.profile_name
        assert environment["disableHooks"] is True
        profiles = read_json(home / "config/profiles.json")
        assert profiles["defaultProfile"] == bundle.profile_name
        assert bundle.profile_name in profiles["profiles"]
        assert profiles["profiles"][bundle.profile_name]["thinking"] == bundle.thinking
        mode = read_json(home / "data/mode.json")
        assert mode["activeProfile"] == bundle.profile_name
        assert mode["defaultAgent"] == bundle.environment
        for field, kind in (("directive", "directives"), ("systemPrompt", "systemPrompts")):
            reference = str(environment[field])
            assert reference.startswith("file:")
            assert (home / "prompts" / kind / reference[len("file:"):]).is_file()
        for required in (
            "config/machines.json", "config/settings.json",
            "context/projects/general/TASKS.yaml", "data/schedules.json",
        ):
            assert (home / required).is_file()


def test_the_provider_pair_differs_in_exactly_two_files() -> None:
    """The direct arm exists twice, once per provider. If the pair differed anywhere else, a
    provider comparison would be measuring that difference too."""
    pair = {bundle.provider: bundle for bundle in PRODUCTION_ARM_BUNDLES}
    assert sorted(pair) == ["deepseek", "openai-codex"]
    for bundle in PRODUCTION_ARM_BUNDLES:
        assert bundle.key == f"direct-pi-{bundle.provider}"
    left, right = pair["deepseek"].bundle_dir, pair["openai-codex"].bundle_dir
    differing = {
        path.relative_to(left).as_posix()
        for path in sorted(left.rglob("*")) if path.is_file()
        and (right / path.relative_to(left)).read_bytes() != path.read_bytes()
    }
    assert differing == {"config/profiles.json", "data/mode.json"}
    assert sorted(path.relative_to(left).as_posix()
                  for path in left.rglob("*") if path.is_file()) == sorted(
        path.relative_to(right).as_posix()
        for path in right.rglob("*") if path.is_file())
