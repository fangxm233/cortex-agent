# input:  upstream task test scripts and what a probe container printed back
# output: proof the gate separates a verifier that could not start from an agent that was wrong
# pos:    Pre-agent verifier bootstrap gate tests
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# The distinction under test is the one that cost two full suites: an upstream test.sh writes
# reward 0 both when pytest could not import numpy and when the answer was wrong, so a gate that
# read the reward would learn nothing. These prove it reads the CTRF report and the task's own
# declared dependency closure instead, and that it declines to judge rather than guess when the
# thing the verifier could not import is the solution nobody has written yet.

import importlib.util
import json
from pathlib import Path

import pytest
from test_campaign import campaign_document, write_campaign

from cortex_bench_harness.campaign_config import CampaignConfig, load_campaign_config
from cortex_bench_harness.verifier_gate import (
    CONTAINER_TESTS,
    CONTAINER_TESTS_SOURCE,
    GATE_SCHEMA_VERSION,
    STATUS_INCONCLUSIVE,
    STATUS_OK,
    STATUS_UNAVAILABLE,
    ProbePlan,
    classify,
    declared_requirements,
    docker_arguments,
    import_names,
    parse_probe_output,
    read_report,
    reported_tests,
    unpaid_tasks,
    write_report,
)

# The shape every task in the 2.1 corpus writes, trimmed to what the gate reads.
UPSTREAM_SCRIPT = """#!/bin/bash
apt-get update
apt-get install -y curl
curl -LsSf https://astral.sh/uv/0.9.5/install.sh | sh
source $HOME/.local/bin/env

uvx \\
  -p 3.13 \\
  -w pytest==8.4.1 \\
  -w pytest-json-ctrf==0.3.5 \\
  -w numpy==2.3.1 \\
  -w opencv-python==4.11.0.86 \\
  pytest --ctrf /logs/verifier/ctrf.json /tests/test_outputs.py -rA

if [ $? -eq 0 ]; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
"""


def ctrf(tests: int) -> dict[str, object]:
    return {"results": {"summary": {"tests": tests, "passed": 0, "failed": tests}}}


def test_the_gate_reads_the_closure_the_task_installs_for_itself() -> None:
    requirements = declared_requirements(UPSTREAM_SCRIPT)

    assert requirements == (
        "pytest==8.4.1", "pytest-json-ctrf==0.3.5", "numpy==2.3.1", "opencv-python==4.11.0.86")
    # The distribution is not always the module, and only a wrong map here can misattribute a
    # failure -- so the map is the corpus's, not a guess.
    assert import_names(requirements) == frozenset({"pytest", "ctrf", "numpy", "cv2"})


@pytest.mark.parametrize(
    ("requirement", "expected"),
    [
        ("git+https://github.com/example/thing.git@${COMMIT_HASH}", frozenset()),
        ("beautifulsoup4==4.13.5", frozenset({"bs4"})),
        ("pytest-json-ctrf==0.3.5", frozenset({"ctrf"})),
        ("scikit-image==0.25.0", frozenset({"skimage"})),
        ("some-new-package==1.0", frozenset({"some_new_package"})),
    ],
)
def test_a_requirement_a_static_read_cannot_resolve_is_dropped_not_guessed(
    requirement: str, expected: frozenset[str],
) -> None:
    """A VCS URL carrying a shell expansion names no distribution, and inventing one would put a
    module in the closure that no failure could ever match."""
    assert import_names([requirement]) == expected


def test_a_verifier_that_ran_tests_passes_however_badly_they_went() -> None:
    """Every test fails on an image no agent has touched. That is the point, not a problem."""
    status, reason, _ = classify(
        script=UPSTREAM_SCRIPT, ctrf=ctrf(9), stdout_tail="9 failed", exit_code=0)

    assert (status, reason) == (STATUS_OK, None)


def test_a_missing_declared_dependency_is_the_verifiers_failure_not_the_agents() -> None:
    tail = "ModuleNotFoundError: No module named 'numpy'\nInterrupted: 1 error during collection"

    status, reason, absent = classify(
        script=UPSTREAM_SCRIPT, ctrf=ctrf(0), stdout_tail=tail, exit_code=0)

    assert status == STATUS_UNAVAILABLE
    assert absent == ("numpy",)
    assert "['numpy']" in (reason or "")


