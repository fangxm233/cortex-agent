#
# The Docker CLI calls behind a trial's network, with the CLI itself stubbed: what is asked of
# Docker, and that every way the call can go wrong arrives as one TrialNetworkError.

import subprocess

import pytest

from cortex_bench_harness import trial_network
from cortex_bench_harness.trial_network import (
    TrialNetworkError,
    create_trial_network,
    remove_trial_network,
)


def stub_docker(monkeypatch: pytest.MonkeyPatch, outcome: object) -> list[dict[str, object]]:
    calls: list[dict[str, object]] = []

    def run(arguments: list[str], **keywords: object) -> subprocess.CompletedProcess[str]:
        calls.append({"arguments": arguments, **keywords})
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    monkeypatch.setattr(trial_network.subprocess, "run", run)
    return calls


def completed(returncode: int, stdout: str = "", stderr: str = "") -> object:
    return subprocess.CompletedProcess([], returncode, stdout, stderr)


def test_a_network_is_created_on_exactly_the_slot_subnet_and_its_id_returned(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = stub_docker(monkeypatch, completed(0, "abc123\n"))

    assert create_trial_network("trial__env_default", "172.30.240.0/24", "172.30.240.1") == (
        "abc123")
    assert calls[0]["arguments"] == [
        "docker", "network", "create", "--driver", "bridge", "--subnet", "172.30.240.0/24",
        "--gateway", "172.30.240.1", "trial__env_default"]
    assert calls[0]["timeout"] == trial_network.NETWORK_CREATE_TIMEOUT_MS / 1000


@pytest.mark.parametrize(
    ("outcome", "fragment"),
    [
        (completed(1, stderr="Pool overlaps with other one on this address space"),
         "Pool overlaps"),
        (completed(0, "  "), "no network id returned"),
        (subprocess.TimeoutExpired(["docker"], 30), "docker network create timed out"),
        (FileNotFoundError("docker"), "docker could not be run"),
    ],
)
def test_every_way_a_create_can_fail_is_one_error(
    monkeypatch: pytest.MonkeyPatch, outcome: object, fragment: str,
) -> None:
    stub_docker(monkeypatch, outcome)

    with pytest.raises(TrialNetworkError, match=fragment):
        create_trial_network("trial__env_default", "172.30.240.0/24", "172.30.240.1")


def test_a_removal_docker_refused_is_an_error(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = stub_docker(monkeypatch, completed(1, stderr="network has active endpoints"))

    with pytest.raises(TrialNetworkError, match="active endpoints"):
        remove_trial_network("abc123")
    assert calls[0]["arguments"] == ["docker", "network", "rm", "abc123"]


def test_a_removal_that_succeeds_returns_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    stub_docker(monkeypatch, completed(0, "abc123\n"))

    assert remove_trial_network("abc123") is None
