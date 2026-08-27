# input:  a campaign that names a staged corpus instead of enumerating committed task copies
# output: proof that an external corpus is expanded, pinned and selectable, and that its long
#         task ids still compose hostnames
# pos:    External task-source and trial-id composition tests
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# Terminal-Bench 2.1 is 89 tasks. Enumerating them inline meant committing 89 entries, 89 task
# copies and 267 baked images, which is why the 89-task suite grew a second runner instead. The
# corpus already ships a file that pins every task; this names that file. The pin does not get
# weaker -- each task still ends up with a digest-pinned image ref -- it just stops being typed.

import json
from pathlib import Path

import pytest

from cortex_bench_harness import campaign
from cortex_bench_harness.campaign_config import (
    CampaignConfigError,
    load_campaign_config,
)
from cortex_bench_harness.external_corpus import stage_task_input
from test_campaign import arm_document, campaign_document, write_campaign

INVENTORY_SCHEMA = "cortex-bench-external-task-inventory/1"
LONG_TASK_ID = "feal-differential-cryptanalysis-with-a-very-long-corpus-name"
IMAGE_IDS = {
    "adaptive-rejection-sampler": f"sha256:{'1' * 64}",
    "bn-fit-modify": f"sha256:{'2' * 64}",
    LONG_TASK_ID: f"sha256:{'3' * 64}",
}


def stage_corpus(root: Path, task_ids=tuple(IMAGE_IDS)) -> tuple[Path, Path]:
    tasks = root / "corpus" / "tasks"
    for task_id in task_ids:
        directory = tasks / task_id
        (directory / "tests").mkdir(parents=True, exist_ok=True)
        (directory / "tests/test.sh").write_text("exit 0\n", encoding="utf-8")
        (directory / "instruction.md").write_text(f"solve {task_id}\n", encoding="utf-8")
        (directory / "task.toml").write_text(
            f'[environment]\ndocker_image = "alexgshaw/{task_id}:20251031"\n'
            "allow_internet = true\n", encoding="utf-8")
    inventory = root / "corpus" / "images.json"
    inventory.write_text(json.dumps({
        "schema_version": INVENTORY_SCHEMA,
        "source_commit": "7131e4375048a0e408a8fb404b5f499d726b695b",
        "task_tree_sha256": "b" * 64,
        "tasks": [
            {"task_id": task_id, "image_ref": f"alexgshaw/{task_id}:20251031",
             "image_id": IMAGE_IDS[task_id]}
            for task_id in task_ids
        ],
    }), encoding="utf-8")
    return tasks, inventory


def external_document(base: Path, source_overrides: dict[str, object] | None = None) -> dict:
    tasks, inventory = stage_corpus(base)
    document = campaign_document(base, comparisons=[])
    document.pop("tasks")
    document["task_source"] = {
        "kind": "external", "root": str(tasks), "inventory": str(inventory),
        **(source_overrides or {}),
    }
    return document


def load_external(base: Path, source_overrides: dict[str, object] | None = None):
    return load_campaign_config(write_campaign(base, external_document(base, source_overrides)))


def test_an_external_corpus_expands_into_digest_pinned_tasks(tmp_path: Path) -> None:
    config = load_external(tmp_path)

    assert [task.task_id for task in config.tasks] == list(IMAGE_IDS)
    sampler = config.tasks[0]
    assert sampler.image_ref == f"alexgshaw/adaptive-rejection-sampler@{IMAGE_IDS[sampler.task_id]}"
    assert sampler.image_digest == IMAGE_IDS[sampler.task_id]
    assert sampler.origin == "external"
    assert sampler.path == tmp_path / "corpus/tasks/adaptive-rejection-sampler"


def test_a_campaign_declaring_both_task_declarations_is_refused(tmp_path: Path) -> None:
    document = external_document(tmp_path)
    document["tasks"] = [
        {"task_id": "task-one", "path": str(tmp_path), "image_ref": f"r/t@sha256:{'a' * 64}"}]

    with pytest.raises(CampaignConfigError) as error:
        load_campaign_config(write_campaign(tmp_path, document))
    assert "exactly one of tasks" in str(error.value)


