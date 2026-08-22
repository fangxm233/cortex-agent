# input:  explicit suite/host paths and preflight-or-run mode
# output: structured zero-provider preflight or one paid full-suite execution
# pos:    Full-suite command-line entry
# >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

from cortex_bench_harness.launcher.deepseek_paid_smoke import (
    load_deepseek_relay_credential,
)

from .config import HostInputs, SuiteSpecError, load_suite_spec
from .preflight import PreflightError, preflight
from .runner import FullSuiteRunner
from .state import RunStateError

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cortex-bench-tb21-full-pi",
        description="Launch the pinned 89-task PI suite with one proxy per task.",
        epilog=(
            "Examples:\n"
            "  cortex-bench-tb21-full-pi --spec benchmark/external-suites/terminal-bench-2.1-full-pi.yaml --tasks-dir /srv/tb21/tasks --run-dir /srv/runs/preflight --image-inventory /srv/tb21/images.json --harbor /srv/harbor --node-root /srv/node --pi-root /srv/pi --gateway /tmp/fake-gateway.yaml --proxy-listen-host 0.0.0.0 --proxy-advertised-host proxy.full.invalid --preflight\n"
            "  cortex-bench-tb21-full-pi --spec benchmark/external-suites/terminal-bench-2.1-full-pi.yaml --tasks-dir /srv/tb21/tasks --run-dir /srv/runs/run-001 --image-inventory /srv/tb21/images.json --harbor /srv/harbor --node-root /srv/node --pi-root /srv/pi --gateway /run/secrets/gateway.yaml --proxy-listen-host 0.0.0.0 --proxy-advertised-host proxy.full.invalid --run"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    _paths(parser)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--preflight", action="store_const", dest="mode", const="preflight")
    mode.add_argument("--run", action="store_const", dest="mode", const="run")
    parser.set_defaults(mode="preflight")
    return parser


def _paths(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--spec", required=True, help="suite YAML path, or - for stdin")
    for flag in ("tasks-dir", "run-dir", "image-inventory", "harbor", "node-root", "pi-root", "gateway"):
        parser.add_argument(f"--{flag}", required=True)
    parser.add_argument("--proxy-listen-host", required=True)
    parser.add_argument("--proxy-advertised-host", required=True)


def main(argv: list[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    temporary: Path | None = None
    try:
        spec_path, temporary = _spec_path(arguments.spec)
        spec = load_suite_spec(spec_path)
        inputs = _host_inputs(arguments)
        report = preflight(spec, inputs)
        if arguments.mode == "run":
            _require_run_ready(spec.outstanding_prerequisites)
            credential = load_deepseek_relay_credential(inputs.gateway)
            report = FullSuiteRunner(spec, inputs, credential).run()
        print(json.dumps(report, sort_keys=True), flush=True)
        return 0 if report.get("ok") else 1
    except (OSError, ValueError, SuiteSpecError, PreflightError, RunStateError, RuntimeError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, sort_keys=True), file=sys.stderr)
        return 1
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _require_run_ready(prerequisites: tuple[str, ...]) -> None:
    if prerequisites:
        names = ", ".join(prerequisites)
        raise PreflightError(f"paid run is blocked by outstanding prerequisites: {names}")


def _spec_path(value: str) -> tuple[Path, Path | None]:
    if value != "-":
        return Path(value), None
    descriptor, name = tempfile.mkstemp(dir=Path.cwd(), suffix=".yaml")
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(sys.stdin.read())
    return Path(name), Path(name)


def _host_inputs(arguments: argparse.Namespace) -> HostInputs:
    return HostInputs(
        tasks_dir=Path(arguments.tasks_dir), run_dir=Path(arguments.run_dir),
        image_inventory=Path(arguments.image_inventory), harbor=Path(arguments.harbor),
        node_root=Path(arguments.node_root), pi_root=Path(arguments.pi_root),
        gateway=Path(arguments.gateway), proxy_listen_host=arguments.proxy_listen_host,
        proxy_advertised_host=arguments.proxy_advertised_host,
    )


if __name__ == "__main__":
    raise SystemExit(main())
