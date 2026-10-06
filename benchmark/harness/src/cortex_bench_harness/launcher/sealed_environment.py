"""The environment the agent phase runs in, and the scratch directories it names.

Built at launch from the pinned image's own PATH, carried into the container by the admitted
environment, and extended by a vendor agent's runtime projection once its route is armed.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import PurePosixPath

from .trial_admission_io import (
    TRIAL_ROOT,
    TRIAL_SCRATCH_DIRECTORIES,
    HarborTrialAdmissionError,
    inspect_image_configuration,
)

INSTALLED_AGENT_BIN = "/installed-agent/npm/bin"


@dataclass(frozen=True)
class VendorRuntimeProjection:
    vendor_agent: str
    environment: Mapping[str, str]


def trial_scratch_command() -> str:
    """The agent-side command that makes the sealed environment's promise true."""
    targets = " ".join(str(TRIAL_ROOT / name) for name in TRIAL_SCRATCH_DIRECTORIES)
    return f"mkdir -p {targets}"


# The same four directories are scratch on the way out. They are named by the sealed environment,
# so third parties fill them: pip's HTTP cache under XDG_CACHE_HOME was 157.84 MB of the 173.7 MB
# one campaign collected across 29 trials -- 91% of all evidence -- and one cached PyPI response
# body in it carried a package author's `/home/<name>` path, which the leak scanner matched and
# which discarded a trial that had solved its task. Chromium leaves root-owned directories under
# XDG_CONFIG_HOME and TMPDIR that the collector cannot traverse, and one unreadable entry marks
# the whole agent root unavailable. None of this is trial evidence. Discarding the four trees in
# the live container -- after the agent and the verifier have both finished, before anything is
# collected -- fixes all three without loosening the scanner or the collector by one byte. The
# census is written first so the evidence still records that TMPDIR existed and how much it held.
TRIAL_SCRATCH_CENSUS_SCHEMA = "cortex-trial-scratch-discard/1"
TRIAL_SCRATCH_CENSUS_PATH = TRIAL_ROOT.parent / "trial-scratch-discarded.json"


def trial_scratch_discard_command(
    root: PurePosixPath = TRIAL_ROOT,
    census: PurePosixPath = TRIAL_SCRATCH_CENSUS_PATH,
) -> str:
    """Census the scratch trees, then discard them. Only the discard has to succeed."""
    targets = " ".join(str(root / name) for name in TRIAL_SCRATCH_DIRECTORIES)
    survey = "".join((
        '{ printf \'{"schema":"', TRIAL_SCRATCH_CENSUS_SCHEMA, '","directories":{\'; ',
        "sep=''; for name in ", " ".join(TRIAL_SCRATCH_DIRECTORIES), "; do ",
        'dir="', str(root), '/$name"; ',
        'if [ -d "$dir" ]; then ',
        'files=$(find "$dir" -type f 2>/dev/null | wc -l | tr -d " "); ',
        'kib=$(du -sk "$dir" 2>/dev/null | cut -f1 | tr -d " "); ',
        "present=true; else files=0; kib=0; present=false; fi; ",
        'printf \'%s"%s":{"present":%s,"files":%s,"kib":%s}\' ',
        '"$sep" "$name" "$present" "${files:-0}" "${kib:-0}"; ',
        "sep=','; done; printf '}}\\n'; } > ", str(census), " 2>/dev/null || :",
    ))
    return f"set -u; {survey}; rm -rf -- {targets}"


def agent_search_path(image_path: str) -> str:
    """The agent's PATH: the pinned image's own, with the installed agent runtime in front.

    A task is designed against the environment its image ships, and a Debian image keeps
    nginx, chroot and the rest of the system binaries on `/usr/sbin` and `/sbin`. A PATH of
    our own invention that drops them does not isolate anything -- it quietly changes what the
    task is, and the agent has no way to know a directory it can read is missing from its PATH.
    """
    entries = [INSTALLED_AGENT_BIN, *(entry for entry in image_path.split(":") if entry)]
    if len(entries) == 1:
        raise HarborTrialAdmissionError("pinned image declares no PATH")
    ordered: list[str] = []
    for entry in entries:
        if entry not in ordered:
            ordered.append(entry)
    return ":".join(ordered)


def sealed_trial_environment(trial_id: str, search_path: str) -> dict[str, str]:
    """The environment the agent phase runs in, and nothing else runs in.

    Sealing exists to keep the credential and the host out of the model's reach and to give
    every arm a byte-identical surface. Both are properties of the phase being measured, so the
    verifier phase is deliberately not included: it scores the answer and belongs in the
    environment the image ships (see `trial_verifier.AdmittedVerifier`).
    """
    root = TRIAL_ROOT
    return {
        "HOME": str(root / "home"), "HOSTNAME": trial_id,
        "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
        "NODE_DISABLE_COMPILE_CACHE": "1", "PATH": search_path,
        "TEMP": str(root / "tmp"), "TMP": str(root / "tmp"),
        "TMPDIR": str(root / "tmp"), "TZ": "UTC",
        "XDG_CACHE_HOME": str(root / "xdg-cache"),
        "XDG_CONFIG_HOME": str(root / "xdg-config"),
    }


def image_search_path(image_ref: str) -> str:
    """The PATH the pinned image declares for itself."""
    environment, _ = inspect_image_configuration(image_ref)
    return environment.get("PATH", "")


def validate_environment_values(environment: Mapping[str, str]) -> None:
    for key, value in environment.items():
        if not key or not isinstance(value, str) or not value:
            raise HarborTrialAdmissionError("trial environment values must be non-empty strings")
        if "${" in value or "\x00" in value or "\n" in value:
            raise HarborTrialAdmissionError(f"trial environment {key} is not a literal value")
