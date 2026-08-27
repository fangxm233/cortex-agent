# input:  a campaign that stages agent runtimes and arms that ask to have them mounted
# output: proof that a mounted runtime reaches the container read-only, or is refused
# pos:    Staged runtime mount admission tests
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# Baking the runtime into the image is what made 89 tasks cost 267 image builds. Mounting it means
# a trial's container is now assembled from two host trees instead of one, so the second tree gets
# the same treatment as the first: the campaign declares which roots exist, the harness decides
# where each is mounted, and admission accepts the mount only at that target, only from that
# source, and only read-only -- because one writable tree shared by eight concurrent trials would
# let trial one change the interpreter trials two through eight are measured on.

from pathlib import Path

import pytest

from cortex_bench_harness.campaign_config import CampaignConfigError, load_campaign_config
from cortex_bench_harness.launcher.runtime_mounts import (
    RUNTIME_TARGETS,
    RuntimeMountError,
    arm_runtime_names,
    runtime_agent_command,
    runtime_link_command,
)
from cortex_bench_harness.launcher.trial_admission import (
    HarborTrialAdmissionError,
    build_harbor_trial_config,
)
from test_campaign import arm_document, campaign_document, vendor_arm_document, write_campaign
from test_trial_admission import launch_kwargs

NODE_TARGET = "/opt/cortex-bench-node"
PI_TARGET = "/opt/cortex-bench-pi-runtime"


def stage_runtimes(root: Path, *names: str) -> dict[str, str]:
    staged: dict[str, str] = {}
    for name in names:
        directory = root / "staged" / name
        directory.mkdir(parents=True, exist_ok=True)
        staged[name] = str(directory)
    return staged


def mounted_campaign(root: Path, **overrides: object) -> Path:
    document = campaign_document(root, comparisons=[], **overrides)
    document["runtimes"] = stage_runtimes(root, "node", "pi")
    document["arms"] = [
        arm_document("cortex-a", runtime_mounts=["node"]),
        vendor_arm_document("pi-baseline", runtime_mounts=["node", "pi"]),
    ]
    return write_campaign(root, document)


def test_an_arm_gets_exactly_the_staged_roots_it_asked_for(tmp_path: Path) -> None:
    config = load_campaign_config(mounted_campaign(tmp_path))

    assert config.arm_runtime_mounts(config.arms[0]) == {
        NODE_TARGET: str(tmp_path / "staged/node")}
    assert config.arm_runtime_mounts(config.arms[1]) == {
        NODE_TARGET: str(tmp_path / "staged/node"),
        PI_TARGET: str(tmp_path / "staged/pi"),
    }


def test_an_arm_that_declares_no_runtime_gets_no_extra_mount(tmp_path: Path) -> None:
    """The historical arm: everything it runs is baked into its task image."""
    config = load_campaign_config(write_campaign(tmp_path, campaign_document(tmp_path)))

    assert config.arm_runtime_mounts(config.arms[0]) == {}


def test_an_arm_asking_for_a_runtime_the_campaign_never_staged_is_refused(
    tmp_path: Path,
) -> None:
    document = campaign_document(tmp_path, comparisons=[])
    document["runtimes"] = stage_runtimes(tmp_path, "node")
    document["arms"] = [arm_document("cortex-a", runtime_mounts=["node", "codex"])]

    with pytest.raises(CampaignConfigError) as error:
        load_campaign_config(write_campaign(tmp_path, document))
    assert "does not stage" in str(error.value)


@pytest.mark.parametrize(
    ("mutation", "fragment"),
    [
        ({"runtimes": {"nodejs": "/tmp"}}, "unknown staged runtime"),
        ({"runtimes": {"node": "/nonexistent/staged"}}, "not a staged directory"),
    ],
)
def test_a_malformed_runtimes_block_is_refused(
    tmp_path: Path, mutation: dict[str, object], fragment: str,
) -> None:
    document = campaign_document(tmp_path, comparisons=[], **mutation)

    with pytest.raises(CampaignConfigError) as error:
        load_campaign_config(write_campaign(tmp_path, document))
    assert fragment in str(error.value)


