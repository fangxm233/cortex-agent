# input:  a campaign's tasks, their pinned images and the network its trials score under
# output: per-task evidence that the upstream verifier bootstraps, and the tasks no arm may be
#         paid to attempt until it does
# pos:    Pre-agent verifier bootstrap gate
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# A campaign spends its money on the agent phase and reads its answer from the verifier phase, and
# until now nothing checked that the second one worked. It does not always: an upstream
# Terminal-Bench `tests/test.sh` installs its own per-task dependencies before it runs pytest, and
# any reason that installation cannot happen -- no network, an intercepted apt-get, an interpreter
# the image never shipped -- produces a verifier that dies before collecting a single test. The
# script's last line writes reward 0 for that exactly as it does for a wrong answer, so the trial
# reads as an agent that failed. On 2026-08-27 that mechanism accounted for most of two full
# suites: seven arms failing the same 22 tasks in the same direction, none of which any of them
# was ever measured on.
#
# This module asks the question first, on the same pinned image, under the same network the
# campaign declares, with the same sealed environment the trial's own verifier phase runs under --
# and before any provider request is paid for.
#
# WHAT IT CAN AND CANNOT CONCLUDE. It runs the task's real test.sh on an image no agent has
# touched, so every test that needs a solution fails, and that is expected and uninteresting. The
# only question is whether the verifier RAN. Three answers, and the middle one is the point:
#
#   ok            the CTRF report names at least one test. The verifier bootstrapped; the failures
#                 are the missing solution and nothing is wrong with this task.
#   unavailable   the script asked pytest for a report and produced none, or produced one naming
#                 zero tests while the module it could not import is one the script itself
#                 installs. The verifier could not start. No arm may be paid to attempt this task.
#   inconclusive  zero tests, but the module it could not import is NOT one the script installs --
#                 so it is plausibly the solution the agent has not written yet, which no untouched
#                 image can have. The gate declines to judge rather than condemning a task for
#                 being unsolved.
#
# `inconclusive` is deliberate. A gate that guessed here would eventually exclude a task that
# works, which is the same class of silent, score-shaped error it exists to prevent.

import json
import re
import subprocess
from collections.abc import Iterable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from .campaign_config import CampaignConfig
from .launcher.runtime_mounts import (
    RUNTIME_TARGETS,
    runtime_agent_command,
    runtime_link_command,
)
from .launcher.trial_admission_io import atomic_write_json

GATE_SCHEMA_VERSION = "cortex-bench-verifier-gate/1"
GATE_REPORT_NAME = "verifier-gate.json"

STATUS_OK = "ok"
STATUS_UNAVAILABLE = "unavailable"
STATUS_INCONCLUSIVE = "inconclusive"

CONTAINER_TESTS = "/tests"
# Harbor puts the task's tests in place with `docker compose cp`, so inside the container /tests is
# a real root-owned writable directory, not a view of a host one. A probe that bind-mounted the
# corpus at /tests would differ from that in both directions: read-only refuses the `chmod +x`
# Harbor performs, and read-write would hand a container the host's pristine corpus to edit. So
# the mount lands somewhere else and the prelude copies it in.
CONTAINER_TESTS_SOURCE = "/opt/cortex-verifier-gate/tests"
CONTAINER_VERIFIER_LOGS = "/logs/verifier"
CONTAINER_AGENT_LOGS = "/logs/agent"
CTRF_NAME = "ctrf.json"
STDOUT_NAME = "test-stdout.txt"
# Enough of the verifier's own output to name what it could not import, and little enough that a
# task whose tests print megabytes does not become the report.
STDOUT_TAIL_BYTES = 4096
DEFAULT_PROBE_SECONDS = 1800

_EXIT_MARKER = "===CORTEX-GATE-EXIT"
_CTRF_MARKER = "===CORTEX-GATE-CTRF==="
_STDOUT_MARKER = "===CORTEX-GATE-STDOUT==="

# `-w` on its own line is how every task in the 2.1 corpus writes its uvx closure, and matching
# the line rather than the token keeps a `-w` inside some unrelated command out of the answer.
_REQUIREMENT_LINE = re.compile(r"^\s*-w\s+(\S+?)\s*\\?\s*$", re.MULTILINE)
_MISSING_MODULE = re.compile(r"No module named ['\"]([A-Za-z0-9_.]+)['\"]")
# Distributions whose import name is not their distribution name. Only the ones this corpus
# installs: a map that guessed at the rest would mis-classify on the guess.
IMPORT_NAMES: Mapping[str, str] = {
    "beautifulsoup4": "bs4",
    "biopython": "Bio",
    "gitpython": "git",
    "opencv-contrib-python": "cv2",
    "opencv-python": "cv2",
    "pillow": "PIL",
    "pytest-json-ctrf": "ctrf",
    "scikit-image": "skimage",
}


