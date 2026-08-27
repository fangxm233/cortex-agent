# input:  one campaign arm declaration, or one committed bundle key
# output: the bundle, root template and evidence shape that arm names
# pos:    Arm-to-bundle resolution for production trials
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# An arm is a committed config bundle plus the parameters the launcher has to state about it: which
# directory becomes the sealed CORTEX_HOME, which profile the agents run under, which root template
# is injected, and which mode and roles the evidence input declares. Every seam that used to carry
# one of those as a template literal reads them from here instead, so a second arm is a row in
# this table rather than a second branch through the launcher.

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

BUNDLES_DIR = Path(__file__).resolve().parent / "bundles"
BUNDLE_HOME_DIRNAME = "cortex-home"
# How the launcher hands the arm its one unit of work. A thread root is posted to the webhook and
# runs under the single-root guard; a task root is added to the arm's own task store and is run by
# the production dispatcher the bundle's settings enable.
THREAD_ROOT = "thread-root"
TASK_ROOT = "task-root"
# `CORTEX_WEBHOOK_THREAD_OP_ONLY=1` serves the thread route plus only those additions an arm
# explicitly declares. The Q&A-on arm needs the manager route; every other route stays refused.
THREAD_OP_ENDPOINT = "POST /webhook/thread-op"
MANAGER_QA_ENDPOINT = "POST /webhook/manager-qa"
THREAD_ONLY_ENDPOINTS: tuple[str, ...] = (THREAD_OP_ENDPOINT,)


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
    thinking: str
    orchestration: Mapping[str, object]
    injection: str
    writable_home_paths: tuple[str, ...]
    webhook_endpoints: tuple[str, ...]

    def attested_record(self) -> dict[str, str]:
        """What the launch attestation states about which arm ran."""
        return {
            "key": self.key, "profile_name": self.profile_name,
            "root_template": self.root_template,
        }

    def confinement_record(self) -> dict[str, object]:
        """What this arm needed opened, as a launch parameter rather than an inference.

        The sealed home is read-only and the server serves one route; an arm that needs more
        states it here, so the published record says which paths and endpoints were open for the
        trial that ran instead of leaving it to be read off the code that ran it.
        """
        return {
            "injection": self.injection,
            "webhook_endpoints": list(self.webhook_endpoints),
            "writable_home_paths": list(self.writable_home_paths),
        }


def _bundle(
    *, key: str, profile_name: str, root_template: str, evidence_mode: str,
    expected_roles: tuple[str, ...], orchestration: Mapping[str, object],
    provider: str = "deepseek",
    model: str = "deepseek-v4-flash",
    credential_capability: str = "pi-deepseek-api-key",
    thinking: str = "off",
    manager_qa: str | None = None,
    injection: str = THREAD_ROOT,
    writable_home_paths: tuple[str, ...] = (),
    webhook_endpoints: tuple[str, ...] = THREAD_ONLY_ENDPOINTS,
) -> ProductionArmBundle:
    bundle = ProductionArmBundle(
        key=key, bundle_dir=BUNDLES_DIR / key / BUNDLE_HOME_DIRNAME,
        profile_name=profile_name, root_template=root_template,
        evidence_mode=evidence_mode, expected_roles=expected_roles,
        manager_qa=manager_qa, backend="pi", provider=provider,
        model=model, credential_capability=credential_capability, thinking=thinking,
        orchestration=orchestration, injection=injection,
        writable_home_paths=writable_home_paths,
        webhook_endpoints=webhook_endpoints,
    )
    _assert_bundle_profile(bundle)
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


# The five orchestrations exist twice, once per provider. A provider pair differs in exactly two
# committed files -- the profile's provider/model/thinking and the mode's claudeModel -- and in
# nothing else, so the pair is a controlled comparison of providers rather than of two arms that
# happen to share a name. Written out per bundle rather than generated, because the bundle
# directory it names is a committed tree that has to exist.
CODEX_PROVIDER = {
    "provider": "openai-codex", "model": "gpt-5.6-sol",
    "credential_capability": "pi-openai-codex-oauth", "thinking": "xhigh",
}

