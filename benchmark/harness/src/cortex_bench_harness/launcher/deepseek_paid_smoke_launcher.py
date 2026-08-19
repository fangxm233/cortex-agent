# input:  committed smoke campaign, pinned image, synthetic or host gateway
# output: path-safe terminal, leak-scan, network, and revocation evidence
# pos:    Executable pinned-image DeepSeek smoke launcher
# >>> If I am updated, update my header and folder CORTEX.md <<<

import argparse
import asyncio
import json
import os
import secrets
import socket
import subprocess
from collections import Counter
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from ..campaign_config import CampaignConfig, TrialPlan, load_campaign_config
from ..host_finalization import parse_host_scan_policy
from ..outcome import TrialOutcomeReader
from ..scan import ArtifactInventory, ScanPolicy, scan_trial_artifacts
from .deepseek_paid_smoke import (
    CAPABILITY_ID,
    MODEL,
    load_deepseek_relay_credential,
    run_deepseek_paid_smoke,
)

SMOKE_ARM_NAME = "ds-smoke"
SMOKE_TASK_ID = "constraints-scheduling"
SMOKE_IMAGE_DIGEST = "sha256:002574fdff7d6c7fa3ae377253d36c86eebdbc05eb53a34995154944ea7420f1"
SMOKE_IMAGE_REF = f"cortex-terminal-bench-2.1@{SMOKE_IMAGE_DIGEST}"
CORTEX_SETUP_PREREQUISITES = (
    "bash", "node", "npm", "pi", "pwd", "realpath", "ln", "chmod", "mkdir",
)
EXPECTED_VERSIONS = {"node": "v22.19.0", "npm": "10.9.3", "pi": "0.82.1"}
EVIDENCE_SCHEMA_VERSION = "cortex-bench-deepseek-smoke-result/1"
EVIDENCE_FILENAME = "deepseek-paid-smoke-result.json"


class SmokeLaunchError(RuntimeError):
    """The bounded smoke could not run without weakening its committed contract."""


def load_smoke_config(path: Path | str) -> tuple[CampaignConfig, TrialPlan]:
    config = load_campaign_config(path)
    plans = config.trials()
    if len(plans) != 1:
        raise SmokeLaunchError("smoke config must declare exactly one trial")
    plan = plans[0]
    _validate_smoke_plan(config, plan)
    return config, plan


def _validate_smoke_plan(config: CampaignConfig, plan: TrialPlan) -> None:
    expected = {
        "kind": "cortex", "backend": "pi", "provider": "deepseek",
        "model": MODEL, "credential_capability": CAPABILITY_ID,
    }
    if not config.paid or any(plan.arm.get(key) != value for key, value in expected.items()):
        raise SmokeLaunchError("smoke config identity differs from the paid contract")
    if plan.arm_name != SMOKE_ARM_NAME or plan.task.task_id != SMOKE_TASK_ID:
        raise SmokeLaunchError("smoke config arm or task differs from the committed selection")
    if plan.task.image_ref != SMOKE_IMAGE_REF or plan.task.image_digest != SMOKE_IMAGE_DIGEST:
        raise SmokeLaunchError("smoke config must use the committed Cortex-compatible image")


