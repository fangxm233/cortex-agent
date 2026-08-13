# input:  campaign configs, a recording production trial path and published envelopes
# output: routing, refusal, cost-pairing, serial-order, hard-stop, resume and report proofs
# pos:    Campaign runner behaviour tests
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# The driver is proven black-box: a campaign document goes in, trial roots and one comparison
# report come out. The production trial path is replaced by a recorder that reserves a fresh root
# exactly as the real one does, so "the driver never clobbers an existing root" is proven by the
# same failure the production path would raise rather than by a mock's politeness.

import asyncio
import hashlib
import json
import tomllib
from decimal import Decimal
from pathlib import Path

import pytest
import yaml

from cortex_bench_harness import campaign
from cortex_bench_harness.campaign_config import (
    CAMPAIGN_SCHEMA_VERSION,
    CampaignConfigError,
    load_campaign_config,
)
from cortex_bench_harness.host_finalization import (
    OUTER_ENVELOPE_FILENAME,
    OUTER_ENVELOPE_SCHEMA_VERSION,
    parse_host_scan_policy,
)
from cortex_bench_harness.launcher.capability_ceilings import load_capability_ceilings
from cortex_bench_harness.launcher.comparison_report import (
    COMPARISON_REPORT_SCHEMA_VERSION,
)
from cortex_bench_harness.launcher.trial_admission import build_harbor_trial_config
from cortex_bench_harness.launcher.trial_proxy import (
    parse_trial_proxy_spec,
    validate_paid_envelope,
)
from cortex_bench_harness.proxy.models import ProxyBudget

DIGEST = f"sha256:{'a' * 64}"
IMAGE_REF = f"registry.invalid/task@{DIGEST}"
HARNESS_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = HARNESS_ROOT.parents[1]
CAMPAIGNS_DIR = REPO_ROOT / "benchmark" / "campaigns"
COMMITTED_ZERO_PAID_CONFIG = CAMPAIGNS_DIR / "zero-paid-dry-run.yaml"
COMMITTED_PAID_CONFIG = CAMPAIGNS_DIR / "terminal-bench-2.1-deepseek-paid.yaml"


def arm_document(name: str, **overrides: object) -> dict[str, object]:
    return {
        "name": name, "kind": "cortex", "backend": "pi", "provider": "deepseek",
        "model": "deepseek-v4-flash", "credential_capability": "pi-deepseek-api-key",
        "orchestration": {"mode": "direct", "ask_manager": False},
        "limits": {
            "max_thread_starts": 0, "max_parent_questions": 0, "max_task_depth": 0,
            "max_tasks": 0, "max_provider_requests": 200, "max_resident_agent_processes": 1,
            "max_cost_usd": "2.00", "deadline_seconds": 1800, "max_output_tokens": 32768,
        },
        **overrides,
    }


def campaign_document(root: Path, **overrides: object) -> dict[str, object]:
    return {
        "schema_version": CAMPAIGN_SCHEMA_VERSION,
        "campaign": "camp-01",
        "paid": False,
        "cost_ceiling_usd": "10.00",
        "trials_dir": str(root / "trials"),
        "cli_version": "2026.8.12",
        "manifest": {
            "wheel_path": str(root / "harness.whl"),
            "lockfile_path": str(root / "uv.lock"),
            "lockfile_manifest_path": "benchmark/harness/uv.lock",
            "npm_artifact_path": str(root / "server.tgz"),
        },
        "credential": {
            "upstream_base_url": "http://127.0.0.1:9880/m/deepseek/deepseek",
            "route_identity_host": "api.deepseek.com",
            "proxy_host_suffix": "proxy.invalid",
            "dummy_token_ref": "offline-token-handle",
        },
        "host_scan_policy": {
            "secret_environment": {"provider_credential": "CORTEX_BENCH_TEST_CREDENTIAL"},
            "forbidden_environment": {"forbidden": "CORTEX_BENCH_TEST_FORBIDDEN"},
            "forbidden_argv_environment": {"forbidden": "CORTEX_BENCH_TEST_ARGV"},
            "repository_checkout_environment": "CORTEX_BENCH_TEST_CHECKOUT",
            "host_identity_environment": {"machine": "CORTEX_BENCH_TEST_IDENTITY"},
        },
        "docker_network": {
            "subnet": "172.30.240.0/24", "gateway": "172.30.240.1",
        },
        "proxy": {
            "credential_env": "CORTEX_BENCH_TEST_CREDENTIAL",
            "bound_source_ip": "172.19.0.2",
            # Funds the arm's 200 declared requests out of its $2.00 trial ceiling
            # (floor(2.00 / 0.01) = 200) and covers one 32768-token response ($0.00917504).
            "max_request_cost_usd": "0.01",
            "input_cost_per_million_usd": "0.14",
            "output_cost_per_million_usd": "0.28",
            "request_body_limit_bytes": 16777216,
            "response_body_limit_bytes": 16777216,
            "listen_host": "0.0.0.0",
        },
        "arms": [arm_document("cortex-a"), arm_document("cortex-b")],
        "tasks": [
            {"task_id": "task-one", "path": str(root / "tasks" / "one"),
             "image_ref": IMAGE_REF},
            {"task_id": "task-two", "path": str(root / "tasks" / "two"),
             "image_ref": IMAGE_REF},
        ],
        "comparisons": [
            {"left_arm": "cortex-a", "right_arm": "cortex-b",
             "difference_class": "orchestration"},
        ],
        **overrides,
    }


def write_campaign(root: Path, document: dict[str, object] | None = None) -> Path:
    path = root / "campaign.yaml"
    path.write_text(yaml.safe_dump(document or campaign_document(root)), encoding="utf-8")
    return path


def envelope_document(
    trial_id: str, arm_name: str, cost_usd: str,
) -> dict[str, object]:
    return {
        "schema_version": OUTER_ENVELOPE_SCHEMA_VERSION,
        "identity": {"trial_id": trial_id, "root_run_id": f"{trial_id}.{arm_name}",
                     "arm_name": arm_name},
        "proxy_usage": {"cost_usd": cost_usd, "requests": 2, "input_tokens": 11,
                        "output_tokens": 7, "reconciled": True},
        "grader_admission": {"admitted": True},
    }


