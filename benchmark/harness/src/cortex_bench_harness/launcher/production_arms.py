#
# An arm is a committed config bundle plus the parameters the launcher has to state about it: which
# directory becomes the sealed CORTEX_HOME, which profile the agent runs under and which execution
# environment its session opens in. Every seam that used to carry one of those as a template
# literal reads them from here instead, so a second arm is a row in this table rather than a second
# branch through the launcher.

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

BUNDLES_DIR = Path(__file__).resolve().parent / "bundles"
BUNDLE_HOME_DIRNAME = "cortex-home"
# Every arm runs its one unit of work as a direct session: the launcher starts the session through
# this route and polls it there. `CORTEX_WEBHOOK_BENCHMARK_ONLY=1` makes it the only route served.
BENCHMARK_SESSION_ENDPOINT = "POST /webhook/benchmark-session"
# The execution environment a session opens in when nothing names another: the bundle's
# `config/environments/main.json` is the agent the trial runs.
SESSION_ENVIRONMENT = "main"


class ProductionArmError(RuntimeError):
    """An arm names the production launcher but does not declare a production arm."""


@dataclass(frozen=True)
class ProductionArmBundle:
    """One committed arm: its bundle and the launch parameters the launcher states about it."""

    key: str
    bundle_dir: Path
    profile_name: str
    environment: str
    backend: str
    provider: str
    model: str
    credential_capability: str
    thinking: str
    orchestration: Mapping[str, object]
    webhook_endpoints: tuple[str, ...]

    def attested_record(self) -> dict[str, str]:
        """What the launch attestation states about which arm ran."""
        return {
            "key": self.key, "profile_name": self.profile_name,
            "environment": self.environment,
        }

    def confinement_record(self) -> dict[str, object]:
        """What this arm needed opened, as a launch parameter rather than an inference.

        The sealed home is read-only and the server serves one route, so the published record says
        which endpoints were open for the trial that ran instead of leaving it to be read off the
        code that ran it.
        """
        return {"webhook_endpoints": list(self.webhook_endpoints)}


def _bundle(
    *, key: str, profile_name: str, orchestration: Mapping[str, object],
    provider: str = "deepseek",
    model: str = "deepseek-v4-flash",
    credential_capability: str = "pi-deepseek-api-key",
    thinking: str = "off",
) -> ProductionArmBundle:
    bundle = ProductionArmBundle(
        key=key, bundle_dir=BUNDLES_DIR / key / BUNDLE_HOME_DIRNAME,
        profile_name=profile_name, environment=SESSION_ENVIRONMENT,
        backend="pi", provider=provider, model=model,
        credential_capability=credential_capability, thinking=thinking,
        orchestration=orchestration,
        webhook_endpoints=(BENCHMARK_SESSION_ENDPOINT,),
    )
    _assert_bundle_profile(bundle)
    _assert_bundle_environment(bundle)
    return bundle


def _assert_bundle_profile(bundle: ProductionArmBundle) -> None:
    path = bundle.bundle_dir / "config/profiles.json"
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        profile_name = document["defaultProfile"]
        profile = document["profiles"][profile_name]
        backend = profile["backend"]
        provider = profile["provider"]
        model = profile["model"]
        thinking = profile["thinking"]
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ProductionArmError(
            f"committed bundle {bundle.key!r} profile is unavailable"
        ) from error
    if (
        profile_name != bundle.profile_name
        or backend != bundle.backend
        or provider != bundle.provider
        or model != bundle.model
        or thinking != bundle.thinking
    ):
        raise ProductionArmError(
            f"committed bundle {bundle.key!r} profile differs from its declared metadata"
        )


def _assert_bundle_environment(bundle: ProductionArmBundle) -> None:
    """The session's environment is the bundle's own, and it runs the arm's profile."""
    path = bundle.bundle_dir / f"config/environments/{bundle.environment}.json"
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        name = document["name"]
        profile = document["profile"]
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ProductionArmError(
            f"committed bundle {bundle.key!r} environment is unavailable"
        ) from error
    if name != bundle.environment or profile != bundle.profile_name:
        raise ProductionArmError(
            f"committed bundle {bundle.key!r} environment differs from its declared metadata"
        )


# The direct arm exists twice, once per provider. The pair differs in exactly two committed files --
# the profile's provider/model/thinking and the mode's claudeModel -- and in nothing else, so the
# pair is a controlled comparison of providers rather than of two arms that happen to share a name.
# Written out per bundle rather than generated, because the bundle directory it names is a
# committed tree that has to exist.
CODEX_PROVIDER = {
    "provider": "openai-codex", "model": "gpt-5.6-sol",
    "credential_capability": "pi-openai-codex-oauth", "thinking": "xhigh",
}

PRODUCTION_ARM_BUNDLES: tuple[ProductionArmBundle, ...] = (
    _bundle(
        key="direct-pi-deepseek", profile_name="direct",
        orchestration={"mode": "direct", "ask_manager": False},
    ),
    _bundle(
        key="direct-pi-openai-codex", profile_name="direct",
        orchestration={"mode": "direct", "ask_manager": False},
        **CODEX_PROVIDER,
    ),
)


def production_arm_bundle(key: str) -> ProductionArmBundle:
    """The committed bundle a launch attestation names, by key."""
    for bundle in PRODUCTION_ARM_BUNDLES:
        if bundle.key == key:
            return bundle
    raise ProductionArmError(f"no committed production arm bundle is named {key!r}")


def _orchestration(arm: Mapping[str, object]) -> Mapping[str, object]:
    value = arm.get("orchestration")
    return value if isinstance(value, Mapping) else {}


def production_arm_candidate(arm: Mapping[str, object]) -> ProductionArmBundle | None:
    """The bundle this arm addresses, before its declaration is checked against that bundle.

    A candidate that then fails `require_production_arm` is refused rather than quietly run on the
    legacy path: it named a production arm and got its declaration wrong.
    """
    orchestration = _orchestration(arm)
    for bundle in PRODUCTION_ARM_BUNDLES:
        addressed = (
            arm.get("kind") == "cortex"
            and arm.get("backend") == bundle.backend
            and arm.get("provider") == bundle.provider
            and arm.get("model") == bundle.model
            and orchestration.get("mode") == bundle.orchestration["mode"]
            and orchestration.get("coder_review_variant")
            == bundle.orchestration.get("coder_review_variant")
            and orchestration.get("ask_manager")
            == bundle.orchestration.get("ask_manager")
        )
        if addressed:
            return bundle
    return None


def resolve_production_arm(arm: Mapping[str, object]) -> ProductionArmBundle | None:
    """The bundle this arm runs, or None when the arm is not a complete production arm."""
    bundle = production_arm_candidate(arm)
    if bundle is None:
        return None
    declared = (
        arm.get("schema_version") == "cortex-benchmark-arm/2",
        isinstance(arm.get("name"), str) and bool(arm.get("name")),
        arm.get("credential_capability") == bundle.credential_capability,
        dict(_orchestration(arm)) == dict(bundle.orchestration),
    )
    return bundle if all(declared) else None


def require_production_arm(arm: Mapping[str, object]) -> ProductionArmBundle:
    bundle = resolve_production_arm(arm)
    if bundle is None:
        raise ProductionArmError(
            "production launcher requires a committed PI arm declared exactly as its bundle "
            "states; any arm that can enter the aistatus silent direct fallback is refused"
        )
    return bundle