def test_a_campaign_declaring_neither_is_refused(tmp_path: Path) -> None:
    document = campaign_document(tmp_path, comparisons=[])
    document.pop("tasks")

    with pytest.raises(CampaignConfigError) as error:
        load_campaign_config(write_campaign(tmp_path, document))
    assert "neither" in str(error.value)


@pytest.mark.parametrize(
    ("select", "expected"),
    [
        ({"mode": "all"}, list(IMAGE_IDS)),
        ({"mode": "include", "ids": ["bn-fit-modify"]}, ["bn-fit-modify"]),
        ({"mode": "exclude", "ids": ["bn-fit-modify"]},
         ["adaptive-rejection-sampler", LONG_TASK_ID]),
    ],
)
def test_a_subset_of_the_corpus_can_be_selected(
    tmp_path: Path, select: dict[str, object], expected: list[str],
) -> None:
    config = load_external(tmp_path, {"select": select})

    assert [task.task_id for task in config.tasks] == expected


def test_selecting_a_task_the_inventory_does_not_have_is_refused(tmp_path: Path) -> None:
    """A mistyped id would otherwise run one task short and say nothing about it."""
    with pytest.raises(CampaignConfigError) as error:
        load_external(tmp_path, {"select": {"mode": "include", "ids": ["bn-fit-modifi"]}})
    assert "bn-fit-modifi" in str(error.value)


@pytest.mark.parametrize(
    ("mutation", "fragment"),
    [
        ({"kind": "registry"}, "kind"),
        ({"root": "/nonexistent/corpus"}, "root"),
        ({"select": {"mode": "some"}}, "mode"),
        ({"select": {"mode": "include"}}, "requires an ids list"),
        ({"select": {"mode": "all", "ids": ["bn-fit-modify"]}}, "rejects an ids list"),
        ({"select": {"mode": "exclude", "ids": list(IMAGE_IDS)}}, "leaves no task"),
    ],
)
def test_a_malformed_task_source_is_refused(
    tmp_path: Path, mutation: dict[str, object], fragment: str,
) -> None:
    with pytest.raises(CampaignConfigError) as error:
        load_external(tmp_path, mutation)
    assert fragment in str(error.value)


def test_an_unpinned_inventory_entry_is_refused(tmp_path: Path) -> None:
    document = external_document(tmp_path)
    inventory = Path(str(document["task_source"]["inventory"]))
    payload = json.loads(inventory.read_text())
    payload["tasks"][0]["image_id"] = "20251031"
    inventory.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(CampaignConfigError) as error:
        load_campaign_config(write_campaign(tmp_path, document))
    assert "image_id must be sha256" in str(error.value)


def test_a_task_directory_the_corpus_is_missing_is_refused(tmp_path: Path) -> None:
    document = external_document(tmp_path)
    (Path(str(document["task_source"]["root"])) / "bn-fit-modify/task.toml").unlink()

    with pytest.raises(CampaignConfigError) as error:
        load_campaign_config(write_campaign(tmp_path, document))
    assert "no task.toml for bn-fit-modify" in str(error.value)


def test_an_over_long_trial_id_is_shortened_rather_than_refused(tmp_path: Path) -> None:
    """63 characters is a container hostname limit, and a corpus does not negotiate its ids."""
    document = external_document(tmp_path)
    document["arms"] = [arm_document("cortex-direct-pi-openai-codex")]
    config = load_campaign_config(write_campaign(tmp_path, document))

    plans = {plan.task.task_id: plan for plan in config.trials()}
    short = plans["bn-fit-modify"]
    long = plans[LONG_TASK_ID]

    assert short.trial_id == "camp-01-bn-fit-modify-cortex-direct-pi-openai-codex"
    assert short.trial_id_was_shortened is False
    assert len(long.trial_id) <= 63
    assert long.trial_id.startswith("camp-01-feal-differential")
    assert long.trial_id.endswith("-cortex-direct-pi-openai-codex-5f2baf")
    assert long.trial_id_was_shortened is True
    assert long.declared_trial_id == f"camp-01-{LONG_TASK_ID}-cortex-direct-pi-openai-codex"


