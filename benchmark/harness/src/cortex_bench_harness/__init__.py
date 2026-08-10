# input:  Harbor adapter implementation on demand
# output: lazy CortexBenchAgent public package export
# pos:    Import surface for cortex-bench-harness
# >>> If I am updated, update my header and folder CORTEX.md <<<

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .harbor_agent import CortexBenchAgent

__all__ = ["CortexBenchAgent"]


def __getattr__(name: str) -> Any:
    if name != "CortexBenchAgent":
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    from .harbor_agent import CortexBenchAgent
    return CortexBenchAgent
