# input:  vendor-baseline arms and Harbor factory
# output: native inheritance and absence of Cortex config/artifacts
# pos:    Isolation proof for all vendor baseline paths
# >>> If I am updated, update my header and folder CORTEX.md <<<

from pathlib import Path

import pytest
from harbor.agents.factory import AgentFactory

from cortex_bench_harness.launcher.arms import build_agent_config


VENDORS = (
    ("claude-code", None, "claude-sonnet", "harbor.agents.installed.claude_code"),
    ("pi", "openai", "gpt-5", "harbor.agents.installed.pi"),
    ("codex", None, "gpt-5", "harbor.agents.installed.codex"),
)


def baseline_arm(
    vendor_agent: str, provider: str | None, model: str,
) -> dict[str, object]:
    return {
        "schema_version": "cortex-benchmark-arm/2",
        "kind": "vendor-baseline",
        "name": f"pure-{vendor_agent}",
        "vendor_agent": vendor_agent,
        "vendor_cli_version": "1.2.3",
        "provider": provider,
        "model": model,
        "credential_capability": f"{vendor_agent}-credential",
        "limits": {
            "max_provider_requests": 8,
            "max_cost_usd": "2.50",
            "deadline_seconds": 90,
            "max_output_tokens": 65_536,
        },
    }


@pytest.mark.parametrize(("vendor", "provider", "model", "module"), VENDORS)
def test_baseline_uses_only_the_native_harbor_path(
    tmp_path: Path, vendor: str, provider: str | None, model: str, module: str,
) -> None:
    config = build_agent_config(
        baseline_arm(vendor, provider, model), cli_version="1.2.3",
        env={"ANTHROPIC_API_KEY": "dummy", "OPENAI_API_KEY": "dummy"},
    )
    logs_dir = tmp_path / vendor
    agent = AgentFactory.create_agent_from_config(config, logs_dir=logs_dir)
    native_modules = {base.__module__ for base in type(agent).__mro__}

    assert type(agent).__module__ == "cortex_bench_harness.vendor_agents"
    assert module in native_modules
    assert config.import_path == type(agent).import_path()
    assert config.kwargs == {"version": "1.2.3"}
    assert config.skills == []
    assert config.mcp_servers == []
    assert all("cortex" not in path.name.casefold() for path in logs_dir.rglob("*"))


@pytest.mark.parametrize("field", [
    "backend", "orchestration", "plugin_dirs", "task_store", "coordinator",
    "artifact_inventory_spec",
])
def test_baseline_rejects_cortex_composition_fields(field: str) -> None:
    arm = baseline_arm("claude-code", None, "claude-sonnet")
    arm[field] = {"configured": True}

    with pytest.raises(ValueError, match="Cortex composition"):
        build_agent_config(arm, cli_version="1.2.3")


@pytest.mark.parametrize("key", [
    "CORTEX_HOME", "CORTEX_PROJECTS_DIR", "CORTEX_BENCH_TRIAL_ID",
])
def test_baseline_rejects_cortex_environment(key: str) -> None:
    arm = baseline_arm("codex", "openai", "gpt-5")

    with pytest.raises(ValueError, match="Cortex environment"):
        build_agent_config(
            arm, cli_version="1.2.3", env={key: "/tmp/cortex-state"},
        )
