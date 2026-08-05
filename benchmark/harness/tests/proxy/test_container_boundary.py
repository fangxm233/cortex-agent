# input:  trial proxy API, Docker internal bridge, synthetic upstream
# output: real-container credential, source, and egress proofs
# pos:    Container network containment tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

import base64
import shlex
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlsplit

from cortex_bench_harness.proxy import ProxyBudget, start_trial_proxy
from docker_gate import docker_opt_in
from docker_tools import external_network, internal_network, raw_proxy_request, run_container
from synthetic import SyntheticUpstream, row_one_adapter

REAL_CREDENTIAL = "sk-ant-SYNTHETIC-PROXY-CONTAINER"

pytestmark = docker_opt_in


def start_network_proxy(tmp_path: Path, upstream: SyntheticUpstream, network):
    return start_trial_proxy(
        trial_id="trial-container",
        upstream_base_url=upstream.base_url,
        adapter=row_one_adapter(upstream.base_url, REAL_CREDENTIAL),
        bound_source_ip=network.trial_ip,
        absolute_deadline=datetime.now(UTC) + timedelta(minutes=5),
        budget=ProxyBudget(
            Decimal("20"), Decimal("5"), Decimal("1000000"), Decimal("1000000"),
        ),
        log_path=tmp_path / "container-proxy.jsonl",
        listen_host=network.gateway,
        advertised_host=network.gateway,
    )


def test_container_full_environment_and_argv_exclude_real_credential(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream, internal_network() as network:
        handle = start_network_proxy(tmp_path, upstream, network)
        try:
            script = _dump_process_surface()
            env = {"ANTHROPIC_BASE_URL": handle.base_url,
                   "ANTHROPIC_AUTH_TOKEN": handle.dummy_token}
            result = run_container(network, network.trial_ip, script, env)
        finally:
            handle.stop()
    environment, argv = _decode_surface(result.stdout)
    evidence = result.stdout + result.stderr + repr(environment) + repr(argv)
    print(f"CONTAINER_FULL_ENV={environment!r}")
    print(f"CONTAINER_SPAWNED_ARGV={argv!r}")
    print("SYNTHETIC_REAL_CREDENTIAL_MATCHES=0")
    anthropic = sorted(
        item for item in environment.split(b"\0") if item.startswith(b"ANTHROPIC_")
    )
    assert result.returncode == 0
    assert anthropic == sorted([
        f"ANTHROPIC_BASE_URL={handle.base_url}".encode(),
        f"ANTHROPIC_AUTH_TOKEN={handle.dummy_token}".encode(),
    ])
    assert REAL_CREDENTIAL not in evidence


def _dump_process_surface() -> str:
    return (
        "printf 'ENV_B64='; env -0 | base64 -w0; "
        "printf '\\nARGV_B64='; base64 -w0 /proc/$$/cmdline; printf '\\n'"
    )


def _decode_surface(output: str) -> tuple[bytes, bytes]:
    values = dict(line.split("=", 1) for line in output.splitlines())
    return base64.b64decode(values["ENV_B64"]), base64.b64decode(values["ARGV_B64"])


def test_rejects_source_other_than_bound_trial(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream, internal_network() as network:
        handle = start_network_proxy(tmp_path, upstream, network)
        try:
            allowed = raw_proxy_request(network, network.trial_ip,
                                        handle.base_url, handle.dummy_token)
            rejected = raw_proxy_request(network, network.attacker_ip,
                                         handle.base_url, handle.dummy_token)
        finally:
            handle.stop()
    print(f"SOURCE_BOUND_ALLOWED={allowed.stdout.splitlines()[0]}")
    print(f"SOURCE_BOUND_REJECTED={rejected.stdout.splitlines()[0]}")
    assert " 200 " in allowed.stdout.splitlines()[0]
    assert " 403 " in rejected.stdout.splitlines()[0]
    assert len(upstream.requests) == 1


def test_real_model_endpoint_is_rejected_inside_container(tmp_path: Path) -> None:
    with external_network() as upstream_network:
        with SyntheticUpstream(upstream_network.gateway) as upstream, internal_network() as network:
            handle = start_network_proxy(tmp_path, upstream, network)
            try:
                allowed = raw_proxy_request(network, network.trial_ip,
                                            handle.base_url, handle.dummy_token)
                target = urlsplit(upstream.base_url)
                direct = run_container(
                    network, network.trial_ip,
                    _failed_connect_script(target.hostname or "", target.port or 80),
                )
            finally:
                handle.stop()
    print(f"INSIDE_REAL_ENDPOINT_EXIT={direct.returncode}")
    print(f"INSIDE_REAL_ENDPOINT_STDOUT={direct.stdout!r}")
    print(f"INSIDE_REAL_ENDPOINT_STDERR={direct.stderr!r}")
    assert " 200 " in allowed.stdout.splitlines()[0]
    assert direct.returncode != 0
    assert direct.stderr
    assert len(upstream.requests) == 1


def _failed_connect_script(host: str, port: int) -> str:
    command = f"exec 3<>/dev/tcp/{shlex.quote(host)}/{port}"
    return (
        f"set -x; timeout 3 bash -c {shlex.quote(command)}; "
        "code=$?; echo endpoint_exit=$code >&2; exit $code"
    )


def test_arbitrary_internet_host_is_rejected_inside_container(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream, internal_network() as network:
        handle = start_network_proxy(tmp_path, upstream, network)
        try:
            allowed = raw_proxy_request(network, network.trial_ip,
                                        handle.base_url, handle.dummy_token)
            internet = run_container(network, network.trial_ip, _internet_script())
        finally:
            handle.stop()
    print(f"INSIDE_INTERNET_EXIT={internet.returncode}")
    print(f"INSIDE_INTERNET_STDOUT={internet.stdout!r}")
    print(f"INSIDE_INTERNET_STDERR={internet.stderr!r}")
    assert " 200 " in allowed.stdout.splitlines()[0]
    assert internet.returncode != 0
    assert "connection_exit=" in internet.stderr
    assert len(upstream.requests) == 1


def _internet_script() -> str:
    return (
        "set -x; timeout 3 bash -c 'exec 3<>/dev/tcp/example.com/443'; "
        "code=$?; echo connection_exit=$code >&2; exit $code"
    )