def write_envelope(
    trials_dir: Path, trial_id: str, document: dict[str, object],
) -> Path:
    artifacts = trials_dir / trial_id / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    path = artifacts / OUTER_ENVELOPE_FILENAME
    path.write_text(json.dumps(document, sort_keys=True) + "\n", encoding="utf-8")
    return path


def write_result(
    trials_dir: Path, trial_id: str, result: "RecordingResult | None" = None,
) -> None:
    result = result or RecordingResult(rewards={"reward": 1.0})
    exception = None if result.exception_info is None else {
        "exception_type": type(result.exception_info).__name__,
        "exception_message": str(result.exception_info),
    }
    verifier = None if result.verifier_result is None else {
        "rewards": result.verifier_result.rewards,
    }
    (trials_dir / trial_id / "result.json").write_text(json.dumps({
        "exception_info": exception, "verifier_result": verifier,
    }), encoding="utf-8")


def publish_envelope(
    trials_dir: Path, trial_id: str, arm_name: str, cost_usd: str,
) -> Path:
    path = write_envelope(
        trials_dir, trial_id, envelope_document(trial_id, arm_name, cost_usd))
    write_result(trials_dir, trial_id)
    return path


class RecordingResult:
    def __init__(self, *, exception_info: object = None, rewards: dict[str, float] | None = None) -> None:
        self.exception_info = exception_info
        self.verifier_result = None if rewards is None else type(
            "VerifierResult", (), {"rewards": rewards})()


class RecordingTrial:
    def __init__(self, path: "RecordingTrialPath", kwargs: dict[str, object]) -> None:
        self.path = path
        self.kwargs = kwargs
        self.trial_id = str(kwargs["trial_seed"]["trial_id"])

    async def run(self) -> object:
        if self.trial_id in self.path.failures:
            raise RuntimeError(f"container refused trial {self.trial_id}")
        arm_name = str(self.kwargs["arm"]["name"])
        document = envelope_document(
            self.trial_id, arm_name,
            self.path.costs.get(self.trial_id, self.path.default_cost),
        )
        trials_dir = Path(str(self.kwargs["trials_dir"]))
        write_envelope(
            trials_dir, self.trial_id, self.path.envelope_mutation(document),
        )
        result = self.path.results.get(
            self.trial_id, RecordingResult(rewards={"reward": 1.0}))
        write_result(trials_dir, self.trial_id, result)
        self.path.events.append(("finished", self.trial_id))
        return result


class RecordingTrialPath:
    """Stands in for `create_harbor_trial`, including its fresh-root reservation."""

    def __init__(
        self, *, default_cost: str = "0.60", costs: dict[str, str] | None = None,
        failures: tuple[str, ...] = (),
        envelope_mutation: object = None,
        results: dict[str, RecordingResult] | None = None,
    ) -> None:
        self.default_cost = default_cost
        self.costs = costs or {}
        self.failures = set(failures)
        self.envelope_mutation = envelope_mutation or (lambda document: document)
        self.results = results or {}
        self.calls: list[dict[str, object]] = []
        self.events: list[tuple[str, str]] = []

    def install(self, monkeypatch: pytest.MonkeyPatch) -> "RecordingTrialPath":
        monkeypatch.setattr(campaign, "create_harbor_trial", self._create)
        monkeypatch.setattr(campaign, "_create_trial_network", lambda *_: "network-fixture")
        monkeypatch.setattr(campaign, "_remove_trial_network", lambda *_: None)
        return self

    @property
    def armed(self) -> list[str]:
        return [trial_id for state, trial_id in self.events if state == "armed"]

    async def _create(self, **kwargs: object) -> RecordingTrial:
        trial_id = str(kwargs["trial_seed"]["trial_id"])
        (Path(str(kwargs["trials_dir"])) / trial_id).mkdir(parents=True)
        self.calls.append(kwargs)
        self.events.append(("armed", trial_id))
        return RecordingTrial(self, kwargs)


def run_cli(
    capsys: pytest.CaptureFixture[str], *arguments: str,
) -> tuple[int, dict[str, object], str]:
    status = campaign.main(list(arguments))
    captured = capsys.readouterr()
    document = json.loads(captured.out) if captured.out.strip() else {}
    return status, document, captured.err


def failure_document(capsys: pytest.CaptureFixture[str]) -> dict[str, object]:
    captured = capsys.readouterr()
    return json.loads(captured.err)


# --- routing and help ---------------------------------------------------------------------------


