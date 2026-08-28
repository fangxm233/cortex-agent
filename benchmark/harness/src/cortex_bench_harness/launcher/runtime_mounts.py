# input:  a campaign's staged runtime roots and the runtimes an arm asks for
# output: the fixed container targets those roots are admitted at, read-only
# pos:    Staged runtime mount vocabulary
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# Until now an agent's runtime reached a trial one way: it was baked into the task image. That
# made every (task, vendor) pair its own image -- 89 tasks times three vendors is 267 builds, one
# `--no-cache` chain with no resume, and a root filesystem that cannot hold the result. The
# 89-task PI suite already proved the other way works: mount the pinned runtime read-only into an
# unmodified upstream image and symlink it onto PATH. This module is that vocabulary, made
# declarable and made admissible.
#
# The campaign declares the SOURCES (a run-level whitelist of staged roots); the harness owns the
# TARGETS. A campaign that could also choose the container path could mount a runtime over
# /usr/bin, so it does not get to choose: a name maps to exactly one target, here, and admission
# accepts an extra mount only at one of these targets, only read-only, and only from the source
# the campaign sealed for that name.

from collections.abc import Mapping, Sequence

# The names a campaign may stage, and the one place each is mounted. `verifier` is the offline
# wheelhouse and the uvx/apt-get/curl shims a Terminal-Bench verifier needs when the trial has no
# network -- the same tree the provisioning script bakes at this exact path.
RUNTIME_TARGETS: Mapping[str, str] = {
    "node": "/opt/cortex-bench-node",
    "pi": "/opt/cortex-bench-pi-runtime",
    "codex": "/opt/cortex-bench-codex",
    "verifier": "/opt/terminal-bench-verifier",
}
# A runtime that SUBSTITUTES for something the trial could otherwise obtain for itself, and so is
# only honest when the trial cannot.
#
# `verifier` is the one. An upstream Terminal-Bench `tests/test.sh` prepares its own dependencies:
# it apt-gets curl, curls the uv installer, and then names the exact per-task closure it needs on
# the uvx line -- `-w numpy==2.3.1`, `-w torch==2.7.0`, `-w mteb==1.36.8`. 32 of the 89 tasks in
# the 2.1 corpus name something beyond pytest that way. The staged `verifier` tree cannot honor
# any of it: its wheelhouse holds pytest, pytest-json-ctrf and their four transitive dependencies,
# and its uvx shim drops `-p` and `-w` outright because offline it has nothing to install from.
#
# Mounted into a trial that CANNOT reach the internet, that is the best available approximation
# and the shim's refusals are legible. Mounted into a trial that CAN, it is a silent downgrade:
# the shim's apt-get and curl land on /usr/local/bin, which precedes /usr/bin, so the upstream
# script is intercepted at its first line and every per-task dependency it asked for is discarded
# without a word. The verifier then dies importing numpy, the reward file is written 0, and the
# trial is indistinguishable from an agent that failed the task. Refusing the combination is
# `campaign_config._validate_arm_runtimes`; this set is what it refuses on.
OFFLINE_ONLY_RUNTIMES = frozenset({"verifier"})
# What each mounted runtime has to become for an agent that expects it on PATH. Written as one
# `ln -sf` per line so a partially staged runtime fails at the link rather than at first use.
RUNTIME_LINKS: Mapping[str, tuple[tuple[str, str], ...]] = {
    "node": (
        ("/opt/cortex-bench-node/bin/node", "/usr/local/bin/node"),
        ("/opt/cortex-bench-node/bin/npm", "/usr/local/bin/npm"),
        ("/opt/cortex-bench-node/bin/npx", "/usr/local/bin/npx"),
    ),
    "pi": (("/opt/cortex-bench-pi-runtime/dist/cli.js", "/usr/local/bin/pi"),),
    "codex": (("/opt/cortex-bench-codex/bin/codex.js", "/usr/local/bin/codex"),),
    "verifier": (
        ("/opt/terminal-bench-verifier/bin/apt-get", "/usr/local/bin/apt-get"),
        ("/opt/terminal-bench-verifier/bin/curl", "/usr/local/bin/curl"),
    ),
}


class RuntimeMountError(ValueError):
    """A runtime name, source or target is not one this harness admits."""


def runtime_target(name: str) -> str:
    try:
        return RUNTIME_TARGETS[name]
    except KeyError as error:
        raise RuntimeMountError(
            f"unknown staged runtime {name!r}; this harness mounts "
            f"{sorted(RUNTIME_TARGETS)}") from error


def resolve_runtime_mounts(
    runtimes: Mapping[str, str], names: Sequence[str],
) -> dict[str, str]:
    """Target-keyed sources for the runtimes an arm asked for, refusing anything unstaged.

    Target-keyed because that is the shape admission compares against: one target, one source, and
    a duplicate name cannot quietly become a second mount at the same place.
    """
    resolved: dict[str, str] = {}
    for name in names:
        target = runtime_target(name)
        if name not in runtimes:
            raise RuntimeMountError(
                f"arm asks for the staged runtime {name!r}, which the campaign does not stage; "
                f"it stages {sorted(runtimes)}")
        if target in resolved:
            raise RuntimeMountError(f"staged runtime {name!r} is mounted twice at {target}")
        resolved[target] = runtimes[name]
    return resolved


# What a mounted runtime needs in the AGENT's own home rather than on the system path. PI's run
# command sources ~/.nvm/nvm.sh before invoking the CLI, and a mounted Node was never installed by
# nvm, so the file it sources has to exist and say nothing.
RUNTIME_AGENT_SETUP: Mapping[str, tuple[str, ...]] = {
    "node": (),
    "pi": ('mkdir -p "$HOME/.nvm"', ': > "$HOME/.nvm/nvm.sh"'),
    "codex": (),
    "verifier": (
        'mkdir -p "$HOME/.local/bin"',
        'ln -sf /opt/terminal-bench-verifier/bin/uvx "$HOME/.local/bin/uvx"',
    ),
}


def runtime_link_command(names: Sequence[str]) -> str:
    """The root-side command that puts every mounted runtime on PATH, or "" for none."""
    links = [link for name in names for link in RUNTIME_LINKS[name]]
    if not links:
        return ""
    return " && ".join(["set -eu", *(f"ln -sf {source} {target}" for source, target in links)])


def runtime_agent_command(names: Sequence[str]) -> str:
    """The agent-side command each mounted runtime needs in its own home, or "" for none."""
    steps = [step for name in names for step in RUNTIME_AGENT_SETUP[name]]
    if not steps:
        return ""
    return " && ".join(["set -eu", *steps])


def arm_runtime_names(arm: Mapping[str, object]) -> tuple[str, ...]:
    """The staged runtimes this arm's seed says were mounted, validated against the vocabulary."""
    declared = arm.get("runtime_mounts") or ()
    if isinstance(declared, str) or not isinstance(declared, Sequence):
        raise RuntimeMountError("arm runtime_mounts must be a list of staged runtime names")
    names = tuple(str(name) for name in declared)
    for name in names:
        runtime_target(name)
    return names
