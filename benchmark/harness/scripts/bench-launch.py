#!/usr/bin/env python3
# input:  a committed campaign document, the live Docker network table and the current checkout
# output: a free-subnet verdict, freshly rebuilt trial artifacts when stale, a preflight report
#         and -- under --run -- a detached campaign whose logs are named on stdout
# pos:    One-command launch procedure over build-trial-artifacts.py and launch-paid-campaign.py
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# The procedure those two scripts document is correct and each of its gates exists because a
# campaign was lost to the thing it now refuses. What they do not do is carry the four mechanical
# burdens the operator was left holding, every one of which has cost a run:
#
#   * the subnet pool is hand-allocated and nothing compares it to the live Docker table until
#     `docker network create` fails MID-RUN, after earlier trials have already been armed and paid
#     for (2026-08-23 three-surface, pre_score_failures[0]). Checked here before anything runs,
#     with free pools of the same width suggested on collision.
#   * both artifacts must be current or the launcher refuses, but rebuilding is a separate ~3
#     minute command that is easy to forget and pointless to repeat when nothing moved. Verified
#     first, rebuilt only when the provenance gate would actually refuse.
#   * `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 uv run --offline --frozen` prefixes every documented
#     invocation and is enforced nowhere. The `bench` shim beside this file supplies it.
#   * a paid campaign is ~40 minutes and must outlive the session that starts it; the r6 attempt
#     was a child of an agent session and died at 31 minutes. `--run` detaches by default.
#
# It adds no gate and removes none. Every refusal below this line still comes from the scripts it
# calls, in their own processes, with the credential still loaded only inside the one that runs the
# campaign.
#
#   benchmark/harness/scripts/bench --config ../campaigns/<name>.yaml            # preflight
#   benchmark/harness/scripts/bench --config ../campaigns/<name>.yaml --run      # detached run

import argparse
import ipaddress
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HARNESS = Path(__file__).resolve().parents[1]
SCRIPTS = HARNESS / "scripts"
if str(HARNESS / "src") not in sys.path:
    sys.path.insert(0, str(HARNESS / "src"))

from cortex_bench_harness.artifact_provenance import (  # noqa: E402
    NPM_SCOPE,
    WHEEL_SCOPE,
    ProvenanceError,
    verify_artifact,
)
from cortex_bench_harness.campaign_config import (  # noqa: E402
    CampaignConfig,
    CampaignConfigError,
    load_campaign_config,
)

LAUNCH_SCHEMA_VERSION = "cortex-bench-launch/1"
DOCKER_TIMEOUT_SECONDS = 30
SUGGESTION_SPACES = ("172.16.0.0/12", "10.0.0.0/8", "192.168.0.0/16")
SUGGESTION_LIMIT = 3
SUGGESTION_SCAN_LIMIT = 4096


class BenchError(RuntimeError):
    """The launch could not proceed without a step the operator has to decide."""


def checkout_root(config: CampaignConfig) -> Path:
    """Same derivation the two underlying scripts use, so all three agree on one tree."""
    source = Path(config.source).resolve()
    campaigns = source.parent
    if campaigns.name != "campaigns" or campaigns.parent.name != "benchmark":
        raise BenchError(
            f"cannot derive the repository checkout from {source}: expected it under "
            "<checkout>/benchmark/campaigns/")
    return campaigns.parent.parent


# --- subnets ------------------------------------------------------------------------------------

def live_subnets() -> list[tuple[str, ipaddress.IPv4Network]]:
    """Every IPv4 subnet Docker currently holds, by the network that holds it."""
    listed = _docker(["network", "ls", "--format", "{{.ID}}"])
    ids = [line.strip() for line in listed.splitlines() if line.strip()]
    if not ids:
        return []
    inspected = _docker([
        "network", "inspect", *ids,
        "--format", "{{.Name}}\t{{range .IPAM.Config}}{{.Subnet}} {{end}}",
    ])
    subnets: list[tuple[str, ipaddress.IPv4Network]] = []
    for line in inspected.splitlines():
        name, _, declared = line.partition("\t")
        for text in declared.split():
            try:
                network = ipaddress.IPv4Network(text, strict=False)
            except ValueError:
                continue
            subnets.append((name.strip(), network))
    return subnets