def test_help_documents_the_run_subcommand_and_copyable_examples(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(SystemExit) as exit_info:
        campaign.main(["--help"])

    assert exit_info.value.code == 0
    help_text = capsys.readouterr().out
    assert "run" in help_text
    assert "cortex-bench run --config" in help_text


def test_run_help_lists_the_config_flag_and_an_example(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(SystemExit) as exit_info:
        campaign.main(["run", "--help"])

    assert exit_info.value.code == 0
    help_text = capsys.readouterr().out
    assert "--config" in help_text
    assert "--dry-run" in help_text
    assert "cortex-bench run --config" in help_text


def test_no_subcommand_is_a_structured_refusal_naming_the_commands(
    capsys: pytest.CaptureFixture[str],
) -> None:
    status = campaign.main([])

    assert status == 1
    error = failure_document(capsys)
    assert error["ok"] is False
    assert "run" in error["error"]


def test_an_unknown_subcommand_is_a_structured_refusal(
    capsys: pytest.CaptureFixture[str],
) -> None:
    status = campaign.main(["ruk", "--config", "x.yaml"])

    assert status == 1
    error = failure_document(capsys)
    assert error["ok"] is False
    assert "ruk" in error["error"] and "run" in error["error"]


def test_run_without_a_config_is_a_structured_refusal(
    capsys: pytest.CaptureFixture[str],
) -> None:
    status = campaign.main(["run"])

    assert status == 1
    assert "--config" in failure_document(capsys)["error"]


def test_an_unreadable_config_is_a_structured_refusal(
    tmp_path: Path, capsys: pytest.CaptureFixture[str],
) -> None:
    status = campaign.main(["run", "--config", str(tmp_path / "absent.yaml")])

    assert status == 1
    assert "absent.yaml" in failure_document(capsys)["error"]


def test_the_package_declares_the_public_console_script() -> None:
    project = tomllib.loads(
        (HARNESS_ROOT / "pyproject.toml").read_text(encoding="utf-8"))

    assert project["project"]["scripts"] == {
        "cortex-bench": "cortex_bench_harness.campaign:main",
    }


# --- strict configuration validation ------------------------------------------------------------


def test_a_valid_config_parses_into_the_declared_campaign(tmp_path: Path) -> None:
    config = load_campaign_config(write_campaign(tmp_path))

    assert config.campaign == "camp-01"
    assert config.paid is False
    assert config.cost_ceiling_usd == Decimal("10.00")
    assert config.trials_dir == tmp_path / "trials"
    assert [arm["name"] for arm in config.arms] == ["cortex-a", "cortex-b"]
    assert [task.task_id for task in config.tasks] == ["task-one", "task-two"]


def test_the_parsed_arm_carries_the_pinned_arm_schema_version(tmp_path: Path) -> None:
    config = load_campaign_config(write_campaign(tmp_path))

    assert config.arms[0]["schema_version"] == "cortex-benchmark-arm/2"
    assert config.arms[0]["limits"]["max_output_tokens"] == 32768


def test_the_parsed_proxy_and_scan_policy_satisfy_their_existing_parsers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in ("CREDENTIAL", "FORBIDDEN", "ARGV", "CHECKOUT", "IDENTITY"):
        monkeypatch.setenv(f"CORTEX_BENCH_TEST_{name}", f"value-{name.lower()}")
    config = load_campaign_config(write_campaign(tmp_path))

    spec = parse_trial_proxy_spec(config.proxy)
    policy = parse_host_scan_policy(config.host_scan_policy)

    assert spec.request_body_limit_bytes == 16777216
    assert policy.secrets == {"provider_credential": "value-credential"}


def test_the_task_image_digest_is_derived_from_the_pinned_reference(tmp_path: Path) -> None:
    config = load_campaign_config(write_campaign(tmp_path))

    assert config.tasks[0].image_digest == DIGEST
    assert config.tasks[0].path == tmp_path / "tasks" / "one"


@pytest.mark.parametrize(
    ("mutation", "fragment"),
    [
        ({"trials_root": "/tmp/x"}, "trials_root"),
        ({"schema_version": "cortex-bench-campaign/9"}, "schema_version"),
        ({"campaign": ""}, "campaign"),
        ({"campaign": "Camp 01"}, "campaign"),
        ({"paid": "false"}, "paid"),
        ({"cost_ceiling_usd": 10.0}, "cost_ceiling_usd"),
        ({"cost_ceiling_usd": "0"}, "cost_ceiling_usd"),
        ({"cost_ceiling_usd": "not-a-number"}, "cost_ceiling_usd"),
        ({"cli_version": ""}, "cli_version"),
        ({"arms": []}, "arms"),
        ({"tasks": []}, "tasks"),
    ],
)
def test_a_malformed_campaign_document_is_refused(
    tmp_path: Path, mutation: dict[str, object], fragment: str,
) -> None:
    path = write_campaign(tmp_path, campaign_document(tmp_path, **mutation))

    with pytest.raises(CampaignConfigError) as error:
        load_campaign_config(path)

    assert fragment in str(error.value)


def test_a_missing_top_level_field_is_refused(tmp_path: Path) -> None:
    document = campaign_document(tmp_path)
    del document["proxy"]

    with pytest.raises(CampaignConfigError) as error:
        load_campaign_config(write_campaign(tmp_path, document))

    assert "proxy" in str(error.value)


def test_duplicate_arm_names_are_refused(tmp_path: Path) -> None:
    document = campaign_document(
        tmp_path, arms=[arm_document("cortex-a"), arm_document("cortex-a")])

    with pytest.raises(CampaignConfigError) as error:
        load_campaign_config(write_campaign(tmp_path, document))

    assert "cortex-a" in str(error.value)


def test_duplicate_task_ids_are_refused(tmp_path: Path) -> None:
    document = campaign_document(tmp_path)
    document["tasks"][1]["task_id"] = "task-one"

    with pytest.raises(CampaignConfigError) as error:
        load_campaign_config(write_campaign(tmp_path, document))

    assert "task-one" in str(error.value)


def test_a_vendor_baseline_arm_is_refused_by_this_schema(tmp_path: Path) -> None:
    document = campaign_document(
        tmp_path, arms=[arm_document("vendor", kind="vendor-baseline")])

    with pytest.raises(CampaignConfigError) as error:
        load_campaign_config(write_campaign(tmp_path, document))

    assert "cortex" in str(error.value)


def test_an_arm_missing_a_declared_limit_is_refused(tmp_path: Path) -> None:
    document = campaign_document(tmp_path)
    del document["arms"][0]["limits"]["max_output_tokens"]

    with pytest.raises(CampaignConfigError) as error:
        load_campaign_config(write_campaign(tmp_path, document))

    assert "max_output_tokens" in str(error.value)


def test_an_unpinned_task_image_is_refused(tmp_path: Path) -> None:
    document = campaign_document(tmp_path)
    document["tasks"][0]["image_ref"] = "registry.invalid/task:latest"

    with pytest.raises(CampaignConfigError) as error:
        load_campaign_config(write_campaign(tmp_path, document))

    assert "image_ref" in str(error.value)


def test_a_comparison_naming_an_undeclared_arm_is_refused(tmp_path: Path) -> None:
    document = campaign_document(
        tmp_path,
        comparisons=[{"left_arm": "cortex-a", "right_arm": "cortex-z",
                      "difference_class": "orchestration"}],
    )

    with pytest.raises(CampaignConfigError) as error:
        load_campaign_config(write_campaign(tmp_path, document))

    assert "cortex-z" in str(error.value)


def test_relative_paths_resolve_against_the_config_directory(tmp_path: Path) -> None:
    document = campaign_document(tmp_path)
    document["trials_dir"] = "trials"
    document["tasks"][0]["path"] = "tasks/one"

    config = load_campaign_config(write_campaign(tmp_path, document))

    assert config.trials_dir == tmp_path / "trials"
    assert config.tasks[0].path == tmp_path / "tasks" / "one"


def test_a_config_read_from_stdin_resolves_relative_paths_against_the_cwd(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    document = campaign_document(tmp_path)
    document["trials_dir"] = "trials"
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(
        campaign.sys, "stdin", _StringStdin(yaml.safe_dump(document)), raising=False)
    recorder = RecordingTrialPath().install(monkeypatch)

    status, result, _ = run_cli(capsys, "run", "--config", "-")

    assert status == 0
    assert result["trials_dir"] == str(tmp_path / "trials")
    assert len(recorder.armed) == 4


class _StringStdin:
    def __init__(self, text: str) -> None:
        self._text = text

    def read(self) -> str:
        return self._text


# --- serial execution through the production trial path -----------------------------------------


def test_trials_run_one_at_a_time_in_declared_task_then_arm_order(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    recorder = RecordingTrialPath().install(monkeypatch)
    config_path = write_campaign(tmp_path)

    status, result, _ = run_cli(capsys, "run", "--config", str(config_path))

    assert status == 0
    assert recorder.events == [
        ("armed", "camp-01-task-one-cortex-a"), ("finished", "camp-01-task-one-cortex-a"),
        ("armed", "camp-01-task-one-cortex-b"), ("finished", "camp-01-task-one-cortex-b"),
        ("armed", "camp-01-task-two-cortex-a"), ("finished", "camp-01-task-two-cortex-a"),
        ("armed", "camp-01-task-two-cortex-b"), ("finished", "camp-01-task-two-cortex-b"),
    ]
    assert [trial["trial_id"] for trial in result["trials"]] == recorder.armed


def test_each_serial_trial_gets_a_fresh_declared_external_network(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    recorder = RecordingTrialPath().install(monkeypatch)
    calls: list[list[str]] = []

    def create(config: object, plan: object) -> str:
        calls.append(["create", plan.trial_id, config.docker_network["subnet"],
                      config.docker_network["gateway"]])
        return f"network-{plan.trial_id}"

    def remove(network_id: str) -> None:
        calls.append(["remove", network_id])

    monkeypatch.setattr(campaign, "_create_trial_network", create)
    monkeypatch.setattr(campaign, "_remove_trial_network", remove)
    document = campaign_document(tmp_path)
    document["arms"] = [document["arms"][0]]
    document["comparisons"] = []

    status, _, stderr = run_cli(
        capsys, "run", "--config", str(write_campaign(tmp_path, document)))

    assert (status, stderr) == (0, "")
    assert calls == [
        ["create", "camp-01-task-one-cortex-a", "172.30.240.0/24", "172.30.240.1"],
        ["remove", "network-camp-01-task-one-cortex-a"],
        ["create", "camp-01-task-two-cortex-a", "172.30.240.0/24", "172.30.240.1"],
        ["remove", "network-camp-01-task-two-cortex-a"],
    ]
    assert len(recorder.armed) == 2


def test_trial_and_network_cleanup_failures_are_both_reported(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    trial_id = "camp-01-task-one-cortex-a"
    RecordingTrialPath(failures=(trial_id,)).install(monkeypatch)
    cleanup_error = campaign.CampaignError("network cleanup failed")
    monkeypatch.setattr(
        campaign, "_remove_trial_network",
        lambda _network_id: (_ for _ in ()).throw(cleanup_error),
    )
    config = load_campaign_config(write_campaign(tmp_path))

    with pytest.raises(campaign.CampaignError) as caught:
        asyncio.run(campaign._arm_trial(config, config.trials()[0]))

    assert f"container refused trial {trial_id}" in str(caught.value)
    assert "network cleanup failed" in str(caught.value)
    assert isinstance(caught.value.trial_error, campaign.CampaignError)
    assert "container refused trial" in str(caught.value.trial_error)
    assert isinstance(caught.value.trial_error.__cause__, RuntimeError)
    assert f"container refused trial {trial_id}" in str(caught.value.trial_error.__cause__)
    assert caught.value.cleanup_error is cleanup_error
    assert caught.value.__cause__ is caught.value.trial_error


def test_each_trial_is_armed_through_the_production_path_with_the_declared_documents(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    recorder = RecordingTrialPath().install(monkeypatch)
    document = campaign_document(tmp_path)
    document["tasks"] = [document["tasks"][0]]
    document["arms"] = [document["arms"][0]]
    document["comparisons"] = []

    status, _, stderr = run_cli(capsys, "run", "--config", str(write_campaign(tmp_path, document)))

    assert (status, stderr) == (0, "")
    kwargs = recorder.calls[0]
    seed = kwargs["trial_seed"]
    assert kwargs["arm"] == seed["arm"]
    assert kwargs["arm"]["name"] == "cortex-a"
    assert kwargs["cli_version"] == "2026.8.12"
    assert kwargs["task_path"] == tmp_path / "tasks" / "one"
    assert kwargs["trials_dir"] == tmp_path / "trials"
    assert kwargs["trial_proxy"] == document["proxy"]
    assert kwargs["host_scan_policy"] == document["host_scan_policy"]
    assert seed["paid_run"] is False
    assert seed["pi_benchmark_capability_proven"] is True
    assert seed["trial_id"] == "camp-01-task-one-cortex-a"
    assert seed["root_run_id"] == "camp-01-task-one-cortex-a.cortex-a"
    assert seed["task"] == {"task_id": "task-one", "image_ref": IMAGE_REF,
                            "image_digest": DIGEST}
    assert seed["credential"] == {
        "upstream_base_url": "http://127.0.0.1:9880/m/deepseek/deepseek",
        "route_identity_host": "api.deepseek.com",
        "proxy_base_url": "http://camp-01-task-one-cortex-a.proxy.invalid",
        "dummy_token_ref": "offline-token-handle",
    }
    assert kwargs["manifest"]["wheel_path"] == str(tmp_path / "harness.whl")
    assert kwargs["manifest"]["image_digest"] == DIGEST
    assert kwargs["manifest"]["trial_id"] == "camp-01-task-one-cortex-a"


def test_every_trial_is_armed_on_its_own_trial_scoped_route(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    """Admission refuses a proxy hostname whose first label is not that trial's own id."""
    recorder = RecordingTrialPath().install(monkeypatch)

    run_cli(capsys, "run", "--config", str(write_campaign(tmp_path)))

    routes = [str(call["trial_seed"]["credential"]["proxy_base_url"]) for call in recorder.calls]
    assert routes == [
        "http://camp-01-task-one-cortex-a.proxy.invalid",
        "http://camp-01-task-one-cortex-b.proxy.invalid",
        "http://camp-01-task-two-cortex-a.proxy.invalid",
        "http://camp-01-task-two-cortex-b.proxy.invalid",
    ]
    assert len(set(routes)) == len(routes)


def test_a_paid_campaign_marks_every_trial_seed_paid(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    recorder = RecordingTrialPath().install(monkeypatch)
    document = campaign_document(tmp_path, paid=True)

    run_cli(capsys, "run", "--config", str(write_campaign(tmp_path, document)))

    assert all(call["trial_seed"]["paid_run"] is True for call in recorder.calls)


# --- the campaign cost ceiling ------------------------------------------------------------------


def test_the_campaign_stops_arming_once_the_ceiling_is_exceeded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    recorder = RecordingTrialPath(default_cost="0.60").install(monkeypatch)
    document = campaign_document(tmp_path, cost_ceiling_usd="1.00")

    status, result, _ = run_cli(
        capsys, "run", "--config", str(write_campaign(tmp_path, document)))

    assert status == 0
    assert recorder.armed == ["camp-01-task-one-cortex-a", "camp-01-task-one-cortex-b"]
    assert result["state"] == "cost-ceiling-reached"
    assert result["cost_usd"] == "1.20"
    assert [trial["state"] for trial in result["trials"]] == ["ran", "ran", "not-armed",
                                                              "not-armed"]


def test_the_ceiling_is_exact_at_the_declared_boundary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    recorder = RecordingTrialPath(default_cost="0.50").install(monkeypatch)
    document = campaign_document(tmp_path, cost_ceiling_usd="1.00")

    status, result, _ = run_cli(
        capsys, "run", "--config", str(write_campaign(tmp_path, document)))

    assert status == 0
    assert len(recorder.armed) == 2
    assert result["cost_usd"] == "1.00"
    assert result["state"] == "cost-ceiling-reached"


def test_a_campaign_below_its_ceiling_arms_every_declared_trial(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    recorder = RecordingTrialPath(default_cost="0.10").install(monkeypatch)

    status, result, _ = run_cli(capsys, "run", "--config", str(write_campaign(tmp_path)))

    assert status == 0
    assert len(recorder.armed) == 4
    assert result["state"] == "completed"
    assert result["cost_usd"] == "0.40"


@pytest.mark.parametrize(
    ("result", "fragment"),
    [
        (RecordingResult(exception_info=RuntimeError("verifier failed")), "failed"),
        (RecordingResult(rewards=None), "verifier result"),
        (RecordingResult(rewards={}), "verifier rewards"),
        (RecordingResult(rewards={"reward": float("nan")}), "non-finite"),
    ],
)
def test_a_trial_result_without_completed_verification_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
    result: RecordingResult, fragment: str,
) -> None:
    trial_id = "camp-01-task-one-cortex-a"
    RecordingTrialPath(results={trial_id: result}).install(monkeypatch)

    status = campaign.main(["run", "--config", str(write_campaign(tmp_path))])

    assert status == 1
    assert fragment in failure_document(capsys)["error"]


@pytest.mark.parametrize("reward", [0.0, -1.0])
def test_a_completed_trial_accepts_any_finite_reward(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
    reward: float,
) -> None:
    trial_id = "camp-01-task-one-cortex-a"
    RecordingTrialPath(results={
        trial_id: RecordingResult(rewards={"reward": reward}),
    }).install(monkeypatch)

    status, result, stderr = run_cli(
        capsys, "run", "--config", str(write_campaign(tmp_path)))

    assert (status, stderr) == (0, "")
    assert result["state"] == "completed"


def drop_cost(document: dict[str, object]) -> dict[str, object]:
    del document["proxy_usage"]["cost_usd"]
    return document


def test_a_published_envelope_without_a_cost_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    RecordingTrialPath(envelope_mutation=drop_cost).install(monkeypatch)

    status = campaign.main(["run", "--config", str(write_campaign(tmp_path))])

    error = failure_document(capsys)
    assert status == 1
    assert "cost_usd" in error["error"]


# --- resume, idempotency and non-clobbering -----------------------------------------------------


def test_an_existing_completed_trial_root_is_skipped_and_its_cost_still_counts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    recorder = RecordingTrialPath(default_cost="0.10").install(monkeypatch)
    trials_dir = tmp_path / "trials"
    publish_envelope(trials_dir, "camp-01-task-one-cortex-a", "cortex-a", "0.70")
    marker = trials_dir / "camp-01-task-one-cortex-a" / "artifacts" / "keep-me.txt"
    marker.write_text("prior evidence", encoding="utf-8")

    status, result, _ = run_cli(capsys, "run", "--config", str(write_campaign(tmp_path)))

    assert status == 0
    assert "camp-01-task-one-cortex-a" not in recorder.armed
    assert marker.read_text(encoding="utf-8") == "prior evidence"
    assert result["trials"][0]["state"] == "skipped"
    assert result["cost_usd"] == "1.00"


def test_re_running_a_finished_campaign_arms_nothing_and_is_idempotent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    config_path = write_campaign(tmp_path)
    first = RecordingTrialPath(default_cost="0.10").install(monkeypatch)
    first_status, first_result, _ = run_cli(capsys, "run", "--config", str(config_path))
    report = Path(str(first_result["report_path"])).read_bytes()

    second = RecordingTrialPath(default_cost="0.99").install(monkeypatch)
    second_status, second_result, _ = run_cli(capsys, "run", "--config", str(config_path))

    assert (first_status, second_status) == (0, 0)
    assert len(first.armed) == 4 and second.armed == []
    assert [trial["state"] for trial in second_result["trials"]] == ["skipped"] * 4
    assert second_result["cost_usd"] == first_result["cost_usd"]
    assert Path(str(second_result["report_path"])).read_bytes() == report


def test_an_envelope_from_another_trial_is_not_counted_as_this_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    RecordingTrialPath().install(monkeypatch)
    trials_dir = tmp_path / "trials"
    write_envelope(
        trials_dir, "camp-01-task-one-cortex-a",
        envelope_document("camp-01-task-two-cortex-b", "cortex-b", "0.10"))

    status = campaign.main(["run", "--config", str(write_campaign(tmp_path))])

    assert status == 1
    assert "camp-01-task-one-cortex-a" in failure_document(capsys)["error"]


def test_an_unadmitted_envelope_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    def refuse_admission(document: dict[str, object]) -> dict[str, object]:
        document["grader_admission"] = {"admitted": False}
        return document

    RecordingTrialPath(envelope_mutation=refuse_admission).install(monkeypatch)

    status = campaign.main(["run", "--config", str(write_campaign(tmp_path))])

    assert status == 1
    assert "grader_admission" in failure_document(capsys)["error"]


def test_a_resumed_envelope_without_a_successful_harbor_result_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    RecordingTrialPath().install(monkeypatch)
    trials_dir = tmp_path / "trials"
    trial_id = "camp-01-task-one-cortex-a"
    publish_envelope(trials_dir, trial_id, "cortex-a", "0.10")
    write_result(trials_dir, trial_id, RecordingResult(exception_info=RuntimeError("bad verifier")))

    status = campaign.main(["run", "--config", str(write_campaign(tmp_path))])

    assert status == 1
    assert "bad verifier" in failure_document(capsys)["error"]


def test_an_existing_trial_root_without_a_published_envelope_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    RecordingTrialPath().install(monkeypatch)
    incomplete = tmp_path / "trials" / "camp-01-task-one-cortex-a"
    incomplete.mkdir(parents=True)
    (incomplete / "partial.log").write_text("half a trial", encoding="utf-8")

    status = campaign.main(["run", "--config", str(write_campaign(tmp_path))])

    error = failure_document(capsys)
    assert status == 1
    assert error["ok"] is False
    assert "camp-01-task-one-cortex-a" in error["error"]
    assert (incomplete / "partial.log").read_text(encoding="utf-8") == "half a trial"


# --- the comparison report ----------------------------------------------------------------------


def test_completion_writes_the_existing_comparison_report(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    RecordingTrialPath(default_cost="0.10").install(monkeypatch)

    status, result, _ = run_cli(capsys, "run", "--config", str(write_campaign(tmp_path)))

    report_path = Path(str(result["report_path"]))
    assert status == 0
    assert report_path == tmp_path / "trials" / "comparison-report.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["schema_version"] == COMPARISON_REPORT_SCHEMA_VERSION
    assert report["campaign_id"] == "camp-01"
    assert report["run_order"] == [
        "camp-01-task-one-cortex-a", "camp-01-task-one-cortex-b",
        "camp-01-task-two-cortex-a", "camp-01-task-two-cortex-b",
    ]
    assert report["comparisons"] == [
        {"left_arm": "cortex-a", "right_arm": "cortex-b",
         "difference_class": "orchestration"},
    ]
    first = report["runs"][0]
    assert first["arm"] == "cortex-a"
    assert first["cli"] == {"name": "pi", "version": "2026.8.12"}
    assert first["task"] == {"task_id": "task-one", "image_digest": DIGEST}
    assert first["limits"] == {"wall_clock_seconds": 1800, "provider_requests": 200,
                               "cost_usd": "2.00"}
    assert result["report_sha256"] == hashlib.sha256(report_path.read_bytes()).hexdigest()


def test_the_report_telemetry_is_read_from_each_published_envelope(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    RecordingTrialPath(default_cost="0.35").install(monkeypatch)

    _, result, _ = run_cli(capsys, "run", "--config", str(write_campaign(tmp_path)))

    report = json.loads(Path(str(result["report_path"])).read_text(encoding="utf-8"))
    envelope_path = (tmp_path / "trials" / "camp-01-task-one-cortex-a" / "artifacts"
                     / OUTER_ENVELOPE_FILENAME)
    assert report["runs"][0]["cortex_telemetry"] == {
        "trial_id": "camp-01-task-one-cortex-a",
        "root_run_id": "camp-01-task-one-cortex-a.cortex-a",
        "cost_usd": "0.35", "requests": 2, "input_tokens": 11, "output_tokens": 7,
        "outer_envelope_sha256": hashlib.sha256(envelope_path.read_bytes()).hexdigest(),
    }


def test_a_ceiling_stopped_campaign_still_reports_the_trials_it_ran(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    RecordingTrialPath(default_cost="0.60").install(monkeypatch)
    document = campaign_document(tmp_path, cost_ceiling_usd="1.00")

    _, result, _ = run_cli(
        capsys, "run", "--config", str(write_campaign(tmp_path, document)))

    report = json.loads(Path(str(result["report_path"])).read_text(encoding="utf-8"))
    assert report["run_order"] == ["camp-01-task-one-cortex-a", "camp-01-task-one-cortex-b"]


# --- structured success, failure and dry run ----------------------------------------------------


def test_a_successful_campaign_returns_structured_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    RecordingTrialPath(default_cost="0.10").install(monkeypatch)

    status, result, stderr = run_cli(capsys, "run", "--config", str(write_campaign(tmp_path)))

    assert (status, stderr) == (0, "")
    assert result["ok"] is True
    assert result["campaign"] == "camp-01"
    assert result["cost_ceiling_usd"] == "10.00"
    assert result["started_at"].endswith("Z") and result["ended_at"].endswith("Z")
    assert result["trials"][0] == {
        "trial_id": "camp-01-task-one-cortex-a", "arm": "cortex-a", "task_id": "task-one",
        "state": "ran", "cost_usd": "0.10",
        "outer_envelope_path": str(
            tmp_path / "trials" / "camp-01-task-one-cortex-a" / "artifacts"
            / OUTER_ENVELOPE_FILENAME),
    }


def test_a_failing_trial_stops_the_campaign_with_a_structured_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    recorder = RecordingTrialPath(
        failures=("camp-01-task-one-cortex-b",)).install(monkeypatch)

    status = campaign.main(["run", "--config", str(write_campaign(tmp_path))])

    error = failure_document(capsys)
    assert status == 1
    assert error["ok"] is False
    assert "camp-01-task-one-cortex-b" in error["error"]
    assert recorder.armed == ["camp-01-task-one-cortex-a", "camp-01-task-one-cortex-b"]
    assert not (tmp_path / "trials" / "comparison-report.json").exists()


def test_a_dry_run_plans_every_trial_without_arming_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    recorder = RecordingTrialPath().install(monkeypatch)

    status, result, _ = run_cli(
        capsys, "run", "--config", str(write_campaign(tmp_path)), "--dry-run")

    assert status == 0
    assert result["dry_run"] is True
    assert recorder.events == []
    assert [trial["trial_id"] for trial in result["trials"]] == [
        "camp-01-task-one-cortex-a", "camp-01-task-one-cortex-b",
        "camp-01-task-two-cortex-a", "camp-01-task-two-cortex-b",
    ]
    assert not (tmp_path / "trials").exists()


# --- the real admission boundary ----------------------------------------------------------------
#
# Everything above replaces `create_harbor_trial`, so nothing above can see a document the real
# admission boundary would refuse. These two push every planned trial of a campaign through the
# production builder itself, which is offline and Docker-free, and are the reason the campaign
# composes a per-trial proxy route rather than copying one campaign-wide URL.


def harbor_task_dir(root: Path, name: str, image_ref: str) -> Path:
    task = root / name
    (task / "tests").mkdir(parents=True)
    (task / "instruction.md").write_text("Do the declared work.\n", encoding="utf-8")
    (task / "tests" / "test.sh").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    (task / "task.toml").write_text(
        "[environment]\n"
        f"docker_image = {json.dumps(image_ref)}\n"
        'network_mode = "allowlist"\n'
        "allowed_hosts = []\n"
        'os = "linux"\n\n'
        "[agent]\n"
        "timeout_sec = 1800\n",
        encoding="utf-8",
    )
    return task


def admit_every_trial(config: object, workspace: Path) -> list[str]:
    """Build every planned trial with the production builder; return the trial names it made."""
    names: list[str] = []
    workspace.mkdir(parents=True, exist_ok=True)
    for plan in config.trials():
        manifest = dict(config.trial_manifest(plan))
        for field in ("wheel_path", "lockfile_path", "npm_artifact_path"):
            stub = workspace / f"{plan.trial_id}-{Path(str(manifest[field])).name}"
            stub.write_bytes(b"campaign admission fixture")
            manifest[field] = str(stub)
        built = build_harbor_trial_config(
            dict(plan.arm), task_path=plan.task.path,
            trials_dir=workspace / "admitted-trials", manifest=manifest,
            trial_seed=config.trial_seed(plan), cli_version=config.cli_version,
            host_scan_policy=dict(config.host_scan_policy), trial_proxy=dict(config.proxy),
        )
        names.append(built.trial_name)
    return names


def test_every_planned_trial_is_accepted_by_the_real_admission_builder(tmp_path: Path) -> None:
    document = campaign_document(tmp_path)
    for index, name in enumerate(("one", "two")):
        harbor_task_dir(tmp_path / "tasks", name, IMAGE_REF)
        document["tasks"][index]["path"] = str(tmp_path / "tasks" / name)

    config = load_campaign_config(write_campaign(tmp_path, document))

    assert admit_every_trial(config, tmp_path / "admission") == [
        "camp-01-task-one-cortex-a", "camp-01-task-one-cortex-b",
        "camp-01-task-two-cortex-a", "camp-01-task-two-cortex-b",
    ]


def test_the_committed_zero_paid_campaign_is_accepted_by_the_real_admission_builder(
    tmp_path: Path,
) -> None:
    config = load_campaign_config(COMMITTED_ZERO_PAID_CONFIG)

    admitted = admit_every_trial(config, tmp_path)

    assert admitted == [plan.trial_id for plan in config.trials()]
    assert len(admitted) >= 2


def test_a_route_suffix_that_composes_a_forbidden_destination_is_refused(
    tmp_path: Path,
) -> None:
    document = campaign_document(tmp_path, campaign="api")
    document["credential"]["proxy_host_suffix"] = "deepseek.com"
    document["arms"] = [arm_document("a")]
    document["tasks"] = [{"task_id": "b", "path": str(tmp_path / "tasks" / "one"),
                          "image_ref": IMAGE_REF}]
    document["comparisons"] = []
    document["credential"]["route_identity_host"] = "api-b-a.deepseek.com"

    with pytest.raises(CampaignConfigError) as error:
        load_campaign_config(write_campaign(tmp_path, document))

    assert "api-b-a.deepseek.com" in str(error.value)


@pytest.mark.parametrize(
    "suffix",
    ["http://proxy.invalid", "Proxy.Invalid", "proxy.invalid:4317", "proxy.invalid/route"],
)
def test_a_malformed_route_suffix_is_refused(tmp_path: Path, suffix: str) -> None:
    document = campaign_document(tmp_path)
    document["credential"]["proxy_host_suffix"] = suffix

    with pytest.raises(CampaignConfigError) as error:
        load_campaign_config(write_campaign(tmp_path, document))

    assert "proxy_host_suffix" in str(error.value)


# --- the committed ZERO-PAID campaign -----------------------------------------------------------


def test_the_committed_zero_paid_campaign_config_is_valid_and_unpaid() -> None:
    config = load_campaign_config(COMMITTED_ZERO_PAID_CONFIG)

    assert config.paid is False
    assert config.arms and len(config.tasks) >= 2
    assert all(arm["credential_capability"] for arm in config.arms)
    assert config.cost_ceiling_usd > 0
    assert all(not str(task.path).startswith("/var") for task in config.tasks)


def test_the_committed_zero_paid_campaign_names_no_provider_or_gateway_endpoint() -> None:
    config = load_campaign_config(COMMITTED_ZERO_PAID_CONFIG)

    upstream = str(config.credential["upstream_base_url"])
    assert upstream.startswith("http://127.0.0.1:")
    assert ":9880" not in upstream


def test_the_committed_zero_paid_tasks_load_and_pin_the_declared_image() -> None:
    from harbor.models.task.task import Task

    config = load_campaign_config(COMMITTED_ZERO_PAID_CONFIG)

    for task in config.tasks:
        loaded = Task(task_dir=task.path)
        assert loaded.config.environment.docker_image == task.image_ref
        assert task.image_ref.endswith(f"@{task.image_digest}")
        verifier = (task.path / "tests" / "test.sh").read_text(encoding="utf-8")
        assert "/logs/verifier/reward.txt" in verifier


# --- the declared request-cost / output-cap pairing --------------------------------------------
#
# The 2026-08-13 paid attempt declared max_cost_usd $2.00 against max_request_cost_usd $0.50 and
# bought four provider requests before the route answered 429 budget_exhausted
# (results/terminal-bench-2.1-deepseek-paid-2026-08-13.json). Every field sat below its capability
# ceiling; it was the PAIR that was wrong, so the pair is what the document is now read for.


def paired_document(root: Path, **proxy: object) -> dict[str, object]:
    document = campaign_document(root)
    document["arms"] = [arm_document("cortex-direct")]
    document["comparisons"] = []
    document["proxy"].update(proxy)
    return document


def test_the_request_cost_pairing_that_bought_only_four_turns_is_refused(tmp_path: Path) -> None:
    """The exact declared numbers of the failed paid attempt, refused as a document."""
    document = paired_document(tmp_path, max_request_cost_usd="0.50")

    with pytest.raises(CampaignConfigError) as error:
        load_campaign_config(write_campaign(tmp_path, document))

    message = str(error.value)
    assert "floor(2.00 / 0.5) = 4 provider requests" in message
    assert "below the 200 its max_provider_requests declares" in message
    assert "429 budget_exhausted" in message


def test_a_pairing_that_funds_every_declared_request_is_accepted(tmp_path: Path) -> None:
    document = paired_document(tmp_path, max_request_cost_usd="0.01")

    config = load_campaign_config(write_campaign(tmp_path, document))

    assert str(config.proxy["max_request_cost_usd"]) == "0.01"


def test_an_output_cap_one_reservation_cannot_pay_for_is_refused(tmp_path: Path) -> None:
    """A cap above one reservation is refused mid-trial as budget_accounting_exceeded, which
    deactivates the route, so the document is refused instead."""
    document = paired_document(tmp_path, max_request_cost_usd="0.001")
    document["arms"][0]["limits"]["max_provider_requests"] = 200

    with pytest.raises(CampaignConfigError) as error:
        load_campaign_config(write_campaign(tmp_path, document))

    message = str(error.value)
    assert "32768 * 0.28 / 1000000 = 0.00917504 USD" in message
    assert "budget_accounting_exceeded" in message


# --- the committed paid campaign ----------------------------------------------------------------


def test_the_committed_paid_campaign_config_declares_the_approved_envelope() -> None:
    config = load_campaign_config(COMMITTED_PAID_CONFIG)
    (arm,) = config.arms
    limits = arm["limits"]

    assert (config.paid, config.cost_ceiling_text) == (True, "10.00")
    assert (arm["kind"], arm["backend"], arm["provider"], arm["model"]) == (
        "cortex", "pi", "deepseek", "deepseek-v4-flash")
    assert arm["orchestration"] == {"mode": "direct", "ask_manager": False}
    assert Decimal(str(limits["max_cost_usd"])) <= Decimal("2.00")
    assert int(limits["max_output_tokens"]) >= 4096
    assert [task.task_id for task in config.tasks] == [
        "chess-best-move", "constraints-scheduling", "db-wal-recovery"]
    assert [task.image_digest for task in config.tasks] == [
        f"sha256:{digest}" for digest in (
            "f84a499762df4e6f1171cce718628b419e58a910513f371e119740171236798b",
            "6cad45f1f79e0c178d4b23ec1c930179d7d5dba2e0bdf27900dfc29c6a1bd04c",
            "0ace05c2bcd266e4ff7b8da863667b959393404a82d981b548d41493704a335a",
        )]


def test_the_committed_paid_campaign_funds_a_multi_turn_trial() -> None:
    """The pairing arithmetic the config's header documents, pinned here."""
    config = load_campaign_config(COMMITTED_PAID_CONFIG)
    (arm,) = config.arms
    spec = parse_trial_proxy_spec(config.proxy)
    budget = ProxyBudget(
        max_cost_usd=Decimal(str(arm["limits"]["max_cost_usd"])),
        max_request_cost_usd=spec.max_request_cost_usd,
        input_cost_per_million_usd=spec.input_cost_per_million_usd,
        output_cost_per_million_usd=spec.output_cost_per_million_usd,
    )
    cap = int(arm["limits"]["max_output_tokens"])

    assert budget.funded_request_count() == 100
    assert budget.output_cap_cost_usd(cap) == Decimal("0.00229376")
    assert int(arm["limits"]["max_provider_requests"]) == 100
    # Worst case: every trial spends its whole ceiling and the campaign still fits.
    assert len(config.tasks) * budget.max_cost_usd <= config.cost_ceiling_usd


def test_the_committed_paid_campaign_stays_within_every_capability_ceiling() -> None:
    config = load_campaign_config(COMMITTED_PAID_CONFIG)
    (arm,) = config.arms
    ceilings = load_capability_ceilings()[str(arm["credential_capability"])]
    declared = validate_paid_envelope(
        arm, parse_trial_proxy_spec(config.proxy), str(arm["credential_capability"]))

    assert declared and all(value <= ceilings[field] for field, value in declared.items())


# The 2026-08-13 attempts whose roots are preserved as immutable evidence: `tb21-paid` (four
# funded requests, then `429 budget_exhausted`) and `tb21-paid-r2` (refused before admission).
PRESERVED_ATTEMPT_ROOTS = {
    "tb21-paid": Path("/var/tmp/cortex-bench/tb21-paid-2026-08-13-37cf"),
    "tb21-paid-r2": Path("/var/tmp/cortex-bench/tb21-paid-r2-2026-08-13-46b6"),
}


def test_the_committed_paid_campaign_uses_a_fresh_identity() -> None:
    """The committed document never names a preserved attempt's identity or root. Whether a root
    exists yet is host state, not a property of the document -- an existing root without a
    published envelope is refused at run time (see the refusal test above), so this test stays
    true once the campaign has actually run."""
    config = load_campaign_config(COMMITTED_PAID_CONFIG)

    assert config.campaign not in PRESERVED_ATTEMPT_ROOTS
    for root in PRESERVED_ATTEMPT_ROOTS.values():
        assert config.trials_dir != root and root not in config.trials_dir.parents
    assert all(plan.trial_id.startswith(f"{config.campaign}-") for plan in config.trials())