@pytest.mark.parametrize(
    ("declared", "fragment"),
    [
        (["nodejs"], "unknown staged runtime"),
        (["node", "node"], "each runtime once"),
    ],
)
def test_a_malformed_arm_runtime_mounts_list_is_refused(
    tmp_path: Path, declared: list[str], fragment: str,
) -> None:
    document = campaign_document(tmp_path, comparisons=[])
    document["runtimes"] = stage_runtimes(tmp_path, "node")
    document["arms"] = [arm_document("cortex-a", runtime_mounts=declared)]

    with pytest.raises(CampaignConfigError) as error:
        load_campaign_config(write_campaign(tmp_path, document))
    assert fragment in str(error.value)


def test_the_sealed_contract_and_the_harbor_config_carry_the_same_read_only_mount(
    tmp_path: Path,
) -> None:
    staged = stage_runtimes(tmp_path, "node")
    kwargs = launch_kwargs(tmp_path)
    kwargs["runtime_mounts"] = {NODE_TARGET: staged["node"]}

    config = build_harbor_trial_config(**kwargs)

    mounts = list(config.environment.mounts or [])
    assert mounts == [{
        "type": "bind", "source": staged["node"], "target": NODE_TARGET, "read_only": True}]
    contract = config.environment.kwargs["admission"]
    assert contract["runtime_mounts"] == {NODE_TARGET: staged["node"]}
    assert contract["schema_version"] == "cortex-harbor-launch-admission/2"


def test_a_trial_with_no_runtime_mounts_declares_none_at_all(tmp_path: Path) -> None:
    config = build_harbor_trial_config(**launch_kwargs(tmp_path))

    assert config.environment.mounts is None
    assert config.environment.kwargs["admission"]["runtime_mounts"] == {}


@pytest.mark.parametrize(
    ("target", "source", "fragment"),
    [
        ("/usr/bin", "staged/node", "not one this harness mounts"),
        (NODE_TARGET, "staged/absent", "existing absolute directory"),
    ],
)
def test_a_runtime_mount_outside_the_vocabulary_is_refused(
    tmp_path: Path, target: str, source: str, fragment: str,
) -> None:
    stage_runtimes(tmp_path, "node")
    kwargs = launch_kwargs(tmp_path)
    kwargs["runtime_mounts"] = {target: str(tmp_path / source)}

    with pytest.raises(HarborTrialAdmissionError) as error:
        build_harbor_trial_config(**kwargs)
    assert fragment in str(error.value)


def test_the_link_commands_name_every_binary_a_mounted_runtime_owes_its_agent() -> None:
    command = runtime_link_command(["node", "pi"])

    assert command.startswith("set -eu && ")
    assert f"ln -sf {NODE_TARGET}/bin/node /usr/local/bin/node" in command
    assert f"ln -sf {PI_TARGET}/dist/cli.js /usr/local/bin/pi" in command
    # PI sources ~/.nvm/nvm.sh before running, and a mounted Node was never installed by nvm.
    assert '.nvm/nvm.sh' in runtime_agent_command(["node", "pi"])
    assert runtime_link_command([]) == ""
    assert runtime_agent_command(["node"]) == ""


def test_every_declarable_runtime_has_a_target_and_a_link_rule() -> None:
    from cortex_bench_harness.launcher.runtime_mounts import RUNTIME_AGENT_SETUP, RUNTIME_LINKS

    assert set(RUNTIME_LINKS) == set(RUNTIME_TARGETS)
    assert set(RUNTIME_AGENT_SETUP) == set(RUNTIME_TARGETS)


def test_an_arm_seed_naming_an_unknown_runtime_is_refused_at_the_agent() -> None:
    assert arm_runtime_names({"runtime_mounts": ["node"]}) == ("node",)
    assert arm_runtime_names({}) == ()
    with pytest.raises(RuntimeMountError):
        arm_runtime_names({"runtime_mounts": ["nodejs"]})