def _docker(arguments: list[str]) -> str:
    try:
        result = subprocess.run(
            ["docker", *arguments], capture_output=True, text=True,
            timeout=DOCKER_TIMEOUT_SECONDS, check=False)
    except FileNotFoundError as error:
        raise BenchError(
            "docker is not on PATH; a campaign creates one Docker network per trial") from error
    except subprocess.TimeoutExpired as error:
        raise BenchError(f"docker {' '.join(arguments)} timed out") from error
    if result.returncode != 0:
        raise BenchError(
            f"docker {' '.join(arguments)} failed: {result.stderr.strip() or result.stdout.strip()}")
    return result.stdout


def slots_in_use(config: CampaignConfig) -> list[ipaddress.IPv4Network]:
    """The subnets this campaign will really ask Docker for: one per concurrency slot."""
    return [
        ipaddress.IPv4Network(config.docker_network.slot(index).subnet)
        for index in range(config.concurrency)
    ]


def check_subnets(config: CampaignConfig) -> dict[str, object]:
    """Refuse a pool that overlaps live Docker state, before a single trial is armed.

    The campaign itself only discovers this at `docker network create` for the colliding slot,
    which is after every earlier trial in the wave has been armed, run and paid for.
    """
    live = live_subnets()
    wanted = slots_in_use(config)
    collisions = [
        {"slot": index, "subnet": str(subnet), "held_by": name, "holder_subnet": str(held)}
        for index, subnet in enumerate(wanted)
        for name, held in live
        if subnet.overlaps(held)
    ]
    report: dict[str, object] = {
        "pool": config.docker_network.subnet_pool,
        "subnet_prefix": config.docker_network.subnet_prefix,
        "concurrency": config.concurrency,
        "slots_checked": [str(subnet) for subnet in wanted],
        "live_networks": len(live),
        "ok": not collisions,
    }
    if not collisions:
        return report
    pool = ipaddress.IPv4Network(config.docker_network.subnet_pool)
    free = suggest_free_pools(pool.prefixlen, live)
    report["collisions"] = collisions
    report["free_pools"] = free
    detail = "; ".join(
        f"slot {entry['slot']} {entry['subnet']} overlaps {entry['held_by']} "
        f"({entry['holder_subnet']})" for entry in collisions)
    suggestion = (
        f" Free /{pool.prefixlen} pools right now: {', '.join(free)}." if free else "")
    raise BenchError(
        f"campaign docker_network subnet_pool {pool} collides with live Docker networks: "
        f"{detail}. The campaign would arm and pay for earlier trials before failing on this one, "
        f"so it is refused here instead. Edit docker_network.subnet_pool in "
        f"{config.source}.{suggestion}")


def suggest_free_pools(
    prefixlen: int, live: list[tuple[str, ipaddress.IPv4Network]],
) -> list[str]:
    """Pools of the width the campaign already declared that nothing currently holds."""
    held = [network for _, network in live]
    free: list[str] = []
    scanned = 0
    for space in SUGGESTION_SPACES:
        container = ipaddress.IPv4Network(space)
        if container.prefixlen > prefixlen:
            continue
        for candidate in container.subnets(new_prefix=prefixlen):
            scanned += 1
            if scanned > SUGGESTION_SCAN_LIMIT:
                return free
            if any(candidate.overlaps(network) for network in held):
                continue
            free.append(str(candidate))
            if len(free) >= SUGGESTION_LIMIT:
                return free
    return free


def leaked_trial_networks(live: list[tuple[str, ipaddress.IPv4Network]]) -> list[str]:
    """Trial networks a previous campaign did not remove. Reported, never removed here.

    Their subnets stay unusable until an operator decides they are dead, and deciding that is not
    something a launcher may do on its own -- a running campaign's networks look identical.
    """
    return sorted({name for name, _ in live if name.endswith("__env_default")})


# --- artifacts ----------------------------------------------------------------------------------

def artifact_state(config: CampaignConfig, checkout: Path) -> dict[str, object]:
    """Ask the launcher's own gate whether a rebuild is needed, without rebuilding."""
    state: dict[str, object] = {}
    for key, scope in (("wheel_path", WHEEL_SCOPE), ("npm_artifact_path", NPM_SCOPE)):
        artifact = Path(str(config.manifest[key]))
        try:
            state[key] = {"current": True, "detail": verify_artifact(artifact, checkout, scope)}
        except ProvenanceError as error:
            state[key] = {"current": False, "reason": str(error)}
    return state