def test_a_missing_module_the_task_never_installs_is_left_unjudged() -> None:
    """On an untouched image this is what an unwritten solution looks like.

    Condemning the task here would exclude it from every future suite for being unsolved, which is
    the same silent, score-shaped mistake the gate exists to prevent.
    """
    tail = "ModuleNotFoundError: No module named 'my_solution'"

    status, reason, absent = classify(
        script=UPSTREAM_SCRIPT, ctrf=ctrf(0), stdout_tail=tail, exit_code=0)

    assert status == STATUS_INCONCLUSIVE
    assert absent == ("my_solution",)
    assert "does not judge" in (reason or "")


def test_a_script_that_promised_a_report_and_produced_none_died_before_pytest() -> None:
    """The 2026-08-27 shape exactly: the uvx shim could not find an interpreter."""
    status, reason, _ = classify(
        script=UPSTREAM_SCRIPT, ctrf=None,
        stdout_tail="/root/.local/bin/uvx: 6: exec: python3: not found", exit_code=0)

    assert status == STATUS_UNAVAILABLE
    assert "died before" in (reason or "")


def test_a_script_that_never_asked_for_a_report_is_not_condemned_for_lacking_one() -> None:
    status, reason, _ = classify(
        script="#!/bin/bash\npytest /tests/test_outputs.py\n", ctrf=None,
        stdout_tail="1 failed", exit_code=1)

    assert status == STATUS_INCONCLUSIVE
    assert "not observable" in (reason or "")


def test_a_probe_that_never_finished_cannot_be_budgeted_for() -> None:
    status, reason, _ = classify(
        script=UPSTREAM_SCRIPT, ctrf=None, stdout_tail="", exit_code=None)

    assert status == STATUS_UNAVAILABLE
    assert "timeout" in (reason or "")


@pytest.mark.parametrize(
    ("document", "expected"),
    [
        ({"results": {"summary": {"tests": 3}}}, 3),
        ({"results": {"summary": {"tests": True}}}, None),
        ({"results": {"summary": {}}}, None),
        ({}, None),
        (None, None),
    ],
)
def test_only_a_real_test_count_counts(document: object, expected: int | None) -> None:
    assert reported_tests(document) == expected


def test_the_probe_output_is_read_back_from_its_own_markers() -> None:
    stdout = (
        "noise from the image\n"
        "\n===CORTEX-GATE-EXIT 0===\n"
        "===CORTEX-GATE-CTRF===\n"
        '{"results": {"summary": {"tests": 2}}}\n'
        "\n===CORTEX-GATE-STDOUT===\n"
        "2 failed\n"
    )

    exit_code, document, tail = parse_probe_output(stdout)

    assert exit_code == 0
    assert reported_tests(document) == 2
    assert tail == "2 failed"


def test_a_probe_that_printed_nothing_readable_yields_no_exit_code() -> None:
    assert parse_probe_output("docker: image not found\n") == (None, None, "")


def test_the_corpus_is_mounted_where_harbor_copies_from_never_at_tests(tmp_path: Path) -> None:
    """Harbor's /tests is a root-owned writable copy, so the probe copies too.

    Bind-mounting the corpus at /tests would either refuse the chmod Harbor performs, or hand a
    container the host's pristine task tree with write access. Neither is what a trial does.
    """
    plan = ProbePlan(
        task_id="a-task", image_ref="image@sha256:abc", tests_dir=tmp_path / "tests",
        script=UPSTREAM_SCRIPT, network="bridge",
    )

    arguments = docker_arguments(plan)
    command = arguments[-1]

    assert f"{tmp_path / 'tests'}:{CONTAINER_TESTS_SOURCE}:ro" in arguments
    assert f"{tmp_path / 'tests'}:{CONTAINER_TESTS}:ro" not in arguments
    assert f"cp -a {CONTAINER_TESTS_SOURCE}/. {CONTAINER_TESTS}/" in command
    assert "--network bridge" in " ".join(arguments)
    assert "--pull never" in " ".join(arguments)


