# input:  a staged external task corpus and the images its inventory pins
# output: per-task Harbor inputs shaped exactly like a committed task copy
# pos:    External corpus staging boundary
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# Terminal-Bench ships each task as a directory that also carries its own Dockerfile, its README
# and its SOLUTION. A committed task copy in this repository carries three things instead —
# instruction.md, task.toml and tests/ — because those are what Harbor reads and the rest is
# either unused or must never be within reach of the thing being measured. This module is the
# provisioning script's `stage_task_directory` written once, in Python, for corpora that are too
# large to commit: it makes an external task look exactly like a committed one.
#
# Two lines of the task's own task.toml are rewritten and nothing else is:
#   * `docker_image` becomes the digest-pinned ref the inventory recorded, because admission
#     compares the task's declared image against the pinned one and refuses a tag;
#   * `allow_internet` becomes the `network_mode`/`os` pair that replaced it, because admission
#     refuses the deprecated field outright. The value is carried across rather than assumed:
#     a task that declared no internet keeps declaring none.
# The rewrite is textual and line-anchored, so every other byte of a corpus file survives.

import re
import shutil
from collections.abc import Iterable
from pathlib import Path

STAGED_ENTRIES = ("instruction.md", "task.toml", "tests")
DOCKER_IMAGE_LINE = re.compile(r"^docker_image = .*$", re.MULTILINE)
ALLOW_INTERNET_LINE = re.compile(r"^allow_internet = (true|false)$", re.MULTILINE)
NETWORK_MODES = {"true": "public", "false": "no-network"}


class ExternalCorpusError(RuntimeError):
    """A staged task could not be turned into an admissible Harbor task input."""


def stage_task_input(source: Path, target: Path, image_ref: str) -> Path:
    """Copy one corpus task into `target`, keeping only what Harbor reads.

    Staging is idempotent and content-addressed by the caller's directory choice: an existing
    target is replaced, so a re-run of the same campaign restages rather than half-trusting what
    a previous interrupted run left behind.
    """
    if not (source / "task.toml").is_file():
        raise ExternalCorpusError(f"staged task has no task.toml: {source}")
    staged = _copy_entries(source, target, STAGED_ENTRIES)
    if "instruction.md" not in staged:
        raise ExternalCorpusError(f"staged task has no instruction.md: {source}")
    document = (target / "task.toml").read_text(encoding="utf-8")
    (target / "task.toml").write_text(_rewrite(document, image_ref, source), encoding="utf-8")
    return target


def _copy_entries(source: Path, target: Path, entries: Iterable[str]) -> set[str]:
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    staged: set[str] = set()
    for name in entries:
        item = source / name
        if item.is_dir():
            shutil.copytree(item, target / name)
        elif item.is_file():
            shutil.copy2(item, target / name)
        else:
            continue
        staged.add(name)
    return staged


def _rewrite(document: str, image_ref: str, source: Path) -> str:
    document, replaced = DOCKER_IMAGE_LINE.subn(f'docker_image = "{image_ref}"', document)
    if replaced != 1:
        raise ExternalCorpusError(
            f"staged task.toml declares {replaced} docker_image lines, expected one: {source}")
    match = ALLOW_INTERNET_LINE.search(document)
    if match is None:
        return document
    mode = NETWORK_MODES[match.group(1)]
    return ALLOW_INTERNET_LINE.sub(f'network_mode = "{mode}"\nos = "linux"', document, count=1)
