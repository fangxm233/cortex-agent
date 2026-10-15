import json
from pathlib import Path

import pytest

from cortex_bench_harness.launcher.production_arms import (
    PRODUCTION_ARM_BUNDLES,
    ProductionArmError,
    production_arm_bundle,
    require_production_arm,
    resolve_production_arm,
)

EXECUTION_LIMITS = {
    "max_provider_requests": 200, "max_cost_usd": "2.00",
    "deadline_seconds": 1800, "max_output_tokens": 65536,
}


def arm(bundle_key: str = "direct-pi-deepseek", **overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "schema_version": "cortex-benchmark-arm/4", "kind": "cortex", "name": "an-arm",
        **production_arm_bundle(bundle_key).arm_fields(),
        "limits": dict(EXECUTION_LIMITS),
    }
    value.update(overrides)
    return value


def read_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def test_direct_arm_resolves_to_the_committed_direct_bundle() -> None:
    bundle = require_production_arm(arm())

    assert bundle.key == "direct-pi-deepseek"
    assert bundle.bundle_dir.name == "cortex-home"
    assert bundle.environment == "main"
    assert (bundle.backend, bundle.provider, bundle.model, bundle.thinking) == (
        "pi", "deepseek", "deepseek-v4-flash", "off")
    assert bundle.credential_capability == "pi-deepseek-api-key"


def test_direct_openai_codex_arm_resolves_to_its_committed_bundle() -> None:
    bundle = require_production_arm(arm("direct-pi-openai-codex"))

    assert bundle.key == "direct-pi-openai-codex"
    assert bundle.bundle_dir.name == "cortex-home"
    assert bundle.environment == "main"
    assert bundle.provider == "openai-codex"
    assert bundle.model == "gpt-5.6-sol"
    assert bundle.credential_capability == "pi-openai-codex-oauth"
    assert bundle.thinking == "xhigh"
    assert bundle.bundle_dir != require_production_arm(arm()).bundle_dir


def test_bundle_identity_is_read_from_the_committed_selection() -> None:
    for bundle in PRODUCTION_ARM_BUNDLES:
        selection = read_json(bundle.bundle_dir / "config/models.json")["default"]
        fields = ("backend", "provider", "model", "thinking", "mode")
        assert {field: selection[field] for field in fields} == {
            field: getattr(bundle, field) for field in fields}


@pytest.mark.parametrize("drift", [
    {"bundle": "no-such-bundle"},
    {"model": "deepseek-v4-pro"},
    {"thinking": "high"},
    {"mode": "other"},
    {"provider": "openai-codex"},
    {"credential_capability": "pi-openai-codex-oauth"},
    {"kind": "vendor-baseline"},
    {"schema_version": "cortex-benchmark-arm/2"},
    {"name": ""},
])
def test_an_arm_that_does_not_carry_exactly_its_bundle_is_refused(
    drift: dict[str, object],
) -> None:
    other = arm(**drift)

    assert resolve_production_arm(other) is None
    with pytest.raises(ProductionArmError, match="committed PI arm"):
        require_production_arm(other)


def test_an_arm_without_a_bundle_key_is_not_a_production_arm() -> None:
    legacy = arm()
    del legacy["bundle"]

    assert resolve_production_arm(legacy) is None


def test_every_arm_records_the_one_session_endpoint_it_needs_open() -> None:
    for bundle in PRODUCTION_ARM_BUNDLES:
        assert bundle.confinement_record() == {
            "webhook_endpoints": ["POST /webhook/benchmark-session"],
        }
        assert bundle.attested_record() == {
            "key": bundle.key, "environment": "main",
            "selection": {field: getattr(bundle, field) for field in
                          ("backend", "provider", "model", "thinking", "mode")},
        }


def test_an_unknown_bundle_key_is_refused() -> None:
    with pytest.raises(ProductionArmError, match="bundle"):
        production_arm_bundle("no-such-bundle")


def test_every_bundle_exposes_only_its_normal_named_environment_surface() -> None:
    for bundle in PRODUCTION_ARM_BUNDLES:
        home = bundle.bundle_dir
        config = sorted(path.relative_to(home / "config").as_posix()
                        for path in (home / "config").rglob("*") if path.is_file())
        assert config == [
            "environments/main.json", "machines.json", "models.json", "settings.json",
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
    that environment names, and the selection it runs under all live in the committed tree.
    """
    for bundle in PRODUCTION_ARM_BUNDLES:
        home = bundle.bundle_dir
        assert production_arm_bundle(bundle.key) is bundle
        environment = read_json(home / f"config/environments/{bundle.environment}.json")
        assert environment["name"] == bundle.environment
        assert environment["disableHooks"] is True
        models = read_json(home / "config/models.json")
        assert models["default"]["thinking"] == bundle.thinking
        assert models["favorites"] == [{
            field: getattr(bundle, field) for field in ("backend", "provider", "model")
        }]
        state = read_json(home / "data/agent-state.json")
        assert state == {
            "defaultAgent": bundle.environment,
        }
        for field, kind in (("directive", "directives"), ("systemPrompt", "systemPrompts")):
            reference = str(environment[field])
            assert reference.startswith("file:")
            assert (home / "prompts" / kind / reference[len("file:"):]).is_file()
        for required in (
            "config/machines.json", "config/settings.json", "data/schedules.json",
        ):
            assert (home / required).is_file()


def test_the_provider_pair_differs_in_exactly_one_file() -> None:
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
    assert differing == {"config/models.json"}
    assert sorted(path.relative_to(left).as_posix()
                  for path in left.rglob("*") if path.is_file()) == sorted(
        path.relative_to(right).as_posix()
        for path in right.rglob("*") if path.is_file())
