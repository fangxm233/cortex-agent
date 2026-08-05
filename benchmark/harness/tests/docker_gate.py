# input:  the CORTEX_BENCH_DOCKER_TESTS opt-in environment variable
# output: one shared marker that keeps container tests out of offline runs
# pos:    Docker opt-in gate for container-dependent tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

import os

import pytest

DOCKER_OPT_IN = "CORTEX_BENCH_DOCKER_TESTS"

SKIP_REASON = (
    f"container test: set {DOCKER_OPT_IN}=1 to run it. Unset means skip, so an "
    "offline gate never starts a container. Owner of the container-side proof is "
    "obligation O-G10-EGRESS (Gate 10). NOTE: the gated assertions have not been "
    "executed under proxy schema cortex-bench-trial-proxy/2 — the request target "
    "these fixtures emit was re-pointed to the only admitted route, "
    "POST /v1/messages?beta=true, without a container run to confirm it."
)

docker_opt_in = pytest.mark.skipif(
    os.environ.get(DOCKER_OPT_IN) != "1", reason=SKIP_REASON,
)
