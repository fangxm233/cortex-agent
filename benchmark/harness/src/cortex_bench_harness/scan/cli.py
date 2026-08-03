# input:  explicit artifact flags and JSON scan policy file or stdin
# output: redacted structured scan result and process exit status
# pos:    Trial artifact scanner command-line interface
# >>> If I am updated, update my header and folder CORTEX.md <<<

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import TextIO

from .models import ArtifactInventory, ArtifactReadError, ScanPolicy
from .scanner import scan_trial_artifacts

EXAMPLES = """Examples:
  python -m cortex_bench_harness.scan \\
    --stdout-file stdout.txt --stderr-file stderr.txt \\
    --events-file events.jsonl --manifest-file cortex-bench-harness-manifest.json \\
    --workspace-diff-file workspace.diff --config-file scan-policy.json
  cat scan-policy.json | python -m cortex_bench_harness.scan \\
    --stdout-file stdout.txt --stderr-file stderr.txt \\
    --events-file events.jsonl --manifest-file cortex-bench-harness-manifest.json \\
    --workspace-diff-file workspace.diff --config-file -
"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m cortex_bench_harness.scan",
        description="Scan all five required benchmark trial artifact sources.",
        epilog=EXAMPLES,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--stdout-file", required=True)
    parser.add_argument("--stderr-file", required=True)
    parser.add_argument("--events-file", required=True)
    parser.add_argument("--manifest-file", required=True)
    parser.add_argument("--workspace-diff-file", required=True)
    parser.add_argument("--config-file", required=True, help="JSON policy path or - for stdin")
    return parser


def main(
    argv: Sequence[str] | None = None, *, stdin: TextIO | None = None,
    stdout: TextIO | None = None,
) -> int:
    arguments = build_parser().parse_args(argv)
    output = stdout or sys.stdout
    try:
        policy = _load_policy(arguments.config_file, stdin or sys.stdin)
        report = scan_trial_artifacts(_artifacts(arguments), policy)
        if report.missing_sources:
            _write_json(output, _read_error(report.missing_sources[0]))
            return 2
    except ArtifactReadError as error:
        _write_json(output, _read_error(error.source))
        return 2
    except (OSError, ValueError, json.JSONDecodeError):
        _write_json(output, _config_error())
        return 2
    _write_json(output, report.as_dict())
    return report.exit_code


def _artifacts(arguments: argparse.Namespace) -> ArtifactInventory:
    sources = {
        "stdout": Path(arguments.stdout_file),
        "stderr": Path(arguments.stderr_file),
        "events": Path(arguments.events_file),
        "manifest": Path(arguments.manifest_file),
        "workspace_diff": Path(arguments.workspace_diff_file),
    }
    return ArtifactInventory(
        sources=sources,
        expected_sources=frozenset(sources),
        trial_roots=tuple(dict.fromkeys(path.parent for path in sources.values())),
    )


def _load_policy(config_file: str, stdin: TextIO) -> ScanPolicy:
    text = stdin.read() if config_file == "-" else Path(config_file).read_text()
    document = json.loads(text)
    if not isinstance(document, dict):
        raise ValueError("scan policy must be a JSON object")
    secrets = document.get("secrets")
    if not isinstance(secrets, dict):
        raise ValueError("scan policy secrets must be an object")
    return ScanPolicy(
        secrets=secrets,
        repository_checkout=document.get("repository_checkout"),
        hostname=document.get("hostname"),
    )


def _read_error(source: str) -> dict[str, object]:
    return {
        "ok": False,
        "error": "artifact_unreadable",
        "source": source,
        "hint": f"Provide a readable file for --{source.replace('_', '-')}-file.",
    }


def _config_error() -> dict[str, object]:
    return {
        "ok": False,
        "error": "invalid_scan_config",
        "source": "config",
        "hint": "Provide JSON with non-empty secrets, repository_checkout, and hostname.",
    }


def _write_json(output: TextIO, document: dict[str, object]) -> None:
    output.write(json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n")
