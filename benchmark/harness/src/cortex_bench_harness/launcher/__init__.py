# input:  launcher admission, arm, credential, comparison modules
# output: public trial construction, seed, projection, report symbols
# pos:    Import surface for host benchmark launching
# >>> If I am updated, update my header and folder CORTEX.md <<<

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

__all__ = [
    "ARM_RESOLUTION_CONTAINER_PATH",
    "ARM_RESOLUTION_SCHEMA_VERSION",
    "ARM_RESOLUTION_SOURCE",
    "ADMISSION_EVIDENCE_FILENAME",
    "ADMISSION_ENVIRONMENT_IMPORT_PATH",
    "BENCHMARK_THREAD_POLICY_CONTAINER_PATH",
    "BENCHMARK_THREAD_POLICY_SOURCE",
    "CAPABILITY_REGISTRY",
    "CAPABILITY_STATES",
    "COMPARISON_REPORT_SCHEMA_VERSION",
    "PROXY_ARTIFACT_SOURCES",
    "TrialProxySession",
    "TrialProxySpec",
    "AdmittedDockerEnvironment",
    "ArmCompositionUnsupportedError",
    "BackendUnsupportedForKindError",
    "ContainerFacts",
    "HarborTrialAdmissionError",
    "ImageDigestUnpinnedError",
    "TrialSeed",
    "arm_trial_proxy",
    "backend_cli_binary",
    "build_agent_config",
    "build_benchmark_thread_policy",
    "build_comparison_report",
    "build_harbor_trial_config",
    "capability_key_for",
    "capture_trial_inventory",
    "compose_arm_resolution",
    "create_harbor_trial",
    "parse_trial_proxy_spec",
    "parse_trial_seed",
    "project_credential_capabilities",
    "require_composable_arm",
    "require_pinned_image",
    "render_comparison_report",
    "revoke_trial_proxy",
    "select_arm",
    "select_task",
    "write_arm_resolution",
    "write_benchmark_thread_policy",
]
