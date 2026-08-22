# input:  admitted suite spec, fixed slot address, host-only credential
# output: one task-owned proxy session, accounting, trace and revocation
# pos:    Full-suite per-task credential route boundary
# >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from cortex_bench_harness.launcher.trial_proxy import (
    TrialProxySession,
    TrialProxySpec,
    arm_trial_proxy,
)
from cortex_bench_harness.proxy.request_limit import SharedRequestLimit

from .config import HostInputs, SuiteSpec

NETWORK_TRACE_FILENAME = "proxy-network-trace.jsonl"
REVOCATION_FILENAME = "proxy-revocation.json"


@dataclass(frozen=True)
class FinalizedProxy:
    accounting_path: Path
    lease_echo_path: Path
    network_trace_path: Path
    revocation_path: Path
    trace_complete: bool


def arm_task_proxy(
    spec: SuiteSpec, inputs: HostInputs, *, task_id: str, task_root: Path,
    container_ipv4: str, credential: str, shared_limit: SharedRequestLimit,
) -> TrialProxySession:
    proxy_dir = task_root / "proxy"
    proxy_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
    trace_path = proxy_dir / NETWORK_TRACE_FILENAME
    return arm_trial_proxy(
        arm=_arm(spec), trial_id=f"{spec.suite}-{task_id}",
        upstream_base_url=spec.upstream_base_url,
        spec=_proxy_spec(spec, inputs, container_ipv4),
        proxy_dir=proxy_dir, trial_roots=[task_root], host_credential=credential,
        paid_run=True, network_trace_path=trace_path,
        network_trace_progress_interval_seconds=spec.trace_progress_seconds,
        shared_request_limit=shared_limit,
    )


def finalize_task_proxy(session: TrialProxySession) -> FinalizedProxy:
    trace_path = session.proxy_dir / NETWORK_TRACE_FILENAME
    revocation_path = session.proxy_dir / REVOCATION_FILENAME
    try:
        accounting_path, lease_path = session.write_accounting()
    finally:
        session.handle.stop()
    revocation_path.write_text(
        json.dumps(session.handle.revocation_evidence, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return FinalizedProxy(
        accounting_path, lease_path, trace_path, revocation_path,
        session.handle.network_trace_complete,
    )


def _arm(spec: SuiteSpec) -> dict[str, object]:
    return {
        "name": "pure-pi", "kind": "vendor-baseline", "vendor_agent": "pi",
        "vendor_cli_version": spec.pi_version, "provider": "deepseek",
        "model": spec.model, "credential_capability": spec.capability,
        "limits": {
            "max_provider_requests": spec.per_task_max_requests,
            "max_cost_usd": spec.per_task_max_cost_usd,
            "deadline_seconds": spec.deadline_seconds,
            "max_output_tokens": spec.max_output_tokens,
        },
    }


def _proxy_spec(
    spec: SuiteSpec, inputs: HostInputs, container_ipv4: str,
) -> TrialProxySpec:
    return TrialProxySpec(
        credential_env="CORTEX_BENCH_FULL_SUITE_CREDENTIAL",
        bound_source_ip=container_ipv4,
        request_body_limit_bytes=spec.request_body_limit_bytes,
        response_body_limit_bytes=spec.response_body_limit_bytes,
        listen_host=inputs.proxy_listen_host,
        advertised_host=inputs.proxy_advertised_host,
        lease_seconds=spec.deadline_seconds,
    )
