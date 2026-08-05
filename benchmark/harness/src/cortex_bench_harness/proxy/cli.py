# input:  explicit proxy flags and host credential file or stdin
# output: structured startup/stopped JSON and foreground proxy
# pos:    Trial proxy command-line interface
# >>> If I am updated, update my header and folder CORTEX.md <<<

import argparse
import json
import signal
import sys
import threading
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Sequence

from ..launcher.credential_capabilities import CredentialCapabilityKey
from .adapters import AdapterUnavailable, select_adapter
from .models import ProxyBudget
from .server import TrialProxyHandle, start_trial_proxy


class CliInputError(ValueError):
    pass


class StructuredArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise CliInputError(message)


class HelpFormatter(
    argparse.ArgumentDefaultsHelpFormatter,
    argparse.RawDescriptionHelpFormatter,
):
    pass


EPILOG = """Examples:
  printf 'synthetic-key' | python -m cortex_bench_harness.proxy \\
    --trial-id trial-1 --upstream-base-url http://127.0.0.1:9000 \\
    --credential-file - --bound-source-ip 172.20.0.10 \\
    --capability-runner claude --capability-provider anthropic \\
    --capability-protocol anthropic-messages \\
    --capability-credential-kind api-key-bearer \\
    --frozen-model claude-synthetic-1 \\
    --absolute-deadline 2099-01-02T03:04:05Z --budget-usd 5 \\
    --max-request-cost-usd 1 --input-cost-per-million-usd 3 \\
    --output-cost-per-million-usd 15 \\
    --log-path ./proxy.jsonl
"""


def build_parser() -> argparse.ArgumentParser:
    parser = StructuredArgumentParser(
        prog="python -m cortex_bench_harness.proxy",
        description="Start one host-side credential proxy for a benchmark trial.",
        epilog=EPILOG, formatter_class=HelpFormatter,
    )
    _add_required_arguments(parser)
    parser.add_argument(
        "--listen-host", default="127.0.0.1", help="Host address for the listener",
    )
    parser.add_argument(
        "--advertised-host", help="Container-visible listener address",
    )
    return parser


def _add_required_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--trial-id", required=True)
    parser.add_argument("--upstream-base-url", required=True)
    parser.add_argument("--credential-file", required=True,
                        help="Host credential path, or - for stdin")
    parser.add_argument("--bound-source-ip", required=True)
    parser.add_argument("--capability-runner", required=True,
                        help="Capability key runner_or_backend member")
    parser.add_argument("--capability-provider", required=True,
                        help="Capability key provider member")
    parser.add_argument("--capability-protocol", required=True,
                        help="Capability key protocol member")
    parser.add_argument("--capability-credential-kind", required=True,
                        help="Capability key credential_kind member")
    parser.add_argument("--frozen-model", required=True,
                        help="The arm's frozen model; every other model is refused")
    parser.add_argument("--absolute-deadline", required=True, type=_datetime)
    parser.add_argument("--budget-usd", required=True, type=_decimal)
    parser.add_argument("--max-request-cost-usd", required=True, type=_decimal)
    parser.add_argument("--input-cost-per-million-usd", required=True, type=_decimal)
    parser.add_argument("--output-cost-per-million-usd", required=True, type=_decimal)
    parser.add_argument("--log-path", required=True, type=Path)


def _datetime(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise argparse.ArgumentTypeError(
            f"invalid UTC timestamp {value!r}; use ISO 8601 with a timezone") from error
    if parsed.tzinfo is None:
        raise argparse.ArgumentTypeError("absolute deadline must include a timezone")
    return parsed


def _decimal(value: str) -> Decimal:
    try:
        parsed = Decimal(value)
    except InvalidOperation as error:
        raise argparse.ArgumentTypeError(f"invalid decimal value {value!r}") from error
    if not parsed.is_finite():
        raise argparse.ArgumentTypeError(f"invalid finite decimal value {value!r}")
    return parsed


def _read_credential(source: str) -> str:
    if source == "-":
        return sys.stdin.read().strip()
    return Path(source).read_text().strip()


def _select_adapter(arguments: argparse.Namespace):
    key = CredentialCapabilityKey(
        arguments.capability_runner, arguments.capability_provider,
        arguments.capability_protocol, arguments.capability_credential_kind,
    )
    return select_adapter(
        key, upstream_base_url=arguments.upstream_base_url,
        credential=_read_credential(arguments.credential_file),
        frozen_model=arguments.frozen_model,
    )


def run(arguments: argparse.Namespace) -> int:
    budget = ProxyBudget(
        arguments.budget_usd, arguments.max_request_cost_usd,
        arguments.input_cost_per_million_usd, arguments.output_cost_per_million_usd,
    )
    handle = start_trial_proxy(
        trial_id=arguments.trial_id,
        upstream_base_url=arguments.upstream_base_url,
        adapter=_select_adapter(arguments),
        bound_source_ip=arguments.bound_source_ip,
        absolute_deadline=arguments.absolute_deadline,
        budget=budget, log_path=arguments.log_path,
        listen_host=arguments.listen_host,
        advertised_host=arguments.advertised_host,
    )
    stopped = threading.Event()
    _install_signal_handlers(stopped)
    print(json.dumps(_startup_document(handle), sort_keys=True), flush=True)
    stopped.wait()
    handle.stop()
    print(json.dumps({"ok": True, "state": "stopped",
                      "trial_id": handle.trial_id}, sort_keys=True), flush=True)
    return 0


def _install_signal_handlers(stopped: threading.Event) -> None:
    def stop(_signum: int, _frame: object) -> None:
        stopped.set()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)


def _startup_document(handle: TrialProxyHandle) -> dict[str, object]:
    return {
        "ok": True,
        "state": "started",
        "trial_id": handle.trial_id,
        "base_url": handle.base_url,
        "dummy_token": handle.dummy_token,
    }


def main(argv: Sequence[str] | None = None) -> int:
    try:
        arguments = build_parser().parse_args(argv)
        return run(arguments)
    except (AdapterUnavailable, OSError, ValueError) as error:
        print(json.dumps({"ok": False, "error": str(error)}), file=sys.stderr)
        return 1
