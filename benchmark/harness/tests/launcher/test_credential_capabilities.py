from dataclasses import replace

import pytest

from cortex_bench_harness.launcher import credential_capabilities
from cortex_bench_harness.launcher.credential_capabilities import CAPABILITY_REGISTRY


def test_deepseek_promotion_requires_bound_evidence() -> None:
    key = next(key for key, row in CAPABILITY_REGISTRY.items() if row.id == "pi-deepseek-api-key")
    replaced_row = replace(
        CAPABILITY_REGISTRY[key], state="offline-contract-passed", evidence_sha256=None)

    with pytest.raises(ValueError, match="evidence"):
        credential_capabilities._validate_evidence_binding(key, replaced_row)
