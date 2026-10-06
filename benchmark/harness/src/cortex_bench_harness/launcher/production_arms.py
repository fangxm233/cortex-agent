#
# An arm is a committed config bundle: the directory that becomes the sealed CORTEX_HOME. A campaign
# arm names its bundle by key, and everything the bundle runs -- backend, provider, model, thinking,
# the profile and the session environment -- is read from the bundle's own files rather than stated
# a second time. The one fact a bundle cannot carry is the credential route its provider spends,
# which is the row below.

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

BUNDLES_DIR = Path(__file__).resolve().parent / "bundles"
BUNDLE_HOME_DIRNAME = "cortex-home"
ARM_SCHEMA_VERSION = "cortex-benchmark-arm/3"
# Every arm runs its one unit of work as a direct session: the launcher starts the session through
# this route and polls it there. `CORTEX_WEBHOOK_BENCHMARK_ONLY=1` makes it the only route served.
BENCHMARK_SESSION_ENDPOINT = "POST /webhook/benchmark-session"
# The execution environment a session opens in when nothing names another: the bundle's
# `config/environments/main.json` is the agent the trial runs.
SESSION_ENVIRONMENT = "main"
# The direct arm exists twice, once per provider. The pair differs in exactly one committed file --
# the profile's provider/model/thinking -- and in nothing else, so the pair is a controlled
# comparison of providers rather than of two arms that happen to share a name.
BUNDLE_CREDENTIAL_CAPABILITIES: Mapping[str, str] = {
    "direct-pi-deepseek": "pi-deepseek-api-key",
    "direct-pi-openai-codex": "pi-openai-codex-oauth",
}
IDENTITY_FIELDS = ("backend", "provider", "model", "thinking")


class ProductionArmError(RuntimeError):
    """An arm names the production launcher but does not declare a production arm."""


@dataclass(frozen=True)
class ProductionArmBundle:
    """One committed arm: its bundle and what that bundle's own files say it runs."""

    key: str
    bundle_dir: Path
    profile_name: str
    environment: str
    backend: str
    provider: str
    model: str
    thinking: str
    credential_capability: str
    webhook_endpoints: tuple[str, ...]

    def arm_fields(self) -> dict[str, str]:
        """What a campaign arm naming this bundle carries about it, for every reader downstream."""
        return {
            "bundle": self.key,
            **{field: getattr(self, field) for field in IDENTITY_FIELDS},
            "credential_capability": self.credential_capability,
        }

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


def _read_bundle_json(home: Path, key: str, relative: str) -> Mapping[str, object]:
    try:
        document = json.loads((home / relative).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ProductionArmError(f"committed bundle {key!r} {relative} is unavailable") from error
    if not isinstance(document, Mapping):
        raise ProductionArmError(f"committed bundle {key!r} {relative} must be an object")
    return document


def _bundle_profile(home: Path, key: str) -> tuple[str, dict[str, str]]:
    document = _read_bundle_json(home, key, "config/profiles.json")
    try:
        name = document["defaultProfile"]
        profile = document["profiles"][name]
        identity = {field: profile[field] for field in IDENTITY_FIELDS}
    except (KeyError, TypeError) as error:
        raise ProductionArmError(f"committed bundle {key!r} profile is incomplete") from error
    if not all(isinstance(value, str) and value for value in (name, *identity.values())):
        raise ProductionArmError(f"committed bundle {key!r} profile is incomplete")
    return name, identity


def _assert_bundle_selection(home: Path, key: str, profile_name: str) -> None:
    """The bundle's environment and its selected agent both run the bundle's default profile."""
    environment = _read_bundle_json(home, key, f"config/environments/{SESSION_ENVIRONMENT}.json")
    state = _read_bundle_json(home, key, "data/agent-state.json")
    consistent = (
        environment.get("name") == SESSION_ENVIRONMENT
        and environment.get("profile") == profile_name
        and state.get("activeProfile") == profile_name
        and state.get("defaultAgent") == SESSION_ENVIRONMENT
    )
    if not consistent:
        raise ProductionArmError(
            f"committed bundle {key!r} environment or selection runs another profile")


def _load_bundle(key: str, credential_capability: str) -> ProductionArmBundle:
    home = BUNDLES_DIR / key / BUNDLE_HOME_DIRNAME
    profile_name, identity = _bundle_profile(home, key)
    _assert_bundle_selection(home, key, profile_name)
    return ProductionArmBundle(
        key=key, bundle_dir=home, profile_name=profile_name,
        environment=SESSION_ENVIRONMENT, **identity,
        credential_capability=credential_capability,
        webhook_endpoints=(BENCHMARK_SESSION_ENDPOINT,),
    )


PRODUCTION_ARM_BUNDLES: tuple[ProductionArmBundle, ...] = tuple(
    _load_bundle(key, capability) for key, capability in BUNDLE_CREDENTIAL_CAPABILITIES.items()
)


def production_arm_bundle(key: str) -> ProductionArmBundle:
    """The committed bundle a campaign arm or a launch attestation names, by key."""
    for bundle in PRODUCTION_ARM_BUNDLES:
        if bundle.key == key:
            return bundle
    raise ProductionArmError(f"no committed production arm bundle is named {key!r}")


def resolve_production_arm(arm: Mapping[str, object]) -> ProductionArmBundle | None:
    """The bundle this arm runs, or None when the arm does not carry exactly what its bundle says."""
    key = arm.get("bundle")
    bundle = next((item for item in PRODUCTION_ARM_BUNDLES if item.key == key), None)
    if bundle is None:
        return None
    declared = (
        arm.get("schema_version") == ARM_SCHEMA_VERSION,
        arm.get("kind") == "cortex",
        isinstance(arm.get("name"), str) and bool(arm.get("name")),
        all(arm.get(field) == value for field, value in bundle.arm_fields().items()),
    )
    return bundle if all(declared) else None


def require_production_arm(arm: Mapping[str, object]) -> ProductionArmBundle:
    bundle = resolve_production_arm(arm)
    if bundle is None:
        raise ProductionArmError(
            "production launcher requires a committed PI arm: one that names its bundle and "
            "carries exactly what that bundle runs"
        )
    return bundle
