#
# One trial's Docker network: created on the subnet its concurrency slot owns, removed when the
# trial ends. Both calls block on the Docker CLI for up to their timeout, so the campaign driver
# runs them in a worker thread instead of on the event loop every in-flight trial shares.

import subprocess

NETWORK_CREATE_TIMEOUT_MS = 30_000
NETWORK_REMOVE_TIMEOUT_SECONDS = 30


class TrialNetworkError(RuntimeError):
    """Docker did not create or remove a trial network."""


def create_trial_network(name: str, subnet: str, gateway: str) -> str:
    """Create a bridge network on exactly this subnet and gateway; return its id."""
    result = _docker(
        ["network", "create", "--driver", "bridge", "--subnet", subnet, "--gateway", gateway,
         name],
        NETWORK_CREATE_TIMEOUT_MS / 1000,
    )
    network_id = result.stdout.strip()
    if result.returncode != 0 or not network_id:
        raise TrialNetworkError(result.stderr.strip() or network_id or "no network id returned")
    return network_id


def remove_trial_network(network_id: str) -> None:
    result = _docker(["network", "rm", network_id], NETWORK_REMOVE_TIMEOUT_SECONDS)
    if result.returncode != 0:
        raise TrialNetworkError(result.stderr.strip() or result.stdout.strip())


def _docker(arguments: list[str], timeout_seconds: float) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            ["docker", *arguments], capture_output=True, text=True, timeout=timeout_seconds)
    except subprocess.TimeoutExpired as error:
        raise TrialNetworkError(f"docker {arguments[0]} {arguments[1]} timed out") from error
    except OSError as error:
        raise TrialNetworkError(f"docker could not be run: {error}") from error
