# input:  launcher admission, arm, handshake, credential and report modules
# output: lazy public trial, handshake, projection, and report exports
# pos:    Import surface for host benchmark launching
# >>> If I am updated, update my header and folder CORTEX.md <<<

from importlib import import_module
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .trial_seed import TrialSeed, parse_trial_seed
    from .arms import (
        ArmCompositionUnsupportedError,
        BackendUnsupportedForKindError,
        ImageDigestUnpinnedError,
        backend_cli_binary,
        build_agent_config,
        require_composable_arm,
        require_pinned_image,
        select_arm,
        select_task,
    )
    from .comparison_report import (
        COMPARISON_REPORT_SCHEMA_VERSION,
        build_comparison_report,
        render_comparison_report,
    )
    from .deepseek_paid_smoke import run_deepseek_paid_smoke
    from .live_handshake import (
        LiveHandshakePermit,
        LiveHandshakePermitRefused,
        LiveHandshakeRequest,
        issue_live_handshake_permit,
        run_live_handshake,
    )
    from .credential_capabilities import (
        CAPABILITY_REGISTRY,
        CAPABILITY_STATES,
        capability_key_for,
        project_credential_capabilities,
    )
    from .trial_admission import (
        ADMISSION_EVIDENCE_FILENAME,
        ADMISSION_ENVIRONMENT_IMPORT_PATH,
        AdmittedDockerEnvironment,
        HarborTrialAdmissionError,
        build_harbor_trial_config,
        create_harbor_trial,
    )
    from .production_arms import (
        PRODUCTION_ARM_BUNDLES,
        ProductionArmBundle,
        ProductionArmError,
        production_arm_bundle,
        require_production_arm,
        resolve_production_arm,
    )
    from .production_home import (
        MaterializedProductionHome,
        ProductionArmLaunchFacts,
        ProductionHomeError,
        materialize_production_home,
    )
    from .trial_proxy import (
        PROXY_ARTIFACT_SOURCES,
        TrialProxySession,
        TrialProxySpec,
        arm_trial_proxy,
        capture_trial_inventory,
        parse_trial_proxy_spec,
        revoke_trial_proxy,
    )

_EXPORT_MODULES = {
    **dict.fromkeys(["TrialSeed", "parse_trial_seed"], ".trial_seed"),
    **dict.fromkeys([
        "ArmCompositionUnsupportedError",
        "BackendUnsupportedForKindError",
        "ImageDigestUnpinnedError",
        "backend_cli_binary",
        "build_agent_config",
        "require_composable_arm",
        "require_pinned_image",
        "select_arm",
        "select_task",
    ], ".arms"),
    **dict.fromkeys([
        "COMPARISON_REPORT_SCHEMA_VERSION",
        "build_comparison_report",
        "render_comparison_report",
    ], ".comparison_report"),
    "run_deepseek_paid_smoke": ".deepseek_paid_smoke",
    **dict.fromkeys([
        "LiveHandshakePermit",
        "LiveHandshakePermitRefused",
        "LiveHandshakeRequest",
        "issue_live_handshake_permit",
        "run_live_handshake",
    ], ".live_handshake"),
    **dict.fromkeys([
        "CAPABILITY_REGISTRY",
        "CAPABILITY_STATES",
        "capability_key_for",
        "project_credential_capabilities",
    ], ".credential_capabilities"),
    **dict.fromkeys([
        "ADMISSION_EVIDENCE_FILENAME",
        "ADMISSION_ENVIRONMENT_IMPORT_PATH",
        "AdmittedDockerEnvironment",
        "HarborTrialAdmissionError",
        "build_harbor_trial_config",
        "create_harbor_trial",
    ], ".trial_admission"),
    **dict.fromkeys([
        "PRODUCTION_ARM_BUNDLES",
        "ProductionArmBundle",
        "ProductionArmError",
        "production_arm_bundle",
        "require_production_arm",
        "resolve_production_arm",
    ], ".production_arms"),
    **dict.fromkeys([
        "MaterializedProductionHome",
        "ProductionArmLaunchFacts",
        "ProductionHomeError",
        "materialize_production_home",
    ], ".production_home"),
    **dict.fromkeys([
        "PROXY_ARTIFACT_SOURCES",
        "TrialProxySession",
        "TrialProxySpec",
        "arm_trial_proxy",
        "capture_trial_inventory",
        "parse_trial_proxy_spec",
        "revoke_trial_proxy",
    ], ".trial_proxy"),
}

__all__ = list(_EXPORT_MODULES)


def __getattr__(name: str) -> Any:
    module_name = _EXPORT_MODULES.get(name)
    if module_name is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(module_name, __name__), name)
    globals()[name] = value
    return value