def test_a_shortened_trial_id_is_stable_and_distinct(tmp_path: Path) -> None:
    """Re-reading the same document must address the same roots, or resume arms a second run."""
    first = load_external(tmp_path)
    second = load_external(tmp_path)
    ids = [plan.trial_id for plan in first.trials()]

    assert ids == [plan.trial_id for plan in second.trials()]
    assert len(set(ids)) == len(ids)


def test_a_corpus_task_is_staged_into_the_shape_a_committed_task_has(tmp_path: Path) -> None:
    """Harbor reads three things; the corpus ships six, one of which is the answer."""
    source = tmp_path / "corpus/tasks/adaptive-rejection-sampler"
    (source / "tests").mkdir(parents=True)
    (source / "tests/test.sh").write_text("exit 0\n", encoding="utf-8")
    (source / "instruction.md").write_text("do the thing\n", encoding="utf-8")
    (source / "solution").mkdir()
    (source / "solution/solve.sh").write_text("echo the answer\n", encoding="utf-8")
    (source / "environment").mkdir()
    (source / "environment/Dockerfile").write_text("FROM ubuntu\n", encoding="utf-8")
    (source / "task.toml").write_text(
        'schema_version = "1.1"\n\n[environment]\n'
        'docker_image = "alexgshaw/adaptive-rejection-sampler:20251031"\n'
        "cpus = 1\nallow_internet = true\nmcp_servers = []\n", encoding="utf-8")

    staged = stage_task_input(source, tmp_path / "staged", f"repo@{'a' * 64}")

    assert sorted(path.name for path in staged.iterdir()) == [
        "instruction.md", "task.toml", "tests"]
    document = (staged / "task.toml").read_text(encoding="utf-8")
    assert f'docker_image = "repo@{"a" * 64}"' in document
    assert 'network_mode = "public"\nos = "linux"' in document
    assert "allow_internet" not in document
    # Every other byte of the corpus file survives the rewrite.
    assert 'schema_version = "1.1"' in document and "cpus = 1" in document


def test_a_task_that_declared_no_internet_keeps_declaring_none(tmp_path: Path) -> None:
    source = tmp_path / "task"
    (source / "tests").mkdir(parents=True)
    (source / "instruction.md").write_text("go\n", encoding="utf-8")
    (source / "task.toml").write_text(
        '[environment]\ndocker_image = "r:t"\nallow_internet = false\n', encoding="utf-8")

    staged = stage_task_input(source, tmp_path / "staged", f"repo@{'a' * 64}")

    assert 'network_mode = "no-network"' in (staged / "task.toml").read_text(encoding="utf-8")


def test_a_corpus_task_is_staged_beside_the_trials_root_not_inside_it(tmp_path: Path) -> None:
    """Admission refuses a task input under the trials root, since that is how one trial reads
    another's output."""
    config = load_external(tmp_path)

    staged = campaign._stage_task_inputs(config)

    for task in config.tasks:
        path = staged[task.task_id]
        assert path.parent == config.trials_dir.parent / "camp-01-task-inputs"
        assert not path.is_relative_to(config.trials_dir)
        assert (path / "task.toml").read_text(encoding="utf-8").count(task.image_digest) == 1


def test_a_committed_task_is_used_where_it_lies(tmp_path: Path) -> None:
    config = load_campaign_config(write_campaign(tmp_path, campaign_document(tmp_path)))

    assert campaign._stage_task_inputs(config) == {
        task.task_id: task.path for task in config.tasks}