class VerifierGateError(RuntimeError):
    """The gate could not be run, as opposed to a task failing it."""


@dataclass(frozen=True)
class TaskProbe:
    """One task's answer to 'can this verifier start', and the evidence for it."""

    task_id: str
    image_ref: str
    status: str
    reason: str | None
    exit_code: int | None
    tests: int | None
    requirements: tuple[str, ...] = ()
    missing_modules: tuple[str, ...] = ()
    stdout_tail: str = ""

    def record(self) -> dict[str, object]:
        return {
            "task_id": self.task_id, "image_ref": self.image_ref, "status": self.status,
            "reason": self.reason, "exit_code": self.exit_code, "tests": self.tests,
            "requirements": list(self.requirements),
            "missing_modules": list(self.missing_modules),
            "stdout_tail": self.stdout_tail,
        }


@dataclass(frozen=True)
class ProbePlan:
    """Everything one container run needs, resolved before any container starts."""

    task_id: str
    image_ref: str
    tests_dir: Path
    script: str
    network: str
    runtime_mounts: Mapping[str, str] = field(default_factory=dict)
    timeout_seconds: int = DEFAULT_PROBE_SECONDS


def declared_requirements(script: str) -> tuple[str, ...]:
    """The distributions this task's own test script installs before it runs pytest.

    Returned as written, version pin included, because the report is evidence and the pin is part
    of what was asked for. Entries a static read cannot resolve to a distribution -- a VCS URL, or
    anything carrying a shell expansion -- are kept too; `import_names` is where they drop out.
    """
    return tuple(match.group(1) for match in _REQUIREMENT_LINE.finditer(script))


def import_names(requirements: Iterable[str]) -> frozenset[str]:
    """The module names those requirements make importable, as far as they can be known."""
    names: set[str] = set()
    for requirement in requirements:
        if requirement.startswith(("git+", "http://", "https://")) or "${" in requirement:
            continue
        distribution = re.split(r"[\[<>=!~;]", requirement, maxsplit=1)[0].strip()
        if not distribution:
            continue
        names.add(IMPORT_NAMES.get(distribution.lower(), distribution.replace("-", "_")))
    return frozenset(names)


def missing_modules(stdout_tail: str) -> tuple[str, ...]:
    """Every module the verifier reported it could not import, outermost name only."""
    found = {match.group(1).split(".")[0] for match in _MISSING_MODULE.finditer(stdout_tail)}
    return tuple(sorted(found))


def reported_tests(ctrf: object) -> int | None:
    """How many tests the CTRF report says ran, or None if there is no such number."""
    if not isinstance(ctrf, Mapping):
        return None
    results = ctrf.get("results")
    summary = results.get("summary") if isinstance(results, Mapping) else None
    tests = summary.get("tests") if isinstance(summary, Mapping) else None
    if isinstance(tests, bool) or not isinstance(tests, int):
        return None
    return tests


def classify(
    *, script: str, ctrf: object, stdout_tail: str, exit_code: int | None,
) -> tuple[str, str | None, tuple[str, ...]]:
    """The gate's verdict on one probe, from the task's own script and what the run produced."""
    absent = missing_modules(stdout_tail)
    if exit_code is None:
        return (
            STATUS_UNAVAILABLE,
            "the probe did not finish inside its timeout, so the verifier phase cannot be "
            "budgeted for this task",
            absent,
        )
    declared = import_names(declared_requirements(script))
    tests = reported_tests(ctrf)
    if tests is None:
        if "--ctrf" not in script:
            return (
                STATUS_INCONCLUSIVE,
                "this task's test script does not ask pytest for a CTRF report, so whether its "
                "verifier collected anything is not observable from outside the trial",
                absent,
            )
        return (
            STATUS_UNAVAILABLE,
            "the test script asked pytest for a CTRF report and produced none: it died before "
            "pytest ran, so no agent's work on this task could be measured",
            absent,
        )
    if tests > 0:
        return STATUS_OK, None, absent
    blamed = sorted(declared.intersection(absent))
    if blamed:
        return (
            STATUS_UNAVAILABLE,
            f"the verifier collected 0 tests and could not import {blamed}, which this task's "
            "own test script installs -- its dependency closure was not satisfied",
            absent,
        )
    return (
        STATUS_INCONCLUSIVE,
        "the verifier collected 0 tests, but nothing it failed to import is a dependency the "
        "test script installs; on an image no agent has touched that is what an unwritten "
        "solution looks like, and the gate does not judge it",
        absent,
    )