def stale_keys(state: dict[str, object]) -> list[str]:
    return [key for key, entry in state.items() if not entry["current"]]  # type: ignore[index]


def build_artifacts(config_path: str, only: str | None) -> dict[str, object]:
    arguments = ["--config", config_path]
    if only is not None:
        arguments += ["--only", only]
    return _script("build-trial-artifacts.py", arguments, "artifact build")


def _script(name: str, arguments: list[str], label: str) -> dict[str, object]:
    """Run a sibling script in its own process and return its JSON document.

    Own process on purpose: `launch-paid-campaign.py` refuses a credential inherited from the
    environment and pops every reference it sets in a `finally`. Importing it would put that
    environment inside this one.
    """
    result = subprocess.run(
        [sys.executable, str(SCRIPTS / name), *arguments],
        capture_output=True, text=True, check=False)
    document = _last_json(result.stdout) or _last_json(result.stderr)
    if result.returncode != 0:
        error = (document or {}).get("error") if isinstance(document, dict) else None
        raise BenchError(
            f"{label} failed: {error or result.stderr.strip() or result.stdout.strip()}")
    if not isinstance(document, dict):
        raise BenchError(f"{label} produced no JSON document")
    return document


def _last_json(text: str) -> dict[str, object] | None:
    """The scripts print one JSON document; take the last decodable one either way."""
    stripped = text.strip()
    if not stripped:
        return None
    try:
        loaded = json.loads(stripped)
    except ValueError:
        for line in reversed(stripped.splitlines()):
            try:
                loaded = json.loads(line)
            except ValueError:
                continue
            return loaded if isinstance(loaded, dict) else None
        return None
    return loaded if isinstance(loaded, dict) else None


# --- run ----------------------------------------------------------------------------------------

def log_paths(config: CampaignConfig) -> tuple[Path, Path]:
    """Logs under the campaign's own trials_dir, in a directory no trial id can collide with.

    `_partition` classifies trial roots by exact trial id, so a `_launch` sibling is invisible to
    it; keeping the logs here means the run and its output are found in one place.
    """
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    directory = config.trials_dir / "_launch"
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"{stamp}.out", directory / f"{stamp}.err"


def detach_run(config: CampaignConfig, config_path: str, passthrough: list[str]) -> dict[str, object]:
    """Start the campaign in its own session so it outlives this shell.

    A paid campaign is ~40 minutes. The r6 attempt ran as a child of an agent session and was
    killed at 31 minutes when that session ended, which is why this is the default rather than
    something the header asks the operator to remember typing.
    """
    out_path, err_path = log_paths(config)
    command = [
        sys.executable, str(SCRIPTS / "launch-paid-campaign.py"),
        "--config", config_path, "--run", *passthrough,
    ]
    with open(out_path, "wb") as out, open(err_path, "wb") as err:
        process = subprocess.Popen(
            command, stdout=out, stderr=err, stdin=subprocess.DEVNULL,
            start_new_session=True, cwd=str(HARNESS))
    return {
        "detached": True, "pid": process.pid,
        "stdout": str(out_path), "stderr": str(err_path),
        "follow": f"tail -f {err_path}",
    }


def foreground_run(config_path: str, passthrough: list[str]) -> int:
    command = [
        sys.executable, str(SCRIPTS / "launch-paid-campaign.py"),
        "--config", config_path, "--run", *passthrough,
    ]
    return subprocess.run(command, cwd=str(HARNESS), check=False).returncode


# --- procedure ----------------------------------------------------------------------------------

