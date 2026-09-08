# input:  pathlib, shell templates, temporary builder trees
# output: fake build tools and bounded staged-verifier assertions
# pos:    Local tool fixtures for runtime image builder tests
# >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

import os
import shlex
import stat
import sys
from itertools import islice
from pathlib import Path

FAKE_PYTHON = """#!/bin/sh
set -eu
if [ "$#" = 2 ] && [ "$1" = -c ] && [ "$2" = 'import sys; sys.exit(0)' ]; then
  exit 0
fi
printf 'unsupported fixture python invocation\n' >&2
exit 99
"""
PYTHON_SENTINEL = "lib/python3.12/fixture-sentinel.txt"
SENTINEL_CONTENT = b"tiny managed Python library fixture\n"
FAKE_UV = """#!/usr/bin/python3
import sys
from pathlib import Path
args = sys.argv[1:]
python = __FAKE_PYTHON__
if args in (["python", "find", "--managed-python", "3.12"],
            ["python", "find", "--system", "3.12"]):
    print(python)
    raise SystemExit(0)
if len(args) == 15 and args[:2] == ["pip", "install"]:
    expected = ["pip", "install", "--offline", "--no-index", "--find-links", args[5],
                "--python", python, "--python-version", "3.12", "--python-platform",
                "x86_64-manylinux_2_17", "--target", args[13], "pytest==8.4.1"]
    if args == expected:
        Path(args[13]).mkdir(parents=True, exist_ok=True)
        raise SystemExit(0)
print("unsupported fixture uv invocation: " + repr(args), file=sys.stderr)
raise SystemExit(99)
"""
FAKE_GIT = """#!/bin/sh
set -eu
if [ "$#" = 4 ] && [ "$1" = -C ] && [ "$3" = rev-parse ] && [ "$4" = HEAD ]; then
  printf '%s\n' __SOURCE_COMMIT__
  exit 0
fi
exit 99
"""
FAKE_CURL = """#!/bin/sh
set -eu
while [ $# -gt 0 ]; do [ "$1" = -o ] && { output=$2; break; }; shift; done
printf 'fixture wheel' > "$output"
"""
FAKE_DOCKER = """#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$DOCKER_CALLS"
if [ "$1" = build ]; then
  for context do :; done
  grep -q 'debian@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818' "$context/Dockerfile"
  case "$VENDOR" in
    pi)
      test -x "$context/node-runtime/bin/node"
      test -x "$context/vendor-runtime/dist/cli.js"
      grep -q '@earendil-works/pi-coding-agent' "$context/vendor-runtime/package.json"
      grep -q '/opt/vendor-runtime/dist/cli.js' "$context/Dockerfile"
      ! grep -Eq '/usr/local/bin/(claude|codex)' "$context/Dockerfile"
      ;;
    claude-code)
      test -x "$context/vendor-runtime/claude"
      test -x "$context/node-runtime/bin/node"
      grep -q '/usr/local/bin/claude' "$context/Dockerfile"
      ! grep -Eq '/usr/local/bin/(pi|codex)' "$context/Dockerfile"
      ;;
    codex)
      test -x "$context/node-runtime/bin/node"
      test -x "$context/vendor-runtime/bin/codex.js"
      grep -q '@openai/codex' "$context/vendor-runtime/package.json"
      grep -q '/usr/local/bin/codex' "$context/Dockerfile"
      ! grep -Eq '/usr/local/bin/(pi|claude)' "$context/Dockerfile"
      ;;
    *) exit 97;;
  esac
  ! grep -Rq 'mariozechner/pi-coding-agent' "$context"
  exit 0
fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  printf '%s\n' "$FAKE_IMAGE_REF"
  exit 0
fi
if [ "$1" = run ]; then
  case "$*" in
    *'/tmp/vendor-runtime-preflight.js'*) ;;
    *) exit 96;;
  esac
  exit 0
fi
exit 99
"""
FAKE_TASK_DOCKER = """#!/bin/sh
set -eu
printf '%s %s\n' "${SOURCE_DATE_EPOCH:-unset}" "$*" >> "$DOCKER_CALLS"
if [ "$1" = buildx ] && [ "$2" = build ]; then
  for context do :; done
  /usr/bin/python3 __FIXTURE_HELPER__ "$context/verifier" __PYTHON_ROOT__
  test -x "$context/verifier/bin/apt-get"
  vendor=${context##*/}
  case $vendor in
    pi) test -x "$context/vendor-runtime/dist/cli.js";;
    claude-code) test -x "$context/vendor-runtime/claude";;
    codex) test -x "$context/vendor-runtime/bin/codex.js";;
    cortex-smoke) test -x "$context/pi-agent/dist/cli.js"; test -f "$context/npm/package.json";;
    *) exit 97;;
  esac
  exit 0
fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  case "$*" in *--format*) :;; *) exit 0;; esac
  case "$*" in *'{{.Id}}'*) printf '%s\n' "${SOURCE_IMAGE_ID:-${3##*@}}"; exit 0;; esac
  case "$*" in *'{{json .Config}}'*) printf '%s\n' '{"Env":["PATH=/usr/bin"],"Volumes":null}'; exit 0;; esac
  tag=$3; key=${tag#*:}
  case $key in
    alpha-vendor-pi-0.82.1) n=6;; alpha-claude-code-2.1.232) n=7;; alpha-codex-0.148.0) n=8;;
    beta-vendor-pi-0.82.1) n=9;; beta-claude-code-2.1.232) n=10;; beta-codex-0.148.0) n=11;;
    gamma-vendor-pi-0.82.1) n=12;; gamma-claude-code-2.1.232) n=13;; gamma-codex-0.148.0) n=14;;
    alpha-cortex-smoke-2026.8.6) n=15;;
    alpha-cortex-pi-0.82.1) n=16;; beta-cortex-pi-0.82.1) n=17;; gamma-cortex-pi-0.82.1) n=18;;
    *) exit 98;;
  esac
  printf '%s@sha256:%064x\n' "${tag%%:*}" "$n"; exit 0
fi
if [ "$1" = load ]; then exit 0; fi
if [ "$1" = run ]; then exit 0; fi
exit 99
"""