def probe_command(plan: ProbePlan) -> str:
    """The one shell command a probe container runs, prelude and verifier phase together.

    The prelude is root work the trial's own launch path does for it -- the log roots Harbor
    creates, the executable bit Harbor sets, and the PATH links a mounted runtime owes. Everything
    after it runs in the image's own environment, because that is what the verifier phase runs
    in: the agent's sealed environment stops at the phase it protects, and a probe that used it
    would be answering a different question from the one the trial asks.
    """
    scratch = " ".join(
        f"{CONTAINER_AGENT_LOGS}/trial-home/{name}"
        for name in ("home", "tmp", "xdg-cache", "xdg-config")
    )
    prelude = [
        f"mkdir -p {CONTAINER_VERIFIER_LOGS} {CONTAINER_AGENT_LOGS} {scratch} {CONTAINER_TESTS}",
        f"chmod -R 777 {CONTAINER_VERIFIER_LOGS} {CONTAINER_AGENT_LOGS}",
        f"cp -a {CONTAINER_TESTS_SOURCE}/. {CONTAINER_TESTS}/",
        f"chown -R 0:0 {CONTAINER_TESTS}",
        f"chmod +x {CONTAINER_TESTS}/test.sh",
    ]
    names = sorted(plan.runtime_mounts)
    link = runtime_link_command(names)
    if link:
        prelude.append(link)
    phase: list[str] = []
    agent_setup = runtime_agent_command(names)
    if agent_setup:
        # Parenthesised because that command opens with `set -eu`, which would otherwise stay in
        # force for everything below it: the first `cat` of a report a failing verifier never
        # wrote would kill the shell, and the probe would lose the very output that says why. It
        # cost a run to notice, so it is a subshell and every reader below is non-fatal.
        phase.append(f"( {agent_setup} )")
    phase += [
        f"({CONTAINER_TESTS}/test.sh) > {CONTAINER_VERIFIER_LOGS}/{STDOUT_NAME} 2>&1",
        "status=$?",
        f"printf '\\n{_EXIT_MARKER} %s===\\n' \"$status\"",
        f"printf '{_CTRF_MARKER}\\n'",
        f"cat {CONTAINER_VERIFIER_LOGS}/{CTRF_NAME} 2>/dev/null || true",
        f"printf '\\n{_STDOUT_MARKER}\\n'",
        f"tail -c {STDOUT_TAIL_BYTES} {CONTAINER_VERIFIER_LOGS}/{STDOUT_NAME} 2>/dev/null || true",
    ]
    # The markers travel on the container's stdout rather than a host mount on purpose: a probe
    # that wrote its evidence into a bind mount would leave root-owned trees behind on every host
    # it ran on, and this command runs 89 times.
    return "; ".join([*prelude, "\n".join(phase)])


def docker_arguments(plan: ProbePlan) -> list[str]:
    """The `docker run` a probe is, with the mounts and network the campaign declared."""
    arguments = [
        "docker", "run", "--rm", "--network", plan.network, "--user", "root",
        "--pull", "never", "-v", f"{plan.tests_dir}:{CONTAINER_TESTS_SOURCE}:ro",
    ]
    for name in sorted(plan.runtime_mounts):
        arguments += ["-v", f"{plan.runtime_mounts[name]}:{RUNTIME_TARGETS[name]}:ro"]
    return [*arguments, plan.image_ref, "bash", "-c", probe_command(plan)]


def parse_probe_output(stdout: str) -> tuple[int | None, object, str]:
    """Exit code, CTRF document and stdout tail, as the probe's own markers separate them."""
    exit_code: int | None = None
    head, _, rest = stdout.partition(_EXIT_MARKER)
    if rest:
        code, _, rest = rest.partition("===")
        try:
            exit_code = int(code.strip())
        except ValueError:
            exit_code = None
    else:
        rest = head
    _, _, after_ctrf = rest.partition(_CTRF_MARKER)
    ctrf_text, _, tail = after_ctrf.partition(_STDOUT_MARKER)
    try:
        ctrf = json.loads(ctrf_text.strip())
    except ValueError:
        ctrf = None
    return exit_code, ctrf, tail.strip()


