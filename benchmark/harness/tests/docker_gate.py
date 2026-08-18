# input:  the CORTEX_BENCH_DOCKER_TESTS opt-in environment variable
# output: shared marker and module guard for container tests
# pos:    Fail-closed Docker opt-in gate for benchmark tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

import os

import pytest

DOCKER_OPT_IN = "CORTEX_BENCH_DOCKER_TESTS"

SKIP_REASON = (
    f"container test: set {DOCKER_OPT_IN}=1 to run it. Unset means skip, so an "
    "offline gate never starts a container. Owner of the container-side proof is "
    "obligation O-G10-EGRESS (Gate 10). These assertions were last executed under "
    "proxy schema cortex-bench-trial-proxy/2 on 2026-08-18 (17 passed: 4 container "
    "boundary, 13 container stop observation), which closed the gap this note "
    "previously recorded — the re-pointed request target, POST /v1/messages?beta=true, "
    "is confirmed by a real container run. Note these proofs bound the trial PROXY on "
    "a Docker --internal network; they do not exercise the campaign network block, "
    "whose open/filtered topologies are covered by the admission tests."
)


def require_docker_opt_in() -> None:
    if os.environ.get(DOCKER_OPT_IN) != "1":
        pytest.skip(SKIP_REASON, allow_module_level=True)


docker_opt_in = pytest.mark.skipif(
    os.environ.get(DOCKER_OPT_IN) != "1", reason=SKIP_REASON,
)