def executable(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    path.chmod(0o755)
    return path


def fake_docker(root: Path) -> Path:
    return executable(root / "bin/docker", FAKE_DOCKER)


def fake_managed_python(root: Path) -> Path:
    # Never link a host interpreter here: production copies its entire parent root.
    python = executable(root / "fake-python/bin/python3", FAKE_PYTHON)
    sentinel = python.parent.parent / PYTHON_SENTINEL
    sentinel.parent.mkdir(parents=True)
    sentinel.write_bytes(SENTINEL_CONTENT)
    return python


def fake_task_builder_tools(root: Path, source_commit: str) -> Path:
    binary = root / "task-bin"
    python = fake_managed_python(root)
    executable(binary / "git", FAKE_GIT.replace("__SOURCE_COMMIT__", shlex.quote(source_commit)))
    executable(binary / "uv", FAKE_UV.replace("__FAKE_PYTHON__", repr(str(python))))
    executable(binary / "curl", FAKE_CURL)
    docker = FAKE_TASK_DOCKER.replace("__FIXTURE_HELPER__", shlex.quote(__file__))
    docker = docker.replace("__PYTHON_ROOT__", shlex.quote(str(python.parent.parent)))
    executable(binary / "docker", docker)
    return binary


def assert_bounded_tree(root: Path, directories: set[str], files: set[str]) -> None:
    expected = directories | files
    entries = list(islice(root.rglob("*"), len(expected) + 1))
    assert {str(path.relative_to(root)) for path in entries} == expected
    for relative in directories:
        assert stat.S_ISDIR((root / relative).lstat().st_mode), relative
    for relative in files:
        metadata = (root / relative).lstat()
        assert stat.S_ISREG(metadata.st_mode), relative
        assert metadata.st_size < 8192, relative


def assert_staged_verifier(verifier: Path, python_root: Path) -> None:
    directories = {"bin", "site-packages", "python", "python/bin",
                   "python/lib", "python/lib/python3.12"}
    files = {"bin/apt-get", "bin/curl", "bin/uvx", "python/bin/python3",
             f"python/{PYTHON_SENTINEL}"}
    assert_bounded_tree(verifier, directories, files)
    python = verifier / "python/bin/python3"
    assert os.access(python, os.X_OK)
    assert python.read_bytes() == (python_root / "bin/python3").read_bytes()
    assert (verifier / "python" / PYTHON_SENTINEL).read_bytes() == SENTINEL_CONTENT


if __name__ == "__main__":
    assert_staged_verifier(Path(sys.argv[1]), Path(sys.argv[2]))
