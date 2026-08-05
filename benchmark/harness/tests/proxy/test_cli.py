# input:  Python module CLI and synthetic credential on stdin
# output: help, structured startup, argv secrecy, and signal cleanup
# pos:    Proxy command-line contract tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import pytest

from cortex_bench_harness.proxy import ProxyBudget
from synthetic import SyntheticUpstream

REAL_CREDENTIAL = "sk-ant-SYNTHETIC-CLI-UNIQUE"


def test_module_cli_help_is_copyable() -> None:
    result = subprocess.run(
        [_python(), "-m", "cortex_bench_harness.proxy", "--help"],
        capture_output=True, text=True, timeout=20,
    )
    assert result.returncode == 0
    assert "usage:" in result.stdout
    assert "Examples:" in result.stdout
    assert "--credential-file" in result.stdout
    assert "--max-request-cost-usd" in result.stdout
    assert "default: 127.0.0.1" in result.stdout


def test_module_cli_reads_credential_from_stdin_not_argv(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        command = _start_command(tmp_path, upstream.base_url)
        process = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True,
        )
        assert process.stdin is not None and process.stdout is not None
        process.stdin.write(REAL_CREDENTIAL)
        process.stdin.close()
        process.stdin = None
        started = process.stdout.readline()
        process.terminate()
        return_code = process.wait(timeout=20)
        remaining = process.stdout.read()
        stderr = process.stderr.read() if process.stderr else ""
    document = json.loads(started)
    assert document["ok"] is True
    assert document["trial_id"] == "trial-cli"
    assert document["base_url"].startswith("http://127.0.0.1:")
    assert document["dummy_token"]
    assert return_code == 0
    assert REAL_CREDENTIAL not in repr(command) + started + remaining + stderr


def test_cli_rejects_nonfinite_budget_with_structured_error(tmp_path: Path) -> None:
    with SyntheticUpstream() as upstream:
        command = _start_command(tmp_path, upstream.base_url)
        command[command.index("--budget-usd") + 1] = "NaN"
        result = subprocess.run(
            command, input=REAL_CREDENTIAL, capture_output=True, text=True, timeout=20,
        )
    document = json.loads(result.stderr)
    assert result.returncode == 1
    assert result.stdout == ""
    assert document["ok"] is False
    assert "finite decimal" in document["error"]
    assert "Traceback" not in result.stderr


def test_cli_missing_required_input_uses_structured_error() -> None:
    result = subprocess.run(
        [_python(), "-m", "cortex_bench_harness.proxy", "--trial-id", "trial-cli"],
        capture_output=True, text=True, timeout=20,
    )
    document = json.loads(result.stderr)
    assert result.returncode == 1
    assert result.stdout == ""
    assert document["ok"] is False
    assert "required" in document["error"]


def test_budget_model_rejects_nonfinite_decimals() -> None:
    with pytest.raises(ValueError, match="finite"):
        ProxyBudget(
            Decimal("Infinity"), Decimal("1"), Decimal("1"), Decimal("1"),
        )


def _python() -> str:
    return sys.executable


def _start_command(tmp_path: Path, upstream_url: str) -> list[str]:
    deadline = datetime.now(UTC) + timedelta(minutes=5)
    return [
        _python(), "-m", "cortex_bench_harness.proxy",
        "--trial-id", "trial-cli", "--upstream-base-url", upstream_url,
        "--credential-file", "-", "--bound-source-ip", "127.0.0.1",
        "--capability-runner", "claude", "--capability-provider", "anthropic",
        "--capability-protocol", "anthropic-messages",
        "--capability-credential-kind", "api-key-bearer",
        "--frozen-model", "claude-synthetic-1",
        "--absolute-deadline", deadline.isoformat(), "--budget-usd", "5",
        "--max-request-cost-usd", "5",
        "--input-cost-per-million-usd", "1000000",
        "--output-cost-per-million-usd", "1000000",
        "--log-path", str(tmp_path / "cli-proxy.jsonl"),
    ]