def execute(arguments: argparse.Namespace) -> tuple[dict[str, object], int]:
    config = load_campaign_config(arguments.config)
    checkout = checkout_root(config)
    steps: dict[str, object] = {}

    live = live_subnets()
    leaked = leaked_trial_networks(live)
    steps["subnets"] = check_subnets(config)
    if leaked:
        steps["leaked_trial_networks"] = leaked

    state = artifact_state(config, checkout)
    stale = stale_keys(state)
    steps["artifacts"] = {"checked": state, "stale": stale}
    if arguments.force_build or stale:
        if arguments.skip_build:
            steps["artifacts"]["rebuilt"] = False
            steps["artifacts"]["note"] = (
                "--skip-build was given while artifacts are stale; the launcher will refuse")
        else:
            only = None if (arguments.force_build or len(stale) == 2) else _only_for(stale)
            steps["artifacts"]["rebuilt"] = build_artifacts(arguments.config, only)

    passthrough = _passthrough(arguments)
    if arguments.mode == "preflight":
        steps["preflight"] = _script(
            "launch-paid-campaign.py",
            ["--config", arguments.config, "--preflight", *passthrough], "preflight")
        return _document(config, "preflight", steps), 0

    # The paid gate: preflight is not re-run here because `launch-paid-campaign.py --run` resolves
    # and verifies exactly the same references itself before arming anything.
    if arguments.foreground:
        document = _document(config, "run", steps)
        document["foreground"] = True
        print(json.dumps(document, indent=2, sort_keys=True), flush=True)
        return {}, foreground_run(arguments.config, passthrough)
    steps["run"] = detach_run(config, arguments.config, passthrough)
    return _document(config, "run", steps), 0


def _only_for(stale: list[str]) -> str | None:
    if stale == ["wheel_path"]:
        return "wheel"
    if stale == ["npm_artifact_path"]:
        return "npm"
    return None


def _passthrough(arguments: argparse.Namespace) -> list[str]:
    passthrough: list[str] = []
    for flag, value in (
        ("--gateway", arguments.gateway), ("--codex-auth", arguments.codex_auth),
        ("--checkout", arguments.checkout),
    ):
        if value:
            passthrough += [flag, value]
    return passthrough


def _document(config: CampaignConfig, mode: str, steps: dict[str, object]) -> dict[str, object]:
    return {
        "ok": True, "schema_version": LAUNCH_SCHEMA_VERSION, "mode": mode,
        "config": config.source, "campaign": config.campaign, "paid": config.paid,
        "trials_dir": str(config.trials_dir), "steps": steps,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="bench",
        description=(
            "Launch a committed campaign in one command: prove the declared subnets are free, "
            "rebuild only the trial artifacts that went stale, preflight, and run detached."),
        epilog=(
            "Examples:\n"
            "  bench --config ../campaigns/zero-paid-dry-run.yaml\n"
            "  bench --config ../campaigns/terminal-bench-2.1-vendor-codex.yaml --run\n"
            "  bench --config ../campaigns/zero-paid-dry-run.yaml --run --foreground\n"
            "  bench --config ../campaigns/terminal-bench-2.1-vendor-pi.yaml --force-build\n\n"
            "Preflight is the default and pays nothing. --run detaches into its own session and "
            "names its log files on stdout; the campaign outlives this shell."),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--config", required=True, help="Campaign YAML path")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--preflight", dest="mode", action="store_const", const="preflight",
        help="Check subnets and artifacts, then dry-run the campaign (default)")
    mode.add_argument(
        "--run", dest="mode", action="store_const", const="run",
        help="Check subnets and artifacts, then run the campaign detached")
    parser.add_argument(
        "--foreground", action="store_true",
        help="With --run, stay attached. Only for short zero-paid campaigns: a paid campaign "
             "outliving its shell is why detaching is the default")
    build = parser.add_mutually_exclusive_group()
    build.add_argument(
        "--force-build", action="store_true",
        help="Rebuild both trial artifacts even when the provenance gate already passes")
    build.add_argument(
        "--skip-build", action="store_true",
        help="Never rebuild. Stale artifacts are then refused by the launcher, as always")
    parser.add_argument("--gateway", default=None, help="Passed through to launch-paid-campaign.py")
    parser.add_argument(
        "--codex-auth", default=None, help="Passed through to launch-paid-campaign.py")
    parser.add_argument(
        "--checkout", default=None, help="Passed through to launch-paid-campaign.py")
    parser.set_defaults(mode="preflight")
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    if arguments.foreground and arguments.mode != "run":
        print(json.dumps(
            {"ok": False, "error": "--foreground applies to --run"}, sort_keys=True),
            file=sys.stderr)
        return 2
    try:
        document, code = execute(arguments)
    except (BenchError, CampaignConfigError, ProvenanceError, OSError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, sort_keys=True), file=sys.stderr)
        return 1
    if document:
        print(json.dumps(document, indent=2, sort_keys=True), flush=True)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