def preflight_image(
    image_ref: str, *, runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> dict[str, object]:
    digest = image_ref.rsplit("@", 1)[-1]
    inspected = runner(
        ["docker", "image", "inspect", image_ref, "--format", "{{.Id}}"],
        capture_output=True, text=True, timeout=30,
    )
    if inspected.returncode != 0 or inspected.stdout.strip() != digest:
        raise SmokeLaunchError(f"pinned smoke image is unavailable or mismatched: {digest}")
    completed = runner(
        _preflight_command(image_ref), capture_output=True, text=True, timeout=30,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        raise SmokeLaunchError(f"image prerequisite missing or mismatched: {detail}")
    versions = _parse_versions(completed.stdout)
    return {"image_digest": digest, **versions,
            "prerequisites": list(CORTEX_SETUP_PREREQUISITES)}


def _preflight_command(image_ref: str) -> list[str]:
    commands = " ".join(CORTEX_SETUP_PREREQUISITES)
    script = (
        f"set -euo pipefail; for name in {commands}; do "
        "command -v \"$name\" >/dev/null || { echo missing:$name >&2; exit 42; }; done; "
        "printf 'node=%s\\nnpm=%s\\npi=%s\\n' "
        "\"$(node --version)\" \"$(npm --version)\" \"$(pi --version)\""
    )
    return [
        "docker", "run", "--rm", "--network", "none", "--pull", "never",
        "--entrypoint", "/bin/bash", image_ref, "-lc", script,
    ]


def _parse_versions(stdout: str) -> dict[str, str]:
    values = dict(line.split("=", 1) for line in stdout.splitlines() if "=" in line)
    if values != EXPECTED_VERSIONS:
        raise SmokeLaunchError(
            f"image prerequisite versions differ: expected {EXPECTED_VERSIONS}, got {values}")
    return values


def create_smoke_network(
    config: CampaignConfig, plan: TrialPlan, *,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> str:
    slot = config.slot(0)
    name = f"{plan.trial_id}__env_default"
    completed = runner([
        "docker", "network", "create", "--driver", "bridge",
        "--subnet", slot.subnet, "--gateway", slot.gateway, name,
    ], capture_output=True, text=True, timeout=30)
    if completed.returncode != 0 or not completed.stdout.strip():
        raise SmokeLaunchError(f"could not create scoped Docker network: {completed.stderr.strip()}")
    return completed.stdout.strip()


def remove_smoke_network(
    network_id: str, *, runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> None:
    completed = runner(
        ["docker", "network", "rm", network_id],
        capture_output=True, text=True, timeout=30,
    )
    if completed.returncode != 0:
        raise SmokeLaunchError(f"could not remove scoped Docker network: {completed.stderr.strip()}")


async def launch_smoke(*, config_path: Path, gateway_path: Path) -> dict[str, object]:
    config, plan = load_smoke_config(config_path)
    preflight = preflight_image(plan.task.image_ref)
    credential = load_deepseek_relay_credential(gateway_path)
    scan_values = _scan_environment(config, credential)
    scan_policy = parse_host_scan_policy(config.host_scan_policy, scan_values)
    network_id = create_smoke_network(config, plan)
    trial_error: str | None = None
    try:
        with _temporary_environment(scan_values):
            await run_deepseek_paid_smoke(
                gateway_path=gateway_path,
                trial_kwargs=_trial_kwargs(config, plan),
            )
    except Exception as error:
        trial_error = type(error).__name__
    finally:
        remove_smoke_network(network_id)
    record = path_safe_evidence(
        trial_root=config.trials_dir / plan.trial_id, trial_id=plan.trial_id,
        arm_name=plan.arm_name, image_digest=plan.task.image_digest,
        scan_policy=scan_policy, network_removed=True,
    )
    record["preflight"] = preflight
    if trial_error is not None:
        record["launch_error"] = trial_error
    _write_evidence(config.trials_dir / EVIDENCE_FILENAME, record)
    return record


def _trial_kwargs(config: CampaignConfig, plan: TrialPlan) -> dict[str, object]:
    return {
        "arm": dict(plan.arm), "task_path": plan.task.path,
        "trials_dir": config.trials_dir, "manifest": config.trial_manifest(plan),
        "trial_seed": config.trial_seed(plan), "cli_version": config.cli_version,
        "host_scan_policy": dict(config.host_scan_policy),
        "trial_proxy": config.slot_proxy(config.slot(0)),
        "agent_timeout_seconds": config.timeouts.get("agent_seconds"),
        "verifier_timeout_seconds": config.timeouts.get("verifier_seconds"),
        "network": config.network,
    }


def _scan_environment(config: CampaignConfig, credential: str) -> dict[str, str]:
    policy = config.host_scan_policy
    return {
        str(config.proxy["credential_env"]): credential,
        str(policy["forbidden_environment"]["host_provider_credential"]): _canary("env"),
        str(policy["forbidden_argv_environment"]["host_provider_credential"]): _canary("argv"),
        str(policy["repository_checkout_environment"]): _checkout_root(config),
        str(policy["host_identity_environment"]["machine"]): socket.gethostname(),
    }


def _canary(label: str) -> str:
    return f"cortex-bench-smoke-{label}-{secrets.token_hex(8)}"


def _checkout_root(config: CampaignConfig) -> str:
    source = Path(config.source).resolve()
    for parent in source.parents:
        if (parent / "benchmark/harness/pyproject.toml").is_file():
            return str(parent)
    raise SmokeLaunchError("smoke config is not inside a Cortex checkout")


@contextmanager
def _temporary_environment(values: Mapping[str, str]) -> Iterator[None]:
    previous = {name: os.environ.get(name) for name in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def synthetic_scan_policy(secret: str, checkout: Path) -> ScanPolicy:
    return ScanPolicy(
        secrets={"provider_credential": secret}, repository_checkout=str(checkout),
        hostname=socket.gethostname(), home_path=str(Path.home()),
    )


def path_safe_evidence(
    *, trial_root: Path, trial_id: str, arm_name: str, image_digest: str,
    scan_policy: ScanPolicy, network_removed: bool,
) -> dict[str, Any]:
    outcome = TrialOutcomeReader(
        trial_id=trial_id, arm_name=arm_name, trial_root=trial_root,
    ).read()
    return {
        "ok": outcome.outcome_state != "harness-incomplete" and network_removed,
        "schema_version": EVIDENCE_SCHEMA_VERSION,
        "trial_id": trial_id, "image_digest": image_digest,
        "terminal": {
            "state": outcome.outcome_state, "score_status": outcome.score_status,
            "verifier_rewards": outcome.verifier_rewards,
        },
        "counters": _proxy_counters(trial_root),
        "leak_scan": _path_safe_scan(trial_root, scan_policy, outcome.envelope),
        "revocation": _revocation_evidence(trial_root, outcome.envelope),
        "network": {"created": True, "removed": network_removed},
    }


def _write_evidence(path: Path, record: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(
        json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def _path_safe_scan(
    trial_root: Path, policy: ScanPolicy,
    envelope: Mapping[str, object] | None = None,
) -> dict[str, object]:
    published = envelope.get("leak_scan") if isinstance(envelope, Mapping) else None
    if isinstance(published, Mapping):
        return _published_scan(published)
    files = tuple(
        path for path in sorted(trial_root.rglob("*"))
        if path.is_file() and not path.is_symlink()
    )
    if not files:
        return {"clean": False, "credential_matches": None, "findings": {},
                "files_scanned": 0, "bytes_scanned": 0, "unclassified_files": None}
    sources = {f"file:{index:04d}": path for index, path in enumerate(files)}
    report = scan_trial_artifacts(
        ArtifactInventory(sources, frozenset(sources), (trial_root,)), policy,
    )
    categories = Counter(finding.category for finding in report.findings)
    return {
        "clean": report.clean, "credential_matches": categories.get("secret", 0),
        "findings": dict(sorted(categories.items())),
        "files_scanned": len(report.sources),
        "bytes_scanned": sum(source.bytes_scanned for source in report.sources),
        "unclassified_files": len(report.unclassified_files),
    }


def _published_scan(source: Mapping[str, object]) -> dict[str, object]:
    matches = source.get("matches")
    matches = matches if isinstance(matches, list) else []
    categories = Counter(
        item.get("category") for item in matches
        if isinstance(item, Mapping) and isinstance(item.get("category"), str)
    )
    sources = source.get("sources")
    sources = sources if isinstance(sources, list) else []
    return {
        "clean": source.get("clean") if isinstance(source.get("clean"), bool) else None,
        "credential_matches": categories.get("secret", 0),
        "findings": dict(sorted(categories.items())),
        "files_scanned": len(sources),
        "bytes_scanned": sum(_source_bytes(item) for item in sources),
        "unclassified_files": len(source.get("unclassified_files", [])),
    }


def _source_bytes(source: object) -> int:
    value = source.get("bytes_scanned") if isinstance(source, Mapping) else None
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def _proxy_counters(trial_root: Path) -> dict[str, int | float | None]:
    path = trial_root / "artifacts/proxy/proxy-export.json"
    try:
        source = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        source = {}
    return {name: _counter(source.get(name)) for name in (
        "requests", "input_tokens", "output_tokens", "cached_tokens")}


def _counter(value: object) -> int | float | None:
    if isinstance(value, Mapping) and value.get("status") == "available":
        value = value.get("value")
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _revocation_evidence(
    trial_root: Path, envelope: Mapping[str, object] | None,
) -> dict[str, object]:
    source = envelope.get("revocation") if isinstance(envelope, Mapping) else None
    if isinstance(source, Mapping):
        return {
            "route_active": source.get("route_active"),
            "listener_present": source.get("listener_present"),
            "serving_thread_alive": source.get("serving_thread_alive"),
            "active_handlers": source.get("active_handlers"),
            "body_handlers": source.get("body_handlers"),
        }
    return {"route_active": None, "listener_present": _listener_present(trial_root),
            "serving_thread_alive": None, "active_handlers": None, "body_handlers": None}


def _listener_present(trial_root: Path) -> bool | None:
    path = trial_root / "artifacts/harbor-launch-admission.json"
    try:
        source = json.loads(path.read_text(encoding="utf-8"))
        port = source["network"]["proxy_route"]["port"]
        with socket.create_connection(("127.0.0.1", int(port)), timeout=0.2):
            return True
    except (OSError, ValueError, KeyError, TypeError):
        return False if path.exists() else None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cortex-bench-deepseek-smoke",
        description="Run or preflight the committed one-request DeepSeek smoke.",
        epilog=(
            "Examples:\n"
            "  cortex-bench-deepseek-smoke --config smoke.yaml --preflight\n"
            "  cortex-bench-deepseek-smoke --config smoke.yaml --gateway gateway.yaml --run"
        ), formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--config", required=True, help="Committed smoke campaign YAML")
    parser.add_argument("--gateway", help="Gateway YAML; required only with --run")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--preflight", dest="run", action="store_false", help="Probe only (default)")
    mode.add_argument("--run", dest="run", action="store_true", help="Run once after preflight")
    parser.set_defaults(run=False)
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    try:
        config, plan = load_smoke_config(Path(arguments.config))
        if not arguments.run:
            result = {"ok": True, "preflight": preflight_image(plan.task.image_ref)}
        elif not arguments.gateway:
            raise SmokeLaunchError("--gateway is required with --run")
        else:
            result = asyncio.run(launch_smoke(
                config_path=Path(arguments.config), gateway_path=Path(arguments.gateway)))
    except (OSError, ValueError, SmokeLaunchError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, sort_keys=True))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0 if result.get("ok") is True else 1


if __name__ == "__main__":
    raise SystemExit(main())