def test_every_reader_after_the_runtime_setup_survives_a_verifier_that_wrote_nothing() -> None:
    """The staged runtime's setup command opens with `set -eu`, which used to leak.

    It killed the probe shell at the first `cat` of a report the failing verifier never wrote, so
    the run that most needed its output was the one that returned none.
    """
    plan = ProbePlan(
        task_id="a-task", image_ref="image@sha256:abc", tests_dir=Path("/tmp/tests"),
        script=UPSTREAM_SCRIPT, network="none",
        runtime_mounts={"verifier": "/staged/verifier"},
    )

    command = docker_arguments(plan)[-1]

    assert "( set -eu &&" in command
    assert command.count("|| true") == 2


def test_a_report_round_trips_and_names_what_may_not_be_paid_for(tmp_path: Path) -> None:
    report = {
        "schema_version": GATE_SCHEMA_VERSION, "campaign": "camp-01",
        "unavailable": ["task-b", "task-a"], "counts": {"ok": 1},
    }

    path = write_report(tmp_path, report)

    assert json.loads(path.read_text())["campaign"] == "camp-01"
    assert unpaid_tasks(read_report(tmp_path) or {}) == ("task-a", "task-b")


def test_a_report_from_another_schema_is_not_read(tmp_path: Path) -> None:
    write_report(tmp_path, {"schema_version": "something/9", "unavailable": ["task-a"]})

    assert read_report(tmp_path) is None


# --- what the launcher does with the report -------------------------------------------------

def load_bench() -> object:
    spec = importlib.util.spec_from_file_location(
        "bench_launch", Path(__file__).resolve().parents[2] / "scripts" / "bench-launch.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bench = load_bench()


def gated_campaign(root: Path, unavailable: list[str] | None = None) -> CampaignConfig:
    """A loadable campaign, with a gate report beside its trials root when one is asked for."""
    config = load_campaign_config(write_campaign(root, campaign_document(root, comparisons=[])))
    if unavailable is not None:
        write_report(config.trials_dir, {
            "schema_version": GATE_SCHEMA_VERSION, "campaign": config.campaign,
            "counts": {"ok": 0, "unavailable": len(unavailable), "inconclusive": 0},
            "unavailable": unavailable, "inconclusive": [],
        })
    return config


def test_a_campaign_still_declaring_an_unrunnable_task_is_refused(tmp_path: Path) -> None:
    """Refused, not silently narrowed.

    A suite that shrinks without saying so reports a denominator its own document does not
    support, which is the failure this gate exists to prevent -- so the document is edited, and
    the edit is the record of why the suite shrank.
    """
    config = gated_campaign(tmp_path, [])
    config = gated_campaign(tmp_path, [config.tasks[0].task_id])

    with pytest.raises(bench.BenchError) as error:
        bench.check_verifier_gate(config)
    assert "verifier gate found 1 task" in str(error.value)
    assert "Exclude them" in str(error.value)


def test_a_gate_report_naming_no_declared_task_lets_the_launch_proceed(tmp_path: Path) -> None:
    config = gated_campaign(tmp_path, ["a-task-this-campaign-does-not-declare"])

    assert bench.check_verifier_gate(config)["checked"] is True


def test_a_campaign_that_was_never_gated_is_told_how_rather_than_refused(tmp_path: Path) -> None:
    """The paid path predates this gate. Making it mandatory here would be a second gate."""
    step = bench.check_verifier_gate(gated_campaign(tmp_path))

    assert step["checked"] is False
    assert "--verifier-gate" in str(step["note"])


@pytest.mark.parametrize(
    ("argv", "fragment"),
    [
        (["--config", "c.yaml", "--verifier-gate", "--force-build"], "--force-build"),
        (["--config", "c.yaml", "--verifier-gate", "--foreground"], "--foreground"),
    ],
)
def test_a_flag_that_cannot_mean_anything_in_this_mode_is_named(
    argv: list[str], fragment: str,
) -> None:
    arguments = bench.build_parser().parse_args(argv)

    assert fragment in (bench._refuse_flag_combination(arguments) or "")
