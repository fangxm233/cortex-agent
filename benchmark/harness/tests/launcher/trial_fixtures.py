# input:  a capability id, an upstream base URL and a temporary trial root
# output: arm, seed, manifest and spec documents, and a test-local capability admission
# pos:    Shared launcher trial fixtures
# >>> If I am updated, update my header and folder CORTEX.md <<<

import socket
from dataclasses import replace
from pathlib import Path
from types import MappingProxyType

import pytest

from cortex_bench_harness.launcher import credential_capabilities
from cortex_bench_harness.launcher import trial_proxy
from cortex_bench_harness.launcher.credential_capabilities import (
    CAPABILITY_REGISTRY,
    CredentialCapability,
    CredentialCapabilityKey,
)

DIGEST = f"sha256:{'a' * 64}"
ARM_NAME = "cortex-direct"
CREDENTIAL_ENV = "CORTEX_BENCH_FIXTURE_CREDENTIAL"


def closed_upstream() -> str:
    """A loopback port with nothing listening: a forwarded request fails to connect."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return f"http://127.0.0.1:{probe.getsockname()[1]}"


ADMITTED = "offline-contract-passed"


def _install_registry(monkeypatch: pytest.MonkeyPatch, rows: dict) -> None:
    """Patch the two module namespaces that read the registry, never the registry object.

    The shipped declaration stays byte-identical: raising a row is reserved to the gate that owns
    the raise checklist, and a test that mutated the registry would be exercising a state no
    authority granted.
    """
    registry = MappingProxyType(rows)
    monkeypatch.setattr(credential_capabilities, "CAPABILITY_REGISTRY", registry)
    monkeypatch.setattr(trial_proxy, "CAPABILITY_REGISTRY", registry)


def admit_capability(
    monkeypatch: pytest.MonkeyPatch, capability_id: str, *, protocol: str | None = None,
) -> CredentialCapabilityKey:
    """Declare one row admitted **for this test only**, optionally under a filled protocol member.

    Every shipped row is `unsupported`, so without this no trial can arm at all and the wiring
    would be untestable.
    """
    rows = dict(CAPABILITY_REGISTRY)
    key = next(
        key for key, capability in rows.items() if capability.id == capability_id
    )
    admitted = key if protocol is None else replace(key, protocol=protocol)
    del rows[key]
    rows[admitted] = CredentialCapability(capability_id, ADMITTED)
    _install_registry(monkeypatch, rows)
    return admitted


def admit_every_capability(monkeypatch: pytest.MonkeyPatch) -> None:
    """Admit every row, so a test about adapter selection or wiring is not answered by the state
    gate before it reaches the behaviour it names."""
    _install_registry(monkeypatch, {
        key: CredentialCapability(capability.id, ADMITTED)
        for key, capability in CAPABILITY_REGISTRY.items()
    })


def cortex_arm(
    capability_id: str, *, model: str, backend: str = "claude",
    deadline_seconds: int = 120, max_cost_usd: str = "2.50",
) -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-arm/2",
        "kind": "cortex", "name": ARM_NAME, "backend": backend,
        "provider": "anthropic", "model": model,
        "credential_capability": capability_id,
        "orchestration": {"mode": "direct", "ask_manager": False},
        "limits": {
            "max_thread_starts": 0, "max_parent_questions": 0, "max_task_depth": 0,
            "max_tasks": 0, "max_provider_requests": 8, "max_resident_agent_processes": 1,
            "max_cost_usd": max_cost_usd, "deadline_seconds": deadline_seconds,
        },
    }


def trial_seed(
    upstream: str, capability_id: str, *, model: str, trial_id: str = "trial-fixture",
) -> dict[str, object]:
    return {
        "arm": cortex_arm(capability_id, model=model), "arm_path": f"arm://{ARM_NAME}",
        "trial_id": trial_id, "root_run_id": f"{trial_id}.{ARM_NAME}",
        "task": {"task_id": "terminal-task", "image_ref": f"registry.invalid/task@{DIGEST}",
                 "image_digest": DIGEST},
        "profile_name": "benchmark", "paid_run": False,
        "credential": {
            "upstream_base_url": upstream, "route_identity_host": "api.anthropic.com",
            "proxy_base_url": "http://trial-proxy.invalid",
            "dummy_token_ref": "offline-token-handle",
        },
        "model_alias_policy": {"kind": "exact"},
    }


def manifest_seed(tmp_path: Path, *, trial_id: str = "trial-fixture") -> dict[str, object]:
    files = {
        "wheel_path": tmp_path / "harness.whl",
        "lockfile_path": tmp_path / "uv.lock",
        "npm_artifact_path": tmp_path / "server.tgz",
    }
    for file in files.values():
        file.write_bytes(b"launcher fixture")
    return {
        "root_run_id": f"{trial_id}.{ARM_NAME}", "trial_id": trial_id, "arm": ARM_NAME,
        **{name: str(file) for name, file in files.items()},
        "lockfile_manifest_path": "benchmark/harness/uv.lock",
        "image_ref": f"registry.invalid/task@{DIGEST}", "image_digest": DIGEST,
        "image_size_bytes": len(b"launcher fixture"),
    }


def proxy_spec(**overrides: object) -> dict[str, object]:
    return {
        "credential_env": CREDENTIAL_ENV, "bound_source_ip": "127.0.0.1",
        "max_request_cost_usd": "1.00", "input_cost_per_million_usd": "3",
        "output_cost_per_million_usd": "15", **overrides,
    }
