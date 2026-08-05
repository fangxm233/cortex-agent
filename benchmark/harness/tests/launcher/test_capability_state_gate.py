# input:  the shipped capability registry, the arming entry and the public agent class
# output: proofs that a row no authority admits never reaches an armed route
# pos:    Capability-state gate at the arming point
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# The in-container compiler is the only other place the state is read
# (`domain/benchmark/policy-compiler.ts:230`), and it runs three lifecycle stages after arming:
# Harbor builds the agent in `Trial.__init__` (harbor/trial/trial.py:123,802) and creates the
# container much later from `Trial.run()` (trial.py:346,1152-1155). This file is the host-side rung.
# It uses no container, no Docker and no network: the upstream is a closed loopback port.

from pathlib import Path

import pytest

from cortex_bench_harness.harbor_agent import CortexBenchAgent
from cortex_bench_harness.launcher.credential_capabilities import CAPABILITY_REGISTRY
from cortex_bench_harness.launcher.trial_proxy import (
    CapabilityStateRefused,
    arm_trial_proxy,
    parse_trial_proxy_spec,
)
from capability_admission import admit_capability
from trial_fixtures import (
    CREDENTIAL_ENV,
    closed_upstream,
    cortex_arm,
    manifest_seed,
    proxy_spec,
    trial_seed,
)

REAL_CREDENTIAL = "sk-ant-STATE-GATE-UNIQUE"
ROW_ONE_CAPABILITY = "claude-api-key"


def arm(tmp_path: Path, *, environ: dict[str, str] | None = None):
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    return arm_trial_proxy(
        arm=cortex_arm(ROW_ONE_CAPABILITY, model="claude-sonnet"),
        trial_id="trial-state-gate", upstream_base_url=closed_upstream(),
        spec=parse_trial_proxy_spec(proxy_spec()), proxy_dir=artifacts / "proxy",
        trial_roots=(artifacts,),
        environ={CREDENTIAL_ENV: REAL_CREDENTIAL} if environ is None else environ,
    )


def test_the_shipped_registry_still_declares_this_row_unsupported() -> None:
    """The control for every assertion below: the refusals are about a row the shipped registry
    really does refuse, not about a row this file invented."""
    states = {
        capability.id: capability.state for capability in CAPABILITY_REGISTRY.values()
    }

    assert states[ROW_ONE_CAPABILITY] == "unsupported"


def test_arming_refuses_a_capability_row_no_authority_admits(tmp_path: Path) -> None:
    """Row 1's key carries no `??` and has a registered adapter, so adapter selection admits it.
    Only the state says no, and the state is what has to stop the route from opening."""
    with pytest.raises(CapabilityStateRefused) as refusal:
        arm(tmp_path)

    assert ROW_ONE_CAPABILITY in str(refusal.value)
    assert "unsupported" in str(refusal.value)


def test_the_refusal_precedes_the_host_credential_read(tmp_path: Path) -> None:
    """Ordering, not just outcome: with the credential absent from the environment the refusal is
    still the capability one. A check placed after the read would report the missing credential
    instead, having already loaded a real one on every trial where it is present."""
    with pytest.raises(CapabilityStateRefused):
        arm(tmp_path, environ={})


def test_a_refused_row_leaves_no_route_and_no_artifact(tmp_path: Path) -> None:
    with pytest.raises(CapabilityStateRefused):
        arm(tmp_path)

    assert not (tmp_path / "artifacts" / "proxy").exists()


def test_the_public_entry_refuses_before_the_container_could_exist(tmp_path: Path) -> None:
    """The production entry, not the launcher function: `CortexBenchAgent.__init__` is where the
    route is armed, and Harbor has not created a container at that point."""
    upstream = closed_upstream()
    with pytest.raises(CapabilityStateRefused):
        CortexBenchAgent(
            logs_dir=tmp_path / "agent", artifact_dir=tmp_path / "artifacts",
            manifest=manifest_seed(tmp_path),
            trial_seed=trial_seed(upstream, ROW_ONE_CAPABILITY, model="claude-sonnet"),
            trial_proxy=proxy_spec(),
        )


def test_an_admitted_row_still_arms(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The gate is a state check and not a blanket refusal: the same call arms once the row is
    admitted. Without this, a check that raised unconditionally would satisfy every test above."""
    admit_capability(monkeypatch, ROW_ONE_CAPABILITY)

    session = arm(tmp_path)
    try:
        assert session.adapter_selection_path.is_file()
    finally:
        session.handle.stop()
