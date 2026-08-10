# input:  launcher admission, arm, credential, comparison modules
# output: lazy public trial, seed, projection, and report exports
# pos:    Import surface for host benchmark launching
# >>> If I am updated, update my header and folder CORTEX.md <<<

from importlib import import_module
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .arm_resolution import (
        ARM_RESOLUTION_CONTAINER_PATH,
        ARM_RESOLUTION_SCHEMA_VERSION,
        ARM_RESOLUTION_SOURCE,
        BENCHMARK_THREAD_POLICY_CONTAINER_PATH,
        BENCHMARK_THREAD_POLICY_SOURCE,
        ContainerFacts,
        TrialSeed,
        build_benchmark_thread_policy,
        compose_arm_resolution,
        parse_trial_seed,
        write_arm_resolution,
        write_benchmark_thread_policy,
    )
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
    **dict.fromkeys([
        "ARM_RESOLUTION_CONTAINER_PATH",
        "ARM_RESOLUTION_SCHEMA_VERSION",
        "ARM_RESOLUTION_SOURCE",
        "BENCHMARK_THREAD_POLICY_CONTAINER_PATH",
        "BENCHMARK_THREAD_POLICY_SOURCE",
        "ContainerFacts",
        "TrialSeed",
        "build_benchmark_thread_policy",
        "compose_arm_resolution",
        "parse_trial_seed",
        "write_arm_resolution",
        "write_benchmark_thread_policy",
    ], ".arm_resolution"),
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
