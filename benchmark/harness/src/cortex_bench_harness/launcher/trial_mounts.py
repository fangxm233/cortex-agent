"""What a trial's bind mounts may expose: one record per admitted mount, or a refusal.

A mount is admitted only as Harbor's own output handoff, the read-only task input, or a sealed
staged runtime, and never when its source reaches a host credential, the operator's home, or a
Cortex checkout.
"""

import os
import stat
from collections.abc import Mapping, Sequence
from pathlib import Path, PurePosixPath

from harbor.models.trial.config import ServiceVolumeConfig
from harbor.models.trial.paths import EnvironmentPaths, TrialPaths

from .trial_admission_io import HarborTrialAdmissionError

CREDENTIAL_ENV_KEYS = (
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "AZURE_CONFIG_DIR",
    "KUBECONFIG",
    "SSH_AUTH_SOCK",
    "GPG_AGENT_INFO",
    "DOCKER_HOST",
    "CONTAINER_HOST",
)
SENSITIVE_HOME_PATHS = (
    ".cortex", ".claude", ".anthropic", ".pi", ".ssh", ".gnupg", ".aws",
    ".azure", ".docker", ".kube", ".config/gcloud", ".config/gh",
)


def canonical_target(value: str) -> str:
    target = PurePosixPath(value)
    if not target.is_absolute() or ".." in target.parts or str(target) != value:
        raise HarborTrialAdmissionError(f"mount target is not canonical: {value}")
    return value


def _repository_root(start: Path) -> Path | None:
    for candidate in (start, *start.parents):
        if (candidate / ".git").exists():
            return candidate.resolve()
    return None


def _cortex_checkout_root(start: Path) -> Path | None:
    root = _repository_root(start)
    if root is None:
        return None
    markers = (root / "agent-server/package.json", root / "benchmark/harness/pyproject.toml")
    return root if all(marker.exists() for marker in markers) else None


def _sensitive_roots() -> tuple[Path, ...]:
    home = Path.home().resolve()
    roots = [home / relative for relative in SENSITIVE_HOME_PATHS]
    for start in (Path.cwd().resolve(), Path(__file__).resolve()):
        checkout = _cortex_checkout_root(start)
        if checkout is not None:
            roots.append(checkout)
    return tuple(dict.fromkeys(path.resolve() for path in roots if path.exists()))


def _credential_path(value: str | None) -> Path | None:
    if not value:
        return None
    if value.startswith("unix://"):
        value = value.removeprefix("unix://")
    if not value.startswith("/"):
        return None
    return Path(value).resolve()


def _credential_paths() -> tuple[Path, ...]:
    candidates = (_credential_path(os.environ.get(key)) for key in CREDENTIAL_ENV_KEYS)
    return tuple(dict.fromkeys(path for path in candidates if path is not None))


def _overlaps(candidate: Path, root: Path) -> bool:
    return (
        candidate == root or candidate.is_relative_to(root)
        or root.is_relative_to(candidate)
    )


def _reject_socket_or_credential(source: Path) -> None:
    if stat.S_ISSOCK(source.stat().st_mode):
        raise HarborTrialAdmissionError(f"mount source is a socket: {source}")
    for credential in _credential_paths():
        if _overlaps(source, credential):
            raise HarborTrialAdmissionError(f"mount exposes a host credential path: {source}")


def _reject_sensitive_source(source: Path) -> None:
    _reject_socket_or_credential(source)
    home = Path.home().resolve()
    source_checkout = _cortex_checkout_root(source)
    if source == home or home.is_relative_to(source) or source_checkout is not None:
        raise HarborTrialAdmissionError(f"mount exposes a sensitive host path: {source}")
    if any(_overlaps(source, root) for root in _sensitive_roots()):
        raise HarborTrialAdmissionError(f"mount exposes a sensitive host path: {source}")


def prepare_harbor_mount_modes(trial_paths: TrialPaths) -> None:
    trial_paths.chmod_dir()
    current = trial_paths.host_artifact_path("main", "/logs/artifacts")
    while True:
        current.chmod(0o777)
        if current == trial_paths.artifacts_dir:
            return
        current = current.parent


