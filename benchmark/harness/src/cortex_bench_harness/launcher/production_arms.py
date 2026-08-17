# input:  one campaign arm declaration, or one committed bundle key
# output: the bundle, root template and evidence shape that arm names
# pos:    Arm-to-bundle resolution for production trials
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# An arm is a committed config bundle plus the parameters the launcher has to state about it: which
# directory becomes the sealed CORTEX_HOME, which profile the agents run under, which root template
# is injected, and which mode and roles the evidence input declares. Every seam that used to carry
# one of those as a `benchmark-direct` literal reads them from here instead, so a second arm is a
# row in this table rather than a second branch through the launcher.

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

BUNDLES_DIR = Path(__file__).resolve().parent / "bundles"
BUNDLE_HOME_DIRNAME = "cortex-home"
# The four containment limits every production arm holds at zero, restated per row so a row that
# needs a different shape (a manager arm's task tree) has to say so.
TASKLESS_LIMITS = {
    "max_thread_starts": 0, "max_parent_questions": 0,
    "max_task_depth": 0, "max_tasks": 0,
}
SERIAL_EXECUTION_LIMITS = {"max_resident_agent_processes": 1, "max_output_tokens": 65_536}


class ProductionArmError(RuntimeError):
    """An arm names the production launcher but does not declare a production arm."""


@dataclass(frozen=True)
class ProductionArmBundle:
    """One committed arm: its bundle and the launch parameters the launcher states about it."""

    key: str
    bundle_dir: Path
    profile_name: str
    root_template: str
    evidence_mode: str
    expected_roles: tuple[str, ...]
    manager_qa: str | None
    backend: str
    provider: str
    model: str
    credential_capability: str
    orchestration: Mapping[str, object]
    limits: Mapping[str, object]

    def attested_record(self) -> dict[str, str]:
        """What the launch attestation states about which arm ran."""
        return {
            "key": self.key, "profile_name": self.profile_name,
            "root_template": self.root_template,
        }


def _bundle(
    *, key: str, profile_name: str, root_template: str, evidence_mode: str,
    expected_roles: tuple[str, ...], orchestration: Mapping[str, object],
    manager_qa: str | None = None,
    limits: Mapping[str, object] = SERIAL_EXECUTION_LIMITS,
) -> ProductionArmBundle:
    return ProductionArmBundle(
        key=key, bundle_dir=BUNDLES_DIR / key / BUNDLE_HOME_DIRNAME,
        profile_name=profile_name, root_template=root_template,
        evidence_mode=evidence_mode, expected_roles=expected_roles,
        manager_qa=manager_qa, backend="pi", provider="deepseek",
        model="deepseek-v4-flash", credential_capability="pi-deepseek-api-key",
        orchestration=orchestration, limits={**TASKLESS_LIMITS, **limits},
    )


PRODUCTION_ARM_BUNDLES: tuple[ProductionArmBundle, ...] = (
    _bundle(
        key="direct-pi-deepseek", profile_name="benchmark-direct",
        root_template="benchmark-direct", evidence_mode="direct",
        expected_roles=("benchmark-direct",),
        orchestration={"mode": "direct", "ask_manager": False},
    ),
    _bundle(
        key="coder-review-audit-retry-pi-deepseek",
        profile_name="benchmark-coder-review",
        root_template="benchmark-coder-review", evidence_mode="coder-review",
        expected_roles=("benchmark-coder", "benchmark-reviewer"),
        orchestration={
            "mode": "coder-review", "coder_review_variant": "audit-retry",
            "ask_manager": False,
        },
    ),
    _bundle(
        key="coder-review-reviewer-fix-pi-deepseek",
        profile_name="benchmark-coder-review-fix",
        root_template="benchmark-coder-review-fix", evidence_mode="coder-review",
        expected_roles=("benchmark-coder", "benchmark-fixer"),
        orchestration={
            "mode": "coder-review", "coder_review_variant": "reviewer-fix",
            "ask_manager": False,
        },
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
        )
        if addressed:
            return bundle
    return None


def resolve_production_arm(arm: Mapping[str, object]) -> ProductionArmBundle | None:
    """The bundle this arm runs, or None when the arm is not a complete production arm."""
    bundle = production_arm_candidate(arm)
    if bundle is None:
        return None
    limits = arm.get("limits")
    declared = (
        arm.get("schema_version") == "cortex-benchmark-arm/2",
        isinstance(arm.get("name"), str) and bool(arm.get("name")),
        arm.get("credential_capability") == bundle.credential_capability,
        dict(_orchestration(arm)) == dict(bundle.orchestration),
        isinstance(limits, Mapping)
        and all(limits.get(key) == value for key, value in bundle.limits.items()),
    )
    return bundle if all(declared) else None


def require_production_arm(arm: Mapping[str, object]) -> ProductionArmBundle:
    bundle = resolve_production_arm(arm)
    if bundle is None:
        raise ProductionArmError(
            "production launcher requires a committed PI/DeepSeek arm declared exactly as its "
            "bundle states; any arm that can enter the aistatus silent direct fallback is refused"
        )
    return bundle
