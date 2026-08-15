# input:  production Cortex package tree and already-local dependencies
# output: unmodified production npm artifact for offline container install
# pos:    Test-side alias for the production package builder
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# The implementation moved to `cortex_bench_harness.artifact_build`, because a builder reachable
# only from tests is a builder no release path runs -- which is how the r6 campaign came to pin a
# 34-hour-stale artifact. This alias keeps the three importing tests unchanged while there is only
# one implementation to keep correct.

from cortex_bench_harness.artifact_build import build_offline_npm_artifact

__all__ = ["build_offline_npm_artifact"]