PRODUCTION_ARM_BUNDLES: tuple[ProductionArmBundle, ...] = (
    _bundle(
        key="direct-pi-deepseek", profile_name="direct",
        root_template="direct", evidence_mode="direct",
        expected_roles=("direct",),
        orchestration={"mode": "direct", "ask_manager": False},
    ),
    _bundle(
        key="direct-pi-openai-codex", profile_name="direct",
        root_template="direct", evidence_mode="direct",
        expected_roles=("direct",),
        provider="openai-codex", model="gpt-5.6-sol",
        credential_capability="pi-openai-codex-oauth", thinking="xhigh",
        orchestration={"mode": "direct", "ask_manager": False},
    ),
    _bundle(
        key="coder-review-audit-retry-pi-openai-codex",
        profile_name="coder-review",
        root_template="coder-review", evidence_mode="coder-review",
        expected_roles=("coder", "reviewer"),
        orchestration={
            "mode": "coder-review", "coder_review_variant": "audit-retry",
            "ask_manager": False,
        },
        **CODEX_PROVIDER,
    ),
    _bundle(
        key="coder-review-reviewer-fix-pi-openai-codex",
        profile_name="coder-review-fix",
        root_template="coder-review-fix", evidence_mode="coder-review",
        expected_roles=("coder", "fixer"),
        orchestration={
            "mode": "coder-review", "coder_review_variant": "reviewer-fix",
            "ask_manager": False,
        },
        **CODEX_PROVIDER,
    ),
    _bundle(
        key="manager-qa-off-pi-openai-codex", profile_name="manager",
        root_template="manager", evidence_mode="manager",
        expected_roles=("manager",), manager_qa="off",
        orchestration={"mode": "manager", "ask_manager": False},
        injection=TASK_ROOT, writable_home_paths=("context/projects/general",),
        **CODEX_PROVIDER,
    ),
    _bundle(
        key="manager-qa-on-pi-openai-codex", profile_name="manager",
        root_template="manager", evidence_mode="manager",
        expected_roles=("manager",), manager_qa="on",
        orchestration={"mode": "manager", "ask_manager": True},
        injection=TASK_ROOT, writable_home_paths=("context/projects/general",),
        webhook_endpoints=(THREAD_OP_ENDPOINT, MANAGER_QA_ENDPOINT),
        **CODEX_PROVIDER,
    ),
    _bundle(
        key="coder-review-audit-retry-pi-deepseek",
        profile_name="coder-review",
        root_template="coder-review", evidence_mode="coder-review",
        expected_roles=("coder", "reviewer"),
        orchestration={
            "mode": "coder-review", "coder_review_variant": "audit-retry",
            "ask_manager": False,
        },
    ),
    _bundle(
        key="coder-review-reviewer-fix-pi-deepseek",
        profile_name="coder-review-fix",
        root_template="coder-review-fix", evidence_mode="coder-review",
        expected_roles=("coder", "fixer"),
        orchestration={
            "mode": "coder-review", "coder_review_variant": "reviewer-fix",
            "ask_manager": False,
        },
    ),
    # The manager arm is the second injection kind. Its unit of work is a task, so its limits
    # permit exactly one task at one level, and its sealed home keeps the one directory the task
    # store writes — `TASKS.yaml` and its in-file lock live there and nowhere else.
    _bundle(
        key="manager-qa-off-pi-deepseek", profile_name="manager",
        root_template="manager", evidence_mode="manager",
        expected_roles=("manager",), manager_qa="off",
        orchestration={"mode": "manager", "ask_manager": False},
        injection=TASK_ROOT, writable_home_paths=("context/projects/general",),
    ),
    _bundle(
        key="manager-qa-on-pi-deepseek", profile_name="manager",
        root_template="manager", evidence_mode="manager",
        expected_roles=("manager",), manager_qa="on",
        orchestration={"mode": "manager", "ask_manager": True},
        injection=TASK_ROOT, writable_home_paths=("context/projects/general",),
        webhook_endpoints=(THREAD_OP_ENDPOINT, MANAGER_QA_ENDPOINT),
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