def run_probe(plan: ProbePlan) -> TaskProbe:
    """One task, one container, one verdict."""
    try:
        completed = subprocess.run(
            docker_arguments(plan), capture_output=True, text=True,
            timeout=plan.timeout_seconds, check=False,
        )
        stdout = completed.stdout
    except subprocess.TimeoutExpired as expired:
        stdout = expired.stdout.decode(errors="replace") if expired.stdout else ""
    except OSError as error:
        raise VerifierGateError(f"cannot run docker for task {plan.task_id}: {error}") from error
    exit_code, ctrf, tail = parse_probe_output(stdout)
    status, reason, absent = classify(
        script=plan.script, ctrf=ctrf, stdout_tail=tail, exit_code=exit_code)
    return TaskProbe(
        task_id=plan.task_id, image_ref=plan.image_ref, status=status, reason=reason,
        exit_code=exit_code, tests=reported_tests(ctrf),
        requirements=declared_requirements(plan.script), missing_modules=absent,
        stdout_tail=tail,
    )


def build_plans(
    config: CampaignConfig, *, timeout_seconds: int | None = None,
) -> tuple[ProbePlan, ...]:
    """One plan per task the campaign declares, refusing a task with no readable test script."""
    network = "none" if config.network.filtered else "bridge"
    mounts = _gate_runtime_mounts(config)
    seconds = timeout_seconds or int(
        config.timeouts.get("verifier_seconds", DEFAULT_PROBE_SECONDS))
    plans: list[ProbePlan] = []
    for task in config.tasks:
        tests_dir = Path(task.path) / "tests"
        script_path = tests_dir / "test.sh"
        try:
            script = script_path.read_text(encoding="utf-8", errors="replace")
        except OSError as error:
            raise VerifierGateError(
                f"task {task.task_id} has no readable {script_path}: {error}") from error
        plans.append(ProbePlan(
            task_id=task.task_id, image_ref=task.image_ref, tests_dir=tests_dir,
            script=script, network=network, runtime_mounts=mounts, timeout_seconds=seconds,
        ))
    return tuple(plans)


def _gate_runtime_mounts(config: CampaignConfig) -> dict[str, str]:
    """The staged runtimes the verifier phase itself sees, which is the verifier tree or nothing.

    An arm's node/pi/codex mounts belong to the agent phase and are not on the verifier's path to
    a working pytest, so mounting them here would only make the probe slower and less like the
    thing it measures.
    """
    staged = dict(config.runtimes)
    declared = {
        str(name)
        for arm in config.arms
        for name in (arm.get("runtime_mounts") or ())
    }
    if "verifier" in staged and "verifier" in declared:
        return {"verifier": staged["verifier"]}
    return {}


def run_gate(
    config: CampaignConfig, *, timeout_seconds: int | None = None,
) -> dict[str, object]:
    """Probe every task the campaign declares, as concurrently as the campaign runs trials."""
    plans = build_plans(config, timeout_seconds=timeout_seconds)
    workers = max(1, config.concurrency)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        probes = tuple(pool.map(run_probe, plans))
    return build_report(config, probes)


def build_report(config: CampaignConfig, probes: Sequence[TaskProbe]) -> dict[str, object]:
    counts = {
        status: sum(1 for probe in probes if probe.status == status)
        for status in (STATUS_OK, STATUS_UNAVAILABLE, STATUS_INCONCLUSIVE)
    }
    return {
        "schema_version": GATE_SCHEMA_VERSION,
        "campaign": config.campaign,
        "config": config.source,
        "network_mode": config.network.mode,
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "counts": counts,
        "unavailable": [p.task_id for p in probes if p.status == STATUS_UNAVAILABLE],
        "inconclusive": [p.task_id for p in probes if p.status == STATUS_INCONCLUSIVE],
        "tasks": [probe.record() for probe in sorted(probes, key=lambda p: p.task_id)],
    }


def report_path(trials_dir: Path) -> Path:
    return Path(trials_dir) / GATE_REPORT_NAME


def write_report(trials_dir: Path, report: Mapping[str, object]) -> Path:
    path = report_path(trials_dir)
    atomic_write_json(path, report)
    return path


def read_report(trials_dir: Path) -> Mapping[str, object] | None:
    """The gate's last answer for this campaign, or None if it was never asked."""
    try:
        document = json.loads(report_path(trials_dir).read_bytes())
    except (OSError, ValueError):
        return None
    if not isinstance(document, Mapping):
        return None
    if document.get("schema_version") != GATE_SCHEMA_VERSION:
        return None
    return document


def unpaid_tasks(report: Mapping[str, object]) -> tuple[str, ...]:
    """The tasks this report says no arm may be paid to attempt."""
    unavailable = report.get("unavailable")
    if not isinstance(unavailable, Sequence) or isinstance(unavailable, str):
        return ()
    return tuple(sorted(str(task) for task in unavailable))