def standard_mounts(trial_paths: TrialPaths) -> dict[str, Path]:
    environment = EnvironmentPaths()
    return {
        str(environment.agent_dir): trial_paths.agent_dir.resolve(strict=True),
        str(environment.verifier_dir): trial_paths.verifier_dir.resolve(strict=True),
        str(environment.artifacts_dir): trial_paths.host_artifact_path(
            "main", str(environment.artifacts_dir),
        ).resolve(strict=True),
    }


def _validate_mount_shape(mount: ServiceVolumeConfig) -> None:
    if mount.get("type") != "bind":
        raise HarborTrialAdmissionError("only declared Harbor bind mounts are admitted")
    allowed = {"type", "source", "target", "read_only"}
    if set(mount) - allowed:
        raise HarborTrialAdmissionError("Harbor mount options are unsupported")


def mount_record(
    mount: ServiceVolumeConfig, standard: Mapping[str, Path],
    task_root: Path, trial_root: Path, runtime: Mapping[str, str],
) -> dict[str, object]:
    _validate_mount_shape(mount)
    source = Path(str(mount.get("source", ""))).resolve(strict=True)
    target = canonical_target(str(mount.get("target", "")))
    _reject_sensitive_source(source)
    owner, read_only = _mount_owner(mount, source, target, standard, task_root, runtime)
    if owner == "harbor-output-handoff" and not source.is_relative_to(trial_root):
        raise HarborTrialAdmissionError(f"Harbor mount escapes trial root: {source}")
    if owner == "harbor-task-input" and _overlaps(source, trial_root.parent):
        raise HarborTrialAdmissionError(f"Harbor input exposes a sibling trial root: {source}")
    info = source.stat()
    return {
        "type": "bind", "source": str(source), "target": target,
        "access": "read-only" if read_only else "read-write", "owner": owner,
        "uid": info.st_uid, "gid": info.st_gid,
        "source_mode": oct(stat.S_IMODE(info.st_mode)),
    }


def _standard_mount_owner(
    mount: ServiceVolumeConfig, source: Path, target: str,
    standard: Mapping[str, Path],
) -> tuple[str, bool] | None:
    if target not in standard:
        return None
    if source != standard[target] or mount.get("read_only") is True:
        raise HarborTrialAdmissionError(f"Harbor output mount does not match {target}")
    return "harbor-output-handoff", False


def _mount_owner(
    mount: ServiceVolumeConfig, source: Path, target: str,
    standard: Mapping[str, Path], task_root: Path, runtime: Mapping[str, str],
) -> tuple[str, bool]:
    standard_owner = _standard_mount_owner(mount, source, target, standard)
    if standard_owner is not None:
        return standard_owner
    if target in runtime:
        return _runtime_mount_owner(mount, source, target, runtime)
    if target != "/harbor/input" or not source.is_relative_to(task_root):
        raise HarborTrialAdmissionError(f"extra bind mount is not admitted: {target}")
    if mount.get("read_only") is not True:
        raise HarborTrialAdmissionError("Harbor task input mount must be read-only")
    return "harbor-task-input", True


def _runtime_mount_owner(
    mount: ServiceVolumeConfig, source: Path, target: str, runtime: Mapping[str, str],
) -> tuple[str, bool]:
    """A staged runtime is admitted at exactly the target and source the contract sealed.

    Read-only is not a courtesy here. The same tree is mounted into every concurrent trial of the
    campaign, so a writable mount would let one trial modify the interpreter the next twenty run
    on, and the trials would stop being independent measurements of the same thing.
    """
    if str(source) != runtime[target]:
        raise HarborTrialAdmissionError(
            f"runtime mount at {target} differs from the sealed staged root")
    if mount.get("read_only") is not True:
        raise HarborTrialAdmissionError(f"runtime mount at {target} must be read-only")
    return "harness-staged-runtime", True


def refresh_mount_records(records: Sequence[dict[str, object]]) -> None:
    for record in records:
        info = Path(str(record["source"])).stat()
        record["uid"] = info.st_uid
        record["gid"] = info.st_gid
        record["source_mode"] = oct(stat.S_IMODE(info.st_mode))


def canonical_mount(record: Mapping[str, object]) -> ServiceVolumeConfig:
    mount = ServiceVolumeConfig(
        type="bind", source=str(record["source"]), target=str(record["target"]),
    )
    if record["access"] == "read-only":
        mount["read_only"] = True
    return mount
