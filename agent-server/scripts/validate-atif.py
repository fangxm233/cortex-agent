# input:  ATIF path, uv, PyPI harbor 0.20.0
# output: structured Harbor validation result
# pos:    Ephemeral authoritative ATIF validation runner
# >>> If I am updated, update my header and folder CORTEX.md <<<

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

HARBOR_VERSION = "0.20.0"
RUNNER = r"""
import importlib.metadata
import json
from pathlib import Path
import sys
from harbor.utils.trajectory_validator import TrajectoryValidator
validator = TrajectoryValidator()
ok = validator.validate(Path(sys.argv[1]))
print(json.dumps({
    "ok": ok,
    "errors": validator.get_errors(),
    "validator": "harbor.utils.trajectory_validator.TrajectoryValidator",
    "harbor_version": importlib.metadata.version("harbor"),
}, separators=(",", ":")))
raise SystemExit(0 if ok else 1)
"""


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(
        description="Validate one ATIF trajectory with Harbor's authoritative validator.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python3 scripts/validate-atif.py --trajectory-file ./artifacts/trajectory.json\n"
            "  cat trajectory.json | python3 scripts/validate-atif.py --trajectory-file -"
        ),
    )
    value.add_argument("--trajectory-file", required=True, help="ATIF JSON file, or - for stdin")
    return value


def emit_failure(reason: str, detail: str) -> int:
    print(json.dumps({"ok": False, "reason": reason, "detail": detail}, separators=(",", ":")),
          file=sys.stderr)
    return 1


def run_command(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, capture_output=True, text=True, check=False)


def provision(uv: str, environment: Path) -> tuple[Path | None, str | None]:
    created = run_command([uv, "venv", "--python", "3.12", str(environment)])
    if created.returncode != 0:
        return None, created.stderr.strip() or created.stdout.strip()
    python = environment / "bin" / "python"
    installed = run_command([
        uv, "pip", "install", "--python", str(python), f"harbor=={HARBOR_VERSION}",
    ])
    if installed.returncode != 0:
        return None, installed.stderr.strip() or installed.stdout.strip()
    return python, None


def resolve_trajectory(value: str, temporary: Path) -> tuple[Path | None, str | None]:
    if value == "-":
        trajectory = temporary / "stdin-trajectory.json"
        trajectory.write_bytes(sys.stdin.buffer.read())
        return trajectory, None
    trajectory = Path(value).resolve()
    if trajectory.is_file():
        return trajectory, None
    return None, str(trajectory)


def main() -> int:
    args = parser().parse_args()
    uv = shutil.which("uv")
    if uv is None:
        return emit_failure("uv_not_found", "Install uv and ensure it is on PATH")
    with tempfile.TemporaryDirectory(prefix="cortex-atif-validator-") as temporary:
        root = Path(temporary)
        trajectory, missing = resolve_trajectory(args.trajectory_file, root)
        if trajectory is None:
            return emit_failure("file_not_found", missing or args.trajectory_file)
        python, error = provision(uv, root / "venv")
        if python is None:
            return emit_failure("provision_failed", error or "unknown uv failure")
        validated = run_command([str(python), "-c", RUNNER, str(trajectory)])
        stream = sys.stdout if validated.returncode == 0 else sys.stderr
        print((validated.stdout or validated.stderr).strip(), file=stream)
        return validated.returncode


if __name__ == "__main__":
    raise SystemExit(main())
