# input:  pytest, runtime_image_builder_fixtures, temporary trees
# output: bounded Python staging and strict fake-tool proofs
# pos:    Safety contracts for runtime image builder fixtures
# >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

import os
import shutil
import subprocess
from pathlib import Path

import pytest

from runtime_image_builder_fixtures import (
    FAKE_PYTHON,
    PYTHON_SENTINEL,
    SENTINEL_CONTENT,
    assert_bounded_tree,
    assert_staged_verifier,
    executable,
    fake_managed_python,
    fake_task_builder_tools,
)


@pytest.mark.parametrize("mode", ("--managed-python", "--system"))
def test_fake_uv_finds_only_a_tiny_local_python(tmp_path: Path, mode: str) -> None:
    tools = fake_task_builder_tools(tmp_path, "1" * 40)
    result = subprocess.run(
        [str(tools / "uv"), "python", "find", mode, "3.12"],
        capture_output=True, text=True, check=True,
    )
    python = tmp_path / "fake-python/bin/python3"
    assert result.stdout.strip() == str(python)
    assert python.resolve() == python
    assert os.access(python, os.X_OK)
    assert_bounded_tree(python.parent.parent, {"bin", "lib", "lib/python3.12"},
                        {"bin/python3", PYTHON_SENTINEL})
    assert (python.parent.parent / PYTHON_SENTINEL).read_bytes() == SENTINEL_CONTENT


@pytest.mark.parametrize("arguments,expected_status", (
    (["-c", "import sys; sys.exit(0)"], 0),
    ([], 99),
    (["--version"], 99),
    (["-c", "import sys; sys.exit(1)"], 99),
    (["-c", "import sys; sys.exit(0)", "extra"], 99),
))
def test_fake_python_accepts_only_relocation_smoke(
    tmp_path: Path, arguments: list[str], expected_status: int,
) -> None:
    python = fake_managed_python(tmp_path)
    result = subprocess.run([str(python), *arguments], capture_output=True, text=True)
    assert result.returncode == expected_status


@pytest.mark.parametrize("arguments", (
    [], ["python", "find"], ["python", "find", "--managed-python", "3.13"],
    ["python", "install", "3.12"], ["pip", "install", "--target", "unused"],
    ["unrecognized", "--target", "unused"],
))
def test_fake_uv_rejects_unsupported_commands(tmp_path: Path, arguments: list[str]) -> None:
    tools = fake_task_builder_tools(tmp_path, "1" * 40)
    result = subprocess.run(
        [str(tools / "uv"), *arguments], cwd=tmp_path, capture_output=True, text=True,
    )
    assert result.returncode == 99
    assert "unsupported fixture uv invocation" in result.stderr
    assert not (tmp_path / "unused").exists()


def staged_verifier(root: Path) -> tuple[Path, Path]:
    python = fake_managed_python(root)
    verifier = root / "verifier"
    shutil.copytree(python.parent.parent, verifier / "python")
    (verifier / "site-packages").mkdir()
    for name in ("apt-get", "curl", "uvx"):
        executable(verifier / "bin" / name, "#!/bin/sh\nexit 0\n")
    return verifier, python.parent.parent


@pytest.mark.parametrize("mutation", ("extra-file", "symlink", "oversized", "missing"))
def test_staged_verifier_requires_the_exact_small_regular_tree(
    tmp_path: Path, mutation: str,
) -> None:
    verifier, python_root = staged_verifier(tmp_path)
    assert_staged_verifier(verifier, python_root)
    mutations = {
        "extra-file": lambda: (verifier / "unexpected").write_bytes(b"extra"),
        "symlink": lambda: (verifier / "python/bin/python3").symlink_to(python_root / "bin/python3"),
        "oversized": lambda: (verifier / "bin/uvx").write_bytes(b"x" * 8192),
        "missing": lambda: (verifier / "python" / PYTHON_SENTINEL).unlink(),
    }
    if mutation == "symlink":
        (verifier / "python/bin/python3").unlink()
    mutations[mutation]()
    with pytest.raises(AssertionError):
        assert_staged_verifier(verifier, python_root)
    assert (python_root / "bin/python3").read_text() == FAKE_PYTHON
