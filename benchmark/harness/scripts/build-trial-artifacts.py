#!/usr/bin/env python3
# input:  a committed campaign document and the checkout it belongs to
# output: both trial artifacts, built from current source, at the exact paths the campaign pins,
#         each with a provenance sidecar the launcher checks before it will run
# pos:    Trial artifact build procedure
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# A campaign installs two artifacts into every container: the harness wheel and the packed
# agent-server. Until now nothing on any release path built the second one -- the logic existed
# only inside a test helper -- so `dist/` held whatever an operator had packed by hand, whenever
# that was. On 2026-08-14 the r6 campaign ran a wheel built minutes earlier next to an agent-server
# packed 34 hours earlier, and measured three trials against a bug that had already been fixed and
# committed. Every digest in every manifest was recorded correctly the whole way.
#
# So this builds both, into the paths the campaign document itself declares, and records what
# source each came from. `launch-paid-campaign.py` refuses to start unless those records still
# match the checkout it is launching from, which is what makes a stale artifact impossible rather
# than merely unlikely.
#
#   cd <checkout>/benchmark/harness
#   PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 uv run --offline --frozen \
#     python scripts/build-trial-artifacts.py \
#       --config ../campaigns/terminal-bench-2.1-deepseek-paid.yaml
#
# It reads no credential and touches no network: `npm_config_offline` is forced for the npm build
# and the wheel build runs `uv sync --frozen`. Roughly three minutes, almost all of it the SPA
# build and `tsc`.

import argparse
import json
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

HARNESS = Path(__file__).resolve().parents[1]
if str(HARNESS / "src") not in sys.path:
    sys.path.insert(0, str(HARNESS / "src"))

from cortex_bench_harness.artifact_build import (  # noqa: E402
    ArtifactBuildError,
    build_harness_wheel,
    build_offline_npm_artifact,
)
from cortex_bench_harness.artifact_provenance import (  # noqa: E402
    NPM_SCOPE,
    WHEEL_SCOPE,
    ProvenanceError,
    SourceScope,
    read_source_state,
    sha256_file,
    verify_artifact,
    write_provenance,
)
from cortex_bench_harness.campaign_config import (  # noqa: E402
    CampaignConfigError,
    load_campaign_config,
)

BUILD_SCHEMA_VERSION = "cortex-bench-artifact-build/1"


def checkout_root(config_source: str) -> Path:
    """The checkout this campaign document belongs to, derived rather than declared.

    Same derivation as launch-paid-campaign.py, so the source a build fingerprints and the source
    a launch verifies against cannot be two different trees.
    """
    source = Path(config_source).resolve()
    campaigns = source.parent
    if campaigns.name != "campaigns" or campaigns.parent.name != "benchmark":
        raise ArtifactBuildError(
            f"cannot derive the repository checkout from {source}: expected it under "
            "<checkout>/benchmark/campaigns/")
    return campaigns.parent.parent


def place(built: Path, declared: Path) -> Path:
    """Put a freshly built artifact where the campaign says the artifact lives.

    A name mismatch is refused rather than renamed. The declared filename carries the package
    version, so a build whose name has moved means the campaign document is describing a release
    that no longer exists -- and silently packing the new bytes under the old name would hide
    exactly that.
    """
    if built.name != declared.name:
        raise ArtifactBuildError(
            f"built {built.name} but the campaign pins {declared.name}. The package version moved; "
            "update the campaign's manifest paths and cli_version to match")
    declared.parent.mkdir(parents=True, exist_ok=True)
    if built.resolve() != declared.resolve():
        shutil.copy2(built, declared)
    return declared


def record(artifact: Path, checkout: Path, scope: SourceScope, built_at: str) -> dict[str, object]:
    state = read_source_state(checkout, scope)
    sidecar = write_provenance(artifact, state, built_at=built_at)
    return {
        "artifact": str(artifact), "sha256": sha256_file(artifact),
        "provenance": str(sidecar), "commit": state.commit, "dirty": state.dirty,
        "source_files": state.file_count, "fingerprint": state.fingerprint,
    }


def build(arguments: argparse.Namespace) -> dict[str, object]:
    config = load_campaign_config(arguments.config)
    checkout = checkout_root(config.source)
    wheel_target = Path(str(config.manifest["wheel_path"]))
    npm_target = Path(str(config.manifest["npm_artifact_path"]))
    built_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    outputs: dict[str, object] = {}

    if not arguments.only or arguments.only == "wheel":
        wheel = place(build_harness_wheel(HARNESS), wheel_target)
        outputs["wheel"] = record(wheel, checkout, WHEEL_SCOPE, built_at)

    if not arguments.only or arguments.only == "npm":
        with tempfile.TemporaryDirectory(prefix="cortex-bench-pack-") as staging:
            packed = build_offline_npm_artifact(checkout, Path(staging))
            npm = place(packed, npm_target)
        outputs["npm_artifact"] = record(npm, checkout, NPM_SCOPE, built_at)

    # Prove the gate the launcher will apply passes right now. A build that cannot immediately
    # satisfy its own verifier is a build that would strand the operator at launch, and this is the
    # cheapest possible place to discover that.
    verified = {}
    for key, scope, target in (
        ("wheel", WHEEL_SCOPE, wheel_target), ("npm_artifact", NPM_SCOPE, npm_target),
    ):
        if key in outputs:
            verified[key] = verify_artifact(target, checkout, scope)

    return {
        "ok": True, "schema_version": BUILD_SCHEMA_VERSION, "config": config.source,
        "campaign": config.campaign, "checkout": str(checkout), "built_at": built_at,
        "built": outputs, "verified": verified,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="build-trial-artifacts.py",
        description=(
            "Build both trial artifacts from this checkout's current source, into the paths the "
            "campaign document pins, each with a provenance record the launcher verifies."),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--config", required=True, help="Campaign YAML path")
    parser.add_argument(
        "--only", choices=("wheel", "npm"), default=None,
        help="Build one artifact instead of both. The other keeps whatever provenance it has, "
             "which the launcher still checks")
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    try:
        document = build(arguments)
    except (ArtifactBuildError, ProvenanceError, CampaignConfigError, OSError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, sort_keys=True), file=sys.stderr)
        return 1
    print(json.dumps(document, indent=2, sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
