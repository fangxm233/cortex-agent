# input:  campaign configs, trial recorder and published envelopes
# output: routing, terminal outcome, resume and delivery proofs
# pos:    Campaign runner behaviour tests
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# The driver is proven black-box: a campaign document goes in, trial roots and one comparison
# report come out. The production trial path is replaced by a recorder that reserves a fresh root
# exactly as the real one does, so "the driver never clobbers an existing root" is proven by the
# same failure the production path would raise rather than by a mock's politeness.

import asyncio
import base64
import hashlib
import json
import tomllib
from pathlib import Path

import pytest
import yaml

from cortex_bench_harness import campaign
from cortex_bench_harness.launcher.production_session import (
    SERVER_READY_TIMEOUT_SECONDS,
    SERVER_STOP_TIMEOUT_SECONDS,
)
from cortex_bench_harness.launcher.lease_bound import SETUP_TIMEOUT_MS, TEARDOWN_GRACE_MS
from cortex_bench_harness.campaign_config import (
    CAMPAIGN_SCHEMA_VERSION,
    CampaignConfigError,
    NetworkSlot,
    load_campaign_config,
    parse_campaign_config,
)
from cortex_bench_harness.host_finalization import (
    OUTER_ENVELOPE_FILENAME,
    OUTER_ENVELOPE_SCHEMA_VERSION,
    parse_host_scan_policy,
)
from cortex_bench_harness.campaign import PROXY_EXPORT_FILENAME
from cortex_bench_harness.launcher.capability_ceilings import load_capability_ceilings
from cortex_bench_harness.launcher.comparison_report import (
    COMPARISON_REPORT_SCHEMA_VERSION,
)
from cortex_bench_harness.launcher.trial_admission import build_harbor_trial_config
from cortex_bench_harness.launcher.trial_proxy import (
    parse_trial_proxy_spec,
    validate_paid_envelope,
)
from cortex_bench_harness.proxy.adapters.openai_codex_responses import JWT_ACCOUNT_CLAIM

DIGEST = f"sha256:{'a' * 64}"
IMAGE_REF = f"registry.invalid/task@{DIGEST}"
HARNESS_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = HARNESS_ROOT.parents[1]
CAMPAIGNS_DIR = REPO_ROOT / "benchmark" / "campaigns"
COMMITTED_ZERO_PAID_CONFIG = CAMPAIGNS_DIR / "zero-paid-dry-run.yaml"
COMMITTED_PAID_CONFIG = CAMPAIGNS_DIR / "terminal-bench-2.1-deepseek-paid.yaml"
COMMITTED_VENDOR_CONFIGS = {
    "pi": CAMPAIGNS_DIR / "terminal-bench-2.1-vendor-pi.yaml",
    "claude-code": CAMPAIGNS_DIR / "terminal-bench-2.1-vendor-claude-code.yaml",
    "codex": CAMPAIGNS_DIR / "terminal-bench-2.1-vendor-codex.yaml",
}
LAUNCH_SCRIPT = HARNESS_ROOT / "scripts" / "launch-paid-campaign.py"
CODEX_CREDENTIAL_ENV = "CORTEX_BENCH_TEST_CODEX_CREDENTIAL"
CODEX_NOW_MS = 1_900_000_000_000


def arm_document(name: str, **overrides: object) -> dict[str, object]:
    return {
        "name": name, "kind": "cortex", "backend": "pi", "provider": "deepseek",
        "model": "deepseek-v4-flash", "credential_capability": "pi-deepseek-api-key",
        "orchestration": {"mode": "direct", "ask_manager": False},
        "limits": {
            "max_provider_requests": 200, "max_cost_usd": "2.00",
            "deadline_seconds": 1800, "max_output_tokens": 32768,
        },
        **overrides,
    }


def vendor_arm_document(
    name: str, vendor_agent: str = "pi", vendor_cli_version: str = "0.82.1",
    **overrides: object,
) -> dict[str, object]:
    return {
        "name": name, "kind": "vendor-baseline", "provider": "deepseek",
        "model": "deepseek-v4-flash", "credential_capability": "pi-deepseek-api-key",
        "vendor_agent": vendor_agent, "vendor_cli_version": vendor_cli_version,
        "limits": {
            "max_provider_requests": 200, "max_cost_usd": "2.00",
            "deadline_seconds": 1800, "max_output_tokens": 32768,
        },
        **overrides,
    }


def campaign_document(root: Path, **overrides: object) -> dict[str, object]:
    return {
        "schema_version": CAMPAIGN_SCHEMA_VERSION,
        "campaign": "camp-01",
        "paid": False,
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
            "subnet_pool": "172.30.240.0/22", "subnet_prefix": 24,
        },
        "proxy": {
            # No cost fields: the route is bounded by the arm's own max_provider_requests, and
            # the proxy holds no price list to turn traffic into money with.
            "credential_env": "CORTEX_BENCH_TEST_CREDENTIAL",
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


def codex_campaign_document(root: Path, *, concurrency: int = 3) -> dict[str, object]:
    document = campaign_document(root, concurrency=concurrency, comparisons=[])
    document["arms"] = [vendor_arm_document(
        "pure-codex", vendor_agent="codex", vendor_cli_version="0.117.0",
        provider="openai-codex", model="gpt-5.4",
        credential_capability="codex-subscription",
    )]
    document["tasks"].append({
        "task_id": "task-three", "path": str(root / "tasks" / "three"),
        "image_ref": IMAGE_REF,
    })
    document["proxy"]["credential_env"] = CODEX_CREDENTIAL_ENV
    document["credential"]["route_identity_host"] = "chatgpt.com"
    return document


def codex_token(expiry_ms: int) -> str:
    def segment(document: dict[str, object]) -> str:
        encoded = json.dumps(document, separators=(",", ":")).encode()
        return base64.b64encode(encoded).decode().rstrip("=")

    return ".".join((
        segment({"alg": "none", "typ": "JWT"}),
        segment({
            JWT_ACCOUNT_CLAIM: {"chatgpt_account_id": "dummy-campaign-account"},
            "exp": expiry_ms // 1000,
        }),
        segment({"synthetic": True}),
    ))


def required_codex_expiry_ms() -> int:
    return (
        CODEX_NOW_MS + 3 * campaign.NETWORK_CREATE_TIMEOUT_MS
        + SETUP_TIMEOUT_MS + 1_800_000 + TEARDOWN_GRACE_MS
        + campaign.CODEX_CLOCK_SKEW_MARGIN_MS
    )


def write_campaign(root: Path, document: dict[str, object] | None = None) -> Path:
    path = root / "campaign.yaml"
    path.write_text(yaml.safe_dump(document or campaign_document(root)), encoding="utf-8")
    return path


def envelope_document(
    trial_id: str, arm_name: str, requests: int,
) -> dict[str, object]:
    return {
        "schema_version": OUTER_ENVELOPE_SCHEMA_VERSION,
        "identity": {"trial_id": trial_id, "root_run_id": f"{trial_id}.{arm_name}",
                     "arm_name": arm_name},
        "evidence": {"roots": [
            {"root": root, "status": "collected"}
            for root in ("agent", "verifier", "artifacts")
        ]},
        "proxy_usage": {"requests": requests, "input_tokens": 11,
                        "output_tokens": 7, "reconciled": True},
        "revocation": {
            "schema_version": "cortex-bench-proxy-revocation/1",
            "trial_id": trial_id, "route_active": False,
            "listener_present": False, "serving_thread_alive": False,
            "active_handlers": 0, "body_handlers": 0,
        },
        "leak_scan": {
            "ok": True, "clean": True, "matches": [],
            "missing_sources": [], "unclassified_files": [],
        },
        "publication": {
            "root": "artifacts", "relative_path": OUTER_ENVELOPE_FILENAME,
            "atomic": True, "post_publication_reread": True,
        },
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


def write_proxy_export(trials_dir: Path, trial_id: str, requests: int) -> Path:
    """What the host metered for one trial, which exists whether or not the trial published.

    Every r5 trial wrote this file: the two refused at finalization and the one cut by the agent
    timeout all had one. A request is counted at the proxy, long before anything decides whether
    the trial is gradable, so this is the only per-trial record that can answer how much provider
    traffic a run made.
    """
    proxy = trials_dir / trial_id / "artifacts" / "proxy"
    proxy.mkdir(parents=True, exist_ok=True)
    path = proxy / PROXY_EXPORT_FILENAME
    path.write_text(json.dumps({
        "schema_version": "cortex-bench-proxy-export/1", "trial_id": trial_id,
        "requests": {"status": "available", "value": requests},
    }, sort_keys=True) + "\n", encoding="utf-8")
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
    trials_dir: Path, trial_id: str, arm_name: str, requests: int,
) -> Path:
    path = write_envelope(
        trials_dir, trial_id, envelope_document(trial_id, arm_name, requests))
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
        # A real trial waits on Docker before it does anything, so the recorder yields too: a
        # coroutine that never awaits runs to completion, and a scheduler proven against one
        # would look serial no matter how many workers it started.
        await asyncio.sleep(0)
        try:
            return await self._run()
        finally:
            self.path.leave(self.trial_id)

    async def _run(self) -> object:
        blocker = self.path.waits.get(self.trial_id)
        if blocker is not None:
            await self.path.finished(blocker).wait()
        trials_dir = Path(str(self.kwargs["trials_dir"]))
        spend = self.path.spends.get(self.trial_id)
        if spend is not None:
            write_proxy_export(trials_dir, self.trial_id, spend)
        if self.trial_id in self.path.failures:
            raise RuntimeError(f"container refused trial {self.trial_id}")
        arm_name = str(self.kwargs["arm"]["name"])
        document = envelope_document(
            self.trial_id, arm_name,
            self.path.requests.get(self.trial_id, self.path.default_requests),
        )
        write_envelope(
            trials_dir, self.trial_id, self.path.envelope_mutation(document),
        )
        result = self.path.results.get(
            self.trial_id, RecordingResult(rewards={"reward": 1.0}))
        write_result(trials_dir, self.trial_id, result)
        return result


class RecordingTrialPath:
    """Stands in for `create_harbor_trial`, including its fresh-root reservation.

    It also records the campaign's *schedule*: which trials were in flight together, and how many
    at once. `waits` lets a test pin the finishing order independently of the arming order, which
    is the case a concurrent driver has to keep deterministic.
    """

    def __init__(
        self, *, default_requests: int = 6, requests: dict[str, int] | None = None,
        failures: tuple[str, ...] = (),
        envelope_mutation: object = None,
        results: dict[str, RecordingResult] | None = None,
        waits: dict[str, str] | None = None,
        spends: dict[str, int] | None = None,
    ) -> None:
        self.default_requests = default_requests
        self.requests = requests or {}
        self.spends = spends or {}
        self.failures = set(failures)
        self.envelope_mutation = envelope_mutation or (lambda document: document)
        self.results = results or {}
        self.waits = waits or {}
        self.calls: list[dict[str, object]] = []
        self.events: list[tuple[str, str]] = []
        self.in_flight = 0
        self.max_in_flight = 0
        self._finished: dict[str, asyncio.Event] = {}

    def install(self, monkeypatch: pytest.MonkeyPatch) -> "RecordingTrialPath":
        monkeypatch.setattr(campaign, "create_harbor_trial", self._create)
        monkeypatch.setattr(campaign, "_create_trial_network", lambda *_: "network-fixture")
        monkeypatch.setattr(campaign, "_remove_trial_network", lambda *_: None)
        return self

    @property
    def armed(self) -> list[str]:
        return [trial_id for state, trial_id in self.events if state == "armed"]

    def finished(self, trial_id: str) -> asyncio.Event:
        return self._finished.setdefault(trial_id, asyncio.Event())

    def enter(self, trial_id: str) -> None:
        """In flight from the moment the trial is armed: that is when it holds a network."""
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)

    def leave(self, trial_id: str) -> None:
        self.in_flight -= 1
        self.events.append(("finished", trial_id))
        self.finished(trial_id).set()

    async def _create(self, **kwargs: object) -> RecordingTrial:
        trial_id = str(kwargs["trial_seed"]["trial_id"])
        (Path(str(kwargs["trials_dir"])) / trial_id).mkdir(parents=True)
        self.calls.append(kwargs)
        self.events.append(("armed", trial_id))
        self.enter(trial_id)
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
    assert config.concurrency == 1, "an undeclared concurrency is the serial campaign"
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

    spec = parse_trial_proxy_spec(config.slot_proxy(config.slot(0)))
    policy = parse_host_scan_policy(config.host_scan_policy)

    assert spec.request_body_limit_bytes == 16777216
    assert spec.bound_source_ip == "172.30.240.2"
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
        ({"cli_version": ""}, "cli_version"),
        ({"arms": []}, "arms"),
        ({"tasks": []}, "tasks"),
        ({"concurrency": 0}, "concurrency"),
        ({"concurrency": 1.5}, "concurrency"),
    ],
)
def test_a_malformed_campaign_document_is_refused(
    tmp_path: Path, mutation: dict[str, object], fragment: str,
) -> None:
    path = write_campaign(tmp_path, campaign_document(tmp_path, **mutation))

    with pytest.raises(CampaignConfigError) as error:
        load_campaign_config(path)

    assert fragment in str(error.value)


@pytest.mark.parametrize(
    ("network", "fragment"),
    [
        # The stale shape every committed document used to carry. Closed-world reading turns it
        # into a refusal that names the fields that replaced it, rather than a silently ignored
        # address literal serving one trial at a time.
        ({"subnet": "172.30.240.0/24", "gateway": "172.30.240.1"}, "subnet_pool"),
        ({"subnet_pool": "172.30.240.1/24", "subnet_prefix": 24}, "host bits"),
        ({"subnet_pool": "8.8.8.0/24", "subnet_prefix": 24}, "private"),
        ({"subnet_pool": "172.30.240.0/24", "subnet_prefix": 20}, "between the pool's own"),
        ({"subnet_pool": "172.30.240.0/24", "subnet_prefix": 31}, "smallest network"),
        ({"subnet_pool": "172.30.240.0/24", "subnet_prefix": "24"}, "positive integer"),
    ],
)
def test_a_docker_network_that_cannot_carry_concurrent_trials_is_refused(
    tmp_path: Path, network: dict[str, object], fragment: str,
) -> None:
    document = campaign_document(tmp_path, docker_network=network)

    with pytest.raises(CampaignConfigError) as error:
        load_campaign_config(write_campaign(tmp_path, document))

    assert fragment in str(error.value)


def test_a_concurrency_the_declared_pool_cannot_address_is_refused(tmp_path: Path) -> None:
    """The bound that makes a slot's address space a property of the document, not of luck."""
    document = campaign_document(
        tmp_path, concurrency=5,
        docker_network={"subnet_pool": "172.30.240.0/22", "subnet_prefix": 24})

    with pytest.raises(CampaignConfigError) as error:
        load_campaign_config(write_campaign(tmp_path, document))

    assert "4 trial networks" in str(error.value)


@pytest.mark.parametrize("field", ["bound_source_ip", "access_expires_at_ms"])
def test_campaign_proxy_refuses_host_derived_fields(tmp_path: Path, field: str) -> None:
    document = campaign_document(tmp_path)
    document["proxy"] = {**document["proxy"], field: 1}

    with pytest.raises(CampaignConfigError) as error:
        load_campaign_config(write_campaign(tmp_path, document))

    assert "host-derived" in str(error.value)


def test_each_slot_owns_a_distinct_subnet_gateway_and_container_address(
    tmp_path: Path,
) -> None:
    config = load_campaign_config(write_campaign(
        tmp_path, campaign_document(tmp_path, concurrency=4)))
    slots = [config.slot(index) for index in range(config.concurrency)]

    assert [slot.subnet for slot in slots] == [
        "172.30.240.0/24", "172.30.241.0/24", "172.30.242.0/24", "172.30.243.0/24"]
    assert [slot.gateway for slot in slots] == [
        f"172.30.24{index}.1" for index in range(4)]
    assert [slot.container_ip for slot in slots] == [
        f"172.30.24{index}.2" for index in range(4)]
    assert len({slot.subnet for slot in slots}) == len(slots)


def test_slot_zero_is_the_address_space_every_committed_run_so_far_used(
    tmp_path: Path,
) -> None:
    """The generalisation keeps the values r1-r4 and both ZERO-PAID runs were carried out on."""
    config = load_campaign_config(write_campaign(tmp_path))

    assert config.slot(0) == NetworkSlot(
        index=0, subnet="172.30.240.0/24", gateway="172.30.240.1",
        container_ip="172.30.240.2")


def test_a_slot_outside_the_declared_pool_is_refused(tmp_path: Path) -> None:
    config = load_campaign_config(write_campaign(tmp_path))

    with pytest.raises(CampaignConfigError) as error:
        config.slot(config.docker_network.slot_count)

    assert "outside the 4 slots" in str(error.value)


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


def test_a_vendor_baseline_arm_parses_with_its_own_cli_version(tmp_path: Path) -> None:
    document = campaign_document(
        tmp_path, arms=[vendor_arm_document("pure-pi")], comparisons=[])

    (arm,) = load_campaign_config(write_campaign(tmp_path, document)).arms

    assert arm == {
        "schema_version": "cortex-benchmark-arm/2",
        "name": "pure-pi", "kind": "vendor-baseline", "provider": "deepseek",
        "model": "deepseek-v4-flash", "credential_capability": "pi-deepseek-api-key",
        "vendor_agent": "pi", "vendor_cli_version": "0.82.1",
        "limits": {
            "max_provider_requests": 200, "max_cost_usd": "2.00",
            "deadline_seconds": 1800, "max_output_tokens": 32768,
        },
    }


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("backend", "pi"),
        ("orchestration", {"mode": "direct", "ask_manager": False}),
        ("environment", {"CORTEX_HOME": "/tmp/cortex-home"}),
    ],
)
def test_a_vendor_arm_declaring_cortex_fields_is_refused(
    tmp_path: Path, field: str, value: object,
) -> None:
    arm = vendor_arm_document("pure-pi")
    arm[field] = value
    document = campaign_document(tmp_path, arms=[arm], comparisons=[])

    with pytest.raises(CampaignConfigError) as error:
        load_campaign_config(write_campaign(tmp_path, document))

    assert field in str(error.value)


def test_an_unknown_vendor_agent_is_refused(tmp_path: Path) -> None:
    document = campaign_document(
        tmp_path, arms=[vendor_arm_document("pure-unknown", vendor_agent="unknown")],
        comparisons=[])

    with pytest.raises(CampaignConfigError) as error:
        load_campaign_config(write_campaign(tmp_path, document))

    assert "unknown" in str(error.value)
    assert "vendor_agent" in str(error.value)


def test_a_vendor_arm_missing_its_cli_version_is_refused(tmp_path: Path) -> None:
    arm = vendor_arm_document("pure-pi")
    del arm["vendor_cli_version"]
    document = campaign_document(tmp_path, arms=[arm], comparisons=[])

    with pytest.raises(CampaignConfigError) as error:
        load_campaign_config(write_campaign(tmp_path, document))

    assert "vendor_cli_version" in str(error.value)


def test_an_unknown_arm_kind_is_refused(tmp_path: Path) -> None:
    document = campaign_document(
        tmp_path, arms=[vendor_arm_document("pure-pi", kind="unknown")], comparisons=[])

    with pytest.raises(CampaignConfigError) as error:
        load_campaign_config(write_campaign(tmp_path, document))

    assert "unknown" in str(error.value)
    assert "kind" in str(error.value)


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


# --- execution through the production trial path -------------------------------------------------


def test_codex_three_trial_wave_passes_one_expiry_to_every_trial_without_auth_file_reads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    recorder = RecordingTrialPath().install(monkeypatch)
    expiry_ms = required_codex_expiry_ms()
    monkeypatch.setattr(campaign, "_now_ms", lambda: CODEX_NOW_MS)
    monkeypatch.setenv(CODEX_CREDENTIAL_ENV, codex_token(expiry_ms))
    real_auth = Path.home() / ".codex" / "auth.json"
    original = Path.read_text

    def tracked(path: Path, *args: object, **kwargs: object) -> str:
        assert path != real_auth
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", tracked)
    status, _, _ = run_cli(capsys, "run", "--config", str(write_campaign(
        tmp_path, codex_campaign_document(tmp_path))))

    assert status == 0
    assert recorder.max_in_flight == 3
    assert len(recorder.armed) == 3
    assert {call["trial_proxy"]["access_expires_at_ms"] for call in recorder.calls} == {
        expiry_ms}
    assert all(
        call["trial_seed"]["credential"]["upstream_base_url"].startswith("http://127.0.0.1")
        for call in recorder.calls
    )


def test_short_codex_token_refuses_the_whole_campaign_with_zero_routes_armed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    recorder = RecordingTrialPath().install(monkeypatch)
    monkeypatch.setattr(campaign, "_now_ms", lambda: CODEX_NOW_MS)
    monkeypatch.setenv(CODEX_CREDENTIAL_ENV, codex_token(required_codex_expiry_ms() - 1000))

    status = campaign.main(["run", "--config", str(write_campaign(
        tmp_path, codex_campaign_document(tmp_path)))])

    assert status == 1
    assert "whole concurrent wave" in failure_document(capsys)["error"]
    assert recorder.armed == []
    assert recorder.calls == []


def test_expired_codex_token_is_refused_before_native_refresh_or_route_arming(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    recorder = RecordingTrialPath().install(monkeypatch)
    monkeypatch.setattr(campaign, "_now_ms", lambda: CODEX_NOW_MS)
    monkeypatch.setenv(CODEX_CREDENTIAL_ENV, codex_token(CODEX_NOW_MS - 1000))

    status = campaign.main(["run", "--config", str(write_campaign(
        tmp_path, codex_campaign_document(tmp_path)))])

    assert status == 1
    assert "expired" in failure_document(capsys)["error"]
    assert recorder.armed == []
    assert recorder.calls == []


def test_codex_pending_trials_must_fit_one_concurrent_wave_before_arming(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    recorder = RecordingTrialPath().install(monkeypatch)
    monkeypatch.setattr(campaign, "_now_ms", lambda: CODEX_NOW_MS)
    monkeypatch.setenv(CODEX_CREDENTIAL_ENV, codex_token(required_codex_expiry_ms()))

    status = campaign.main(["run", "--config", str(write_campaign(
        tmp_path, codex_campaign_document(tmp_path, concurrency=2)))])

    assert status == 1
    assert "one concurrent wave" in failure_document(capsys)["error"]
    assert recorder.armed == []


def test_codex_vendor_arm_must_name_the_exact_codex_capability_before_arming(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    recorder = RecordingTrialPath().install(monkeypatch)
    document = codex_campaign_document(tmp_path)
    document["arms"][0]["credential_capability"] = "claude-subscription"

    status = campaign.main(["run", "--config", str(write_campaign(tmp_path, document))])

    assert status == 1
    assert "exact codex-subscription capability" in failure_document(capsys)["error"]
    assert recorder.armed == []


def test_an_undeclared_concurrency_runs_trials_one_at_a_time_in_declared_order(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    """A document that says nothing about parallelism keeps the campaign it always described."""
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
    assert recorder.max_in_flight == 1
    assert [trial["trial_id"] for trial in result["trials"]] == recorder.armed


def test_declared_concurrency_puts_that_many_trials_in_flight_and_never_more(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    recorder = RecordingTrialPath().install(monkeypatch)
    document = campaign_document(tmp_path, concurrency=2)

    status, result, _ = run_cli(
        capsys, "run", "--config", str(write_campaign(tmp_path, document)))

    assert status == 0
    assert recorder.max_in_flight == 2, "the declared bound is a bound"
    assert len(recorder.armed) == 4
    assert result["concurrency"] == 2
    # The property a serial loop cannot have: a second trial is armed before the first finishes.
    assert recorder.events[:2] == [
        ("armed", "camp-01-task-one-cortex-a"), ("armed", "camp-01-task-one-cortex-b"),
    ]


def test_trials_are_reported_in_declared_order_whatever_order_they_finish_in(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    """Concurrency must not make the record of a campaign depend on the race that produced it."""
    first, second = "camp-01-task-one-cortex-a", "camp-01-task-one-cortex-b"
    recorder = RecordingTrialPath(waits={first: second}).install(monkeypatch)
    document = campaign_document(tmp_path, concurrency=2)

    status, result, _ = run_cli(
        capsys, "run", "--config", str(write_campaign(tmp_path, document)))

    assert status == 0
    finished = [trial_id for state, trial_id in recorder.events if state == "finished"]
    assert finished[:2] == [second, first], "the second declared trial finished first"
    assert [trial["trial_id"] for trial in result["trials"]] == [
        first, second, "camp-01-task-two-cortex-a", "camp-01-task-two-cortex-b",
    ]
    report = json.loads(Path(str(result["report_path"])).read_text(encoding="utf-8"))
    assert report["run_order"] == [trial["trial_id"] for trial in result["trials"]]


def test_each_trial_gets_a_fresh_network_on_the_subnet_its_slot_owns(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    recorder = RecordingTrialPath().install(monkeypatch)
    calls: list[list[object]] = []

    def create(config: object, plan: object, slot: object) -> str:
        calls.append(["create", plan.trial_id, slot.index, slot.subnet, slot.gateway])
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
        ["create", "camp-01-task-one-cortex-a", 0, "172.30.240.0/24", "172.30.240.1"],
        ["remove", "network-camp-01-task-one-cortex-a"],
        ["create", "camp-01-task-two-cortex-a", 0, "172.30.240.0/24", "172.30.240.1"],
        ["remove", "network-camp-01-task-two-cortex-a"],
    ]
    assert len(recorder.armed) == 2


def test_concurrent_trials_never_share_a_subnet_or_a_container_address(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    """The reason concurrency needs an address pool: Docker refuses overlapping subnets, and a
    credential route bound to one address can only answer one container."""
    live: dict[str, str] = {}
    overlaps: list[tuple[str, str]] = []

    def create(config: object, plan: object, slot: object) -> str:
        for held_trial, held_subnet in live.items():
            if held_subnet == slot.subnet:
                overlaps.append((held_trial, plan.trial_id))
        live[plan.trial_id] = slot.subnet
        return f"network-{plan.trial_id}|{slot.subnet}"

    def remove(network_id: str) -> None:
        live.pop(network_id.split("|")[0].removeprefix("network-"), None)

    recorder = RecordingTrialPath().install(monkeypatch)
    monkeypatch.setattr(campaign, "_create_trial_network", create)
    monkeypatch.setattr(campaign, "_remove_trial_network", remove)
    document = campaign_document(tmp_path, concurrency=2)

    status, _, _ = run_cli(
        capsys, "run", "--config", str(write_campaign(tmp_path, document)))

    assert status == 0
    assert recorder.max_in_flight == 2
    assert overlaps == [], "two trials held the same subnet at the same time"
    bindings = {
        str(call["trial_seed"]["trial_id"]): str(call["trial_proxy"]["bound_source_ip"])
        for call in recorder.calls
    }
    assert set(bindings.values()) == {"172.30.240.2", "172.30.241.2"}


def test_a_trial_reuses_a_slot_once_the_previous_trial_released_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    """Four trials over two slots: a slot's subnet has to be usable again after its network went."""
    recorder = RecordingTrialPath().install(monkeypatch)
    document = campaign_document(tmp_path, concurrency=2)

    status, result, _ = run_cli(
        capsys, "run", "--config", str(write_campaign(tmp_path, document)))

    assert status == 0
    slots = [trial["slot"] for trial in result["trials"]]
    assert sorted(slots) == [0, 0, 1, 1]


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
        asyncio.run(campaign._arm_trial(config, config.trials()[0], config.slot(0)))

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
    assert kwargs["trial_proxy"] == {
        **document["proxy"], "bound_source_ip": "172.30.240.2",
    }, "the declared envelope, plus the address this trial's slot binds to"
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


# --- what stops a campaign, and what does not ---------------------------------------------------


def test_a_declared_campaign_cost_ceiling_is_refused(tmp_path: Path) -> None:
    """The between-trial money stop is gone, not optional.

    It was checked against *published* envelopes, so a wave of trials in flight could overshoot it
    and it could not see money being spent while it was being checked. A document still carrying
    it would declare a bound nothing reads, so it is refused instead.
    """
    document = campaign_document(tmp_path, cost_ceiling_usd="1.00")

    with pytest.raises(CampaignConfigError) as caught:
        load_campaign_config(write_campaign(tmp_path, document))

    assert "cost_ceiling_usd" in str(caught.value)


def test_a_trial_that_fails_is_recorded_and_every_later_trial_still_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    """One flake must not cost the measurements of every task behind it."""
    failed = "camp-01-task-one-cortex-b"
    recorder = RecordingTrialPath(
        default_requests=1, failures=(failed,)).install(monkeypatch)

    status, result, _ = run_cli(capsys, "run", "--config", str(write_campaign(tmp_path)))

    assert len(recorder.armed) == 4, "the campaign ran every declared trial"
    states = {trial["trial_id"]: trial["state"] for trial in result["trials"]}
    assert states[failed] == "failed"
    assert set(states.values()) == {"ran", "failed"}
    reason = next(trial["reason"] for trial in result["trials"] if trial["trial_id"] == failed)
    assert "container refused trial" in reason
    assert result["state"] == "completed", "the driver finished; one trial did not"
    assert status == 1 and result["ok"] is False, "a campaign missing a measurement is not ok"
    assert result["trials_failed"] == 1
    assert result["provider_requests"] == 3, (
        "one request from each of the three trials that published; the trial that failed "
        "published no envelope")
    assert result["provider_requests_complete"] is False, (
        "and left no meter for the driver to read either")


def test_a_leaked_docker_network_stops_the_campaign_and_is_reported(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    """A host-level fault, unlike a failed trial: every remaining trial would meet it too."""
    recorder = RecordingTrialPath(default_requests=1).install(monkeypatch)
    monkeypatch.setattr(
        campaign, "_remove_trial_network",
        lambda _network_id: (_ for _ in ()).throw(
            campaign.HostFaultError("network cleanup failed")),
    )

    status, result, _ = run_cli(capsys, "run", "--config", str(write_campaign(tmp_path)))

    assert status == 1, "the campaign did not complete"
    assert result["ok"] is False
    assert result["state"] == "stopped-after-host-fault"
    assert "network cleanup failed" in str(result["fault"])
    assert len(recorder.armed) == 1, "no further trial was armed"
    assert [trial["state"] for trial in result["trials"]] == [
        "failed", "not-armed", "not-armed", "not-armed"]


def test_a_host_fault_still_publishes_the_report_of_what_did_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    """The report is the evidence of the trials that finished; only the exit code says stopped."""
    first, second = "camp-01-task-one-cortex-a", "camp-01-task-one-cortex-b"
    RecordingTrialPath(default_requests=1).install(monkeypatch)
    removals: list[str] = []

    def remove(network_id: str) -> None:
        removals.append(network_id)
        if len(removals) > 1:
            raise campaign.HostFaultError("network cleanup failed")

    monkeypatch.setattr(campaign, "_remove_trial_network", remove)
    document = campaign_document(tmp_path, concurrency=2)

    status, result, _ = run_cli(
        capsys, "run", "--config", str(write_campaign(tmp_path, document)))

    assert status == 1
    report = json.loads(Path(str(result["report_path"])).read_text(encoding="utf-8"))
    reported = {
        trial["trial_id"] for trial in result["trials"]
        if trial["state"] != "not-armed"
    }
    assert set(report["run_order"]) == reported
    assert {first, second} <= reported, "successful and failed terminal trials are reported"


def test_a_campaign_whose_every_trial_failed_reports_that_instead_of_crashing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    """There is nothing to compare, and that is a result rather than a crash on the way to one."""
    plans = [
        f"camp-01-task-{task}-cortex-{arm}"
        for task in ("one", "two") for arm in ("a", "b")
    ]
    RecordingTrialPath(failures=tuple(plans)).install(monkeypatch)

    status, result, _ = run_cli(capsys, "run", "--config", str(write_campaign(tmp_path)))

    assert [trial["state"] for trial in result["trials"]] == ["failed"] * 4
    report = json.loads(Path(str(result["report_path"])).read_text(encoding="utf-8"))
    assert report["run_order"] == plans
    assert all(run["score_status"] == "unavailable" for run in report["runs"])
    # The r5 campaign exited 0 with ok true while three of three trials failed. A caller that
    # gates on the exit code would have read that as a clean benchmark run.
    assert result["ok"] is False, "a campaign that graded nothing did not succeed"
    assert status == 1
    assert result["trials_failed"] == 4
    assert result["state"] == "completed", "the driver still finished; it is the trials that failed"


def test_a_failed_trials_spend_is_still_counted_by_the_campaign(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    """Requests are counted at the proxy, so a trial that fails afterwards has still made them.

    r5 reported a total of nothing while three trials had already put provider traffic through
    their meters, because the total was summed from published envelopes and no trial published one.
    """
    failed = "camp-01-task-one-cortex-a"
    RecordingTrialPath(
        default_requests=1,
        failures=(failed,),
        spends={failed: 4, "camp-01-task-one-cortex-b": 1},
    ).install(monkeypatch)

    status, result, _ = run_cli(capsys, "run", "--config", str(write_campaign(tmp_path)))

    assert status == 1
    spent = {trial["trial_id"]: trial.get("metered_requests") for trial in result["trials"]}
    assert spent[failed] == 4, "the failed trial's metered requests are on the record"
    assert result["provider_requests"] == 7, (
        "4 metered by the failed trial + 1 published by each of the three that ran; the old "
        "total counted only the published three and would have read 3")
    assert result["provider_requests_complete"] is True


def test_a_campaign_says_so_when_it_cannot_account_for_an_armed_trials_spend(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    """An unreadable meter is reported as unknown rather than silently added as zero."""
    RecordingTrialPath(
        default_requests=1,
        failures=("camp-01-task-one-cortex-a", "camp-01-task-one-cortex-b"),
        spends={"camp-01-task-one-cortex-a": 4},
    ).install(monkeypatch)

    _, result, _ = run_cli(capsys, "run", "--config", str(write_campaign(tmp_path)))

    assert result["provider_requests"] == 6, (
        "4 metered by the failed trial + the 2 the two survivors published")
    assert result["provider_requests_complete"] is False, (
        "the second failed trial left no meter, so the total is a floor and not a sum")


def test_a_campaign_arms_every_declared_trial(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    recorder = RecordingTrialPath(default_requests=1).install(monkeypatch)

    status, result, _ = run_cli(capsys, "run", "--config", str(write_campaign(tmp_path)))

    assert status == 0
    assert len(recorder.armed) == 4
    assert result["state"] == "completed"
    assert result["provider_requests"] == 4, "one request published by each of the four trials"


@pytest.mark.parametrize(
    ("result", "fragment", "score_status"),
    [
        (RecordingResult(exception_info=RuntimeError("verifier failed")), "failed", "failed"),
        (RecordingResult(rewards=None), "verifier result", "unavailable"),
        (RecordingResult(rewards={}), "verifier rewards", "unavailable"),
        (RecordingResult(rewards={"reward": float("nan")}), "non-finite", "unavailable"),
        (RecordingResult(rewards={"reward": float("inf")}), "non-finite", "unavailable"),
    ],
)
def test_a_trial_result_without_completed_verification_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
    result: RecordingResult, fragment: str, score_status: str,
) -> None:
    """Refused for that trial, which is recorded as failed; the campaign is not the thing at
    fault, so it keeps going."""
    trial_id = "camp-01-task-one-cortex-a"
    RecordingTrialPath(results={trial_id: result}).install(monkeypatch)

    status, document, _ = run_cli(capsys, "run", "--config", str(write_campaign(tmp_path)))

    assert status == 1, "the campaign kept going, but it is short one measurement"
    assert document["state"] == "completed", "which is not the same as the driver failing"
    refused = next(
        trial for trial in document["trials"] if trial["trial_id"] == trial_id)
    assert refused["state"] == "failed"
    assert refused["outcome_state"] == "terminal-verifier-failure"
    assert refused["verifier_rewards"] is None
    assert refused["score_status"] == score_status
    assert fragment in str(refused["reason"])
    assert [trial["state"] for trial in document["trials"]].count("ran") == 3


@pytest.mark.parametrize("reward", [0.0, -1.0])
def test_a_completed_trial_accepts_and_reports_any_finite_reward(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
    reward: float,
) -> None:
    trial_id = "camp-01-task-one-cortex-a"
    RecordingTrialPath(results={
        trial_id: RecordingResult(rewards={"reward": reward, "auxiliary": 0.0}),
    }).install(monkeypatch)

    status, result, stderr = run_cli(
        capsys, "run", "--config", str(write_campaign(tmp_path)))

    assert (status, stderr) == (0, "")
    outcome = result["trials"][0]
    assert outcome["outcome_state"] == "terminal-success"
    assert outcome["verifier_rewards"] == {"reward": reward, "auxiliary": 0.0}
    assert outcome["score_status"] == "available"
    report = json.loads(Path(str(result["report_path"])).read_text(encoding="utf-8"))
    assert report["runs"][0]["verifier_rewards"] == {
        "reward": reward, "auxiliary": 0.0,
    }
    assert report["runs"][0]["score_status"] == "available"


def drop_request_count(document: dict[str, object]) -> dict[str, object]:
    del document["proxy_usage"]["requests"]
    return document


def test_a_published_envelope_without_a_request_count_is_harness_incomplete(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    RecordingTrialPath(envelope_mutation=drop_request_count).install(monkeypatch)

    status, result, _ = run_cli(capsys, "run", "--config", str(write_campaign(tmp_path)))

    assert status == 1
    assert result["trials"][0]["outcome_state"] == "harness-incomplete"
    assert "proxy_usage.requests" in result["trials"][0]["reason"]


# --- resume, idempotency and non-clobbering -----------------------------------------------------


def test_an_existing_completed_trial_root_is_skipped_and_its_requests_still_count(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    recorder = RecordingTrialPath(default_requests=1).install(monkeypatch)
    trials_dir = tmp_path / "trials"
    publish_envelope(trials_dir, "camp-01-task-one-cortex-a", "cortex-a", 7)
    marker = trials_dir / "camp-01-task-one-cortex-a" / "artifacts" / "keep-me.txt"
    marker.write_text("prior evidence", encoding="utf-8")

    status, result, _ = run_cli(capsys, "run", "--config", str(write_campaign(tmp_path)))

    assert status == 0
    assert "camp-01-task-one-cortex-a" not in recorder.armed
    assert marker.read_text(encoding="utf-8") == "prior evidence"
    assert result["trials"][0]["state"] == "skipped"
    assert result["provider_requests"] == 10, (
        "the 7 the skipped root already published + 1 from each of the three that ran")


def test_re_running_a_finished_campaign_arms_nothing_and_is_idempotent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    config_path = write_campaign(tmp_path)
    first = RecordingTrialPath(default_requests=1).install(monkeypatch)
    first_status, first_result, _ = run_cli(capsys, "run", "--config", str(config_path))
    report = Path(str(first_result["report_path"])).read_bytes()

    second = RecordingTrialPath(default_requests=9).install(monkeypatch)
    second_status, second_result, _ = run_cli(capsys, "run", "--config", str(config_path))

    assert (first_status, second_status) == (0, 0)
    assert len(first.armed) == 4 and second.armed == []
    assert [trial["state"] for trial in second_result["trials"]] == ["skipped"] * 4
    assert second_result["provider_requests"] == first_result["provider_requests"], (
        "the resumed total is read from the published envelopes, not re-armed at 9 apiece")
    assert Path(str(second_result["report_path"])).read_bytes() == report


def test_an_envelope_from_another_trial_is_not_counted_as_this_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    RecordingTrialPath().install(monkeypatch)
    trials_dir = tmp_path / "trials"
    write_envelope(
        trials_dir, "camp-01-task-one-cortex-a",
        envelope_document("camp-01-task-two-cortex-b", "cortex-b", 1))

    status = campaign.main(["run", "--config", str(write_campaign(tmp_path))])

    assert status == 1
    assert "camp-01-task-one-cortex-a" in failure_document(capsys)["error"]


def test_a_trial_whose_inner_run_failed_is_recorded_and_the_campaign_continues(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    """The change that lets a benchmark be a benchmark.

    A campaign used to end at the first trial whose agent failed, so one bad task cost every
    later task's measurement. A failed agent is now a result: it is recorded with the reason it
    failed, and the remaining trials still run.
    """
    def not_admitted(document: dict[str, object]) -> dict[str, object]:
        document["grader_admission"] = {
            "admitted": False, "reason": "inner_terminal_not_ok",
            "terminal_state": "failed", "terminal_reason": "provider_error",
        }
        return document

    recorder = RecordingTrialPath(
        default_requests=1, envelope_mutation=not_admitted).install(monkeypatch)

    status, result, _ = run_cli(capsys, "run", "--config", str(write_campaign(tmp_path)))

    assert status == 0
    assert recorder.armed == [
        "camp-01-task-one-cortex-a", "camp-01-task-one-cortex-b",
        "camp-01-task-two-cortex-a", "camp-01-task-two-cortex-b",
    ], "every later trial still ran"
    assert result["trials"][0]["grader_admission"] == {
        "admitted": False, "reason": "inner_terminal_not_ok",
        "terminal_state": "failed", "terminal_reason": "provider_error",
    }
    assert result["trials"][0]["requests"] == 1, (
        "a trial whose inner run failed still made its provider request")


def test_an_envelope_that_will_not_say_whether_it_is_gradable_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    """Non-admitted is an answer; silence is not."""
    def no_admission(document: dict[str, object]) -> dict[str, object]:
        document["grader_admission"] = {"reason": "inner_terminal_not_ok"}
        return document

    RecordingTrialPath(envelope_mutation=no_admission).install(monkeypatch)

    status, result, _ = run_cli(capsys, "run", "--config", str(write_campaign(tmp_path)))

    assert status == 1
    assert result["trials"][0]["outcome_state"] == "harness-incomplete"
    assert "grader_admission" in result["trials"][0]["reason"]


def test_a_harbor_agent_exception_keeps_its_finite_verifier_rewards(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    trial_id = "camp-01-task-one-cortex-a"
    RecordingTrialPath(results={
        trial_id: RecordingResult(
            exception_info=RuntimeError("agent failed"),
            rewards={"reward": 0.0, "auxiliary": 1.0},
        ),
    }).install(monkeypatch)

    status, result, _ = run_cli(capsys, "run", "--config", str(write_campaign(tmp_path)))

    assert status == 1
    failed = result["trials"][0]
    assert failed["state"] == "failed"
    assert failed["outcome_state"] == "terminal-agent-failure"
    assert failed["verifier_rewards"] == {"reward": 0.0, "auxiliary": 1.0}
    assert failed["score_status"] == "available"


def test_an_agent_timeout_without_rewards_is_not_mislabeled_as_a_verifier_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    class AgentTimeoutError(RuntimeError):
        pass

    trial_id = "camp-01-task-one-cortex-a"
    RecordingTrialPath(results={
        trial_id: RecordingResult(exception_info=AgentTimeoutError("timed out")),
    }).install(monkeypatch)

    status, result, _ = run_cli(capsys, "run", "--config", str(write_campaign(tmp_path)))

    assert status == 1
    assert result["trials"][0]["outcome_state"] == "terminal-agent-failure"
    assert result["trials"][0]["verifier_rewards"] is None
    assert result["trials"][0]["score_status"] == "failed"


def test_resuming_a_terminal_verifier_failure_keeps_it_failed_without_rearming(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    recorder = RecordingTrialPath().install(monkeypatch)
    trials_dir = tmp_path / "trials"
    trial_id = "camp-01-task-one-cortex-a"
    publish_envelope(trials_dir, trial_id, "cortex-a", 1)
    write_result(trials_dir, trial_id, RecordingResult(exception_info=RuntimeError("bad verifier")))
    document = campaign_document(tmp_path)
    document["tasks"] = [document["tasks"][0]]
    document["arms"] = [document["arms"][0]]
    document["comparisons"] = []

    status, result, stderr = run_cli(
        capsys, "run", "--config", str(write_campaign(tmp_path, document)))

    assert (status, stderr) == (1, "")
    assert recorder.armed == []
    assert result["trials"] == [{
        "trial_id": trial_id, "arm": "cortex-a", "task_id": "task-one",
        "state": "failed", "outcome_state": "terminal-verifier-failure",
        "requests": 1, "metered_requests": 1,
        "outer_envelope_path": str(
            trials_dir / trial_id / "artifacts" / OUTER_ENVELOPE_FILENAME),
        "grader_admission": {"admitted": True},
        "verifier_rewards": None, "score_status": "failed",
        "reason": "RuntimeError: bad verifier",
    }]
    report = json.loads(Path(str(result["report_path"])).read_text(encoding="utf-8"))
    assert report["run_order"] == [trial_id]
    assert report["runs"][0]["outcome_state"] == "terminal-verifier-failure"
    assert report["runs"][0]["score_status"] == "failed"


@pytest.mark.parametrize("untrustworthy", ["scan", "revocation", "revocation-types"])
def test_untrustworthy_security_evidence_never_exposes_a_score(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
    untrustworthy: str,
) -> None:
    def fail_security(document: dict[str, object]) -> dict[str, object]:
        if untrustworthy == "scan":
            document["leak_scan"] = {
                "ok": False, "clean": False, "matches": [{"rule": "secret"}],
                "missing_sources": [], "unclassified_files": [],
            }
        elif untrustworthy == "revocation":
            document["revocation"]["route_active"] = True
        else:
            document["revocation"]["route_active"] = 0
            document["revocation"]["active_handlers"] = False
        return document

    RecordingTrialPath(envelope_mutation=fail_security).install(monkeypatch)

    status, result, _ = run_cli(capsys, "run", "--config", str(write_campaign(tmp_path)))

    assert status == 1
    first = result["trials"][0]
    assert first["state"] == "failed"
    assert first["outcome_state"] == "security-failed"
    assert first["verifier_rewards"] is None
    assert first["score_status"] == "unavailable"
    assert first["grader_admission"] == {"admitted": False, "reason": "security_failed"}


def test_a_partial_outer_envelope_is_rejected_before_any_new_route_is_armed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    recorder = RecordingTrialPath().install(monkeypatch)
    trials_dir = tmp_path / "trials"
    trial_id = "camp-01-task-one-cortex-a"
    partial = envelope_document(trial_id, "cortex-a", 1)
    del partial["publication"]
    write_envelope(trials_dir, trial_id, partial)
    write_result(trials_dir, trial_id)

    status = campaign.main(["run", "--config", str(write_campaign(tmp_path))])

    assert status == 1
    assert "harness-incomplete" in failure_document(capsys)["error"]
    assert recorder.armed == []


def test_a_type_confused_publication_marker_is_rejected_before_arming(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    recorder = RecordingTrialPath().install(monkeypatch)
    trials_dir = tmp_path / "trials"
    trial_id = "camp-01-task-one-cortex-a"
    partial = envelope_document(trial_id, "cortex-a", 1)
    partial["publication"]["atomic"] = 1
    partial["publication"]["post_publication_reread"] = 1
    write_envelope(trials_dir, trial_id, partial)
    write_result(trials_dir, trial_id)

    status = campaign.main(["run", "--config", str(write_campaign(tmp_path))])

    assert status == 1
    assert "publication marker" in failure_document(capsys)["error"]
    assert recorder.armed == []


def test_an_existing_trial_root_without_a_published_envelope_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    recorder = RecordingTrialPath().install(monkeypatch)
    incomplete = tmp_path / "trials" / "camp-01-task-one-cortex-a"
    incomplete.mkdir(parents=True)
    (incomplete / "partial.log").write_text("half a trial", encoding="utf-8")

    status = campaign.main(["run", "--config", str(write_campaign(tmp_path))])

    error = failure_document(capsys)
    assert status == 1
    assert error["ok"] is False
    assert "camp-01-task-one-cortex-a" in error["error"]
    assert (incomplete / "partial.log").read_text(encoding="utf-8") == "half a trial"
    assert recorder.armed == [], "the refusal comes before anything is armed or spent"


def test_every_unfinished_root_is_named_in_one_refusal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    """At suite scale, learning which roots to move aside one campaign run at a time is its own
    failure: the resume decision is made for every trial before any of them is armed."""
    RecordingTrialPath().install(monkeypatch)
    unfinished = ["camp-01-task-one-cortex-b", "camp-01-task-two-cortex-a"]
    for trial_id in unfinished:
        (tmp_path / "trials" / trial_id).mkdir(parents=True)

    status = campaign.main(["run", "--config", str(write_campaign(tmp_path))])

    error = failure_document(capsys)
    assert status == 1
    assert all(trial_id in error["error"] for trial_id in unfinished)
    assert "2 trial root(s)" in error["error"]


# --- the comparison report ----------------------------------------------------------------------


def test_completion_writes_the_existing_comparison_report(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    RecordingTrialPath(default_requests=1).install(monkeypatch)

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
    RecordingTrialPath(default_requests=3).install(monkeypatch)

    _, result, _ = run_cli(capsys, "run", "--config", str(write_campaign(tmp_path)))

    report = json.loads(Path(str(result["report_path"])).read_text(encoding="utf-8"))
    envelope_path = (tmp_path / "trials" / "camp-01-task-one-cortex-a" / "artifacts"
                     / OUTER_ENVELOPE_FILENAME)
    assert report["runs"][0]["cortex_telemetry"] == {
        "trial_id": "camp-01-task-one-cortex-a",
        "root_run_id": "camp-01-task-one-cortex-a.cortex-a",
        "requests": 3, "input_tokens": 11, "output_tokens": 7,
        "outer_envelope_sha256": hashlib.sha256(envelope_path.read_bytes()).hexdigest(),
    }


def test_the_report_carries_failed_trials_instead_of_silently_dropping_them(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    failed = "camp-01-task-two-cortex-b"
    RecordingTrialPath(default_requests=6, failures=(failed,)).install(monkeypatch)

    _, result, _ = run_cli(capsys, "run", "--config", str(write_campaign(tmp_path)))

    report = json.loads(Path(str(result["report_path"])).read_text(encoding="utf-8"))
    assert report["run_order"] == [
        "camp-01-task-one-cortex-a", "camp-01-task-one-cortex-b",
        "camp-01-task-two-cortex-a", failed,
    ]
    failed_run = report["runs"][-1]
    assert failed_run["outcome_state"] == "harness-incomplete"
    assert failed_run["verifier_rewards"] is None
    assert failed_run["score_status"] == "unavailable"


def test_delivery_summary_projects_every_trial_and_sanitizes_host_values(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    agent_failed = "camp-01-task-one-cortex-b"
    harness_incomplete = "camp-01-task-two-cortex-a"
    security_failed = "camp-01-task-two-cortex-b"
    credential = "fixture-credential-value"
    private_home = "/home/private-user"

    def mutate(document: dict[str, object]) -> dict[str, object]:
        if document["identity"]["trial_id"] != security_failed:
            return document
        document["leak_scan"] = {
            "ok": False, "clean": False,
            "matches": [{"path": f"{private_home}/.secrets/token", "value": credential}],
            "missing_sources": [], "unclassified_files": [],
        }
        document["proxy_usage"]["cached_tokens"] = {
            "status": "unavailable", "reason": f"read failed at {private_home}",
        }
        document["revocation"]["diagnostic_path"] = f"{private_home}/route.json"
        return document

    recorder = RecordingTrialPath(
        failures=(harness_incomplete,), envelope_mutation=mutate,
        spends={harness_incomplete: 2},
        results={agent_failed: RecordingResult(
            exception_info=RuntimeError(f"failed under {private_home}"),
            rewards={
                "reward": 0.25,
                f"{private_home}/verifier/reward": 0.5,
                credential: 0.75,
            },
        )},
    ).install(monkeypatch)
    source = campaign_document(tmp_path)
    source["credential"]["dummy_token_ref"] = credential

    status, public_result, _ = run_cli(
        capsys, "run", "--config", str(write_campaign(tmp_path, source)))

    trials_dir = tmp_path / "trials"
    persisted_result = json.loads(
        (trials_dir / "campaign-result.json").read_text(encoding="utf-8"))
    summary_path = trials_dir / "result-summary.json"
    summary_text = summary_path.read_text(encoding="utf-8")
    summary = json.loads(summary_text)
    assert status == 1
    assert persisted_result == public_result
    assert "result_path" not in public_result and "summary_path" not in public_result
    assert (trials_dir / "comparison-report.json").is_file()
    assert summary["schema_version"] == "cortex-bench-campaign-result-summary/2"
    assert [trial["trial_id"] for trial in summary["trials"]] == [
        "camp-01-task-one-cortex-a", agent_failed, harness_incomplete, security_failed,
    ]
    assert [trial["terminal_state"] for trial in summary["trials"]] == [
        "terminal-success", "terminal-agent-failure", "harness-incomplete", "security-failed",
    ]
    assert summary["trials"][1]["verifier_rewards"] == {
        "redacted-reward-2": 0.5,
        "redacted-reward-3": 0.75,
        "reward": 0.25,
    }
    assert summary["trials"][1]["score_status"] == "available"
    assert summary["trials"][2]["counters"]["requests"] == {
        "status": "available", "value": 2,
    }
    assert summary["trials"][3]["leak_scan"] == {"ok": False, "clean": False}
    assert summary["trials"][3]["counters"]["cached_tokens"] == {
        "status": "unavailable",
    }
    assert set(summary) == {"schema_version", "campaign", "trials"}
    assert set(summary["trials"][0]) == {
        "trial_id", "task_id", "terminal_state", "score_status", "verifier_rewards",
        "counters", "leak_scan", "revocation", "cli", "model", "image_digest",
    }
    for forbidden in (str(tmp_path), private_home, "private-user", credential):
        assert forbidden not in summary_text


@pytest.mark.parametrize(("vendor_agent", "config_path"), COMMITTED_VENDOR_CONFIGS.items())
def test_committed_vendor_shapes_persist_all_three_delivery_artifacts(
    vendor_agent: str, config_path: Path, tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    source = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    source["trials_dir"] = str(tmp_path / vendor_agent / "trials")
    source["campaign"] = f"delivery-{vendor_agent}"
    config_copy = write_campaign(tmp_path, source)
    RecordingTrialPath(default_requests=1).install(monkeypatch)
    monkeypatch.setattr(campaign, "_codex_wave_preflight", lambda *_: None)

    status, result, stderr = run_cli(capsys, "run", "--config", str(config_copy))

    trials_dir = Path(source["trials_dir"])
    summary = json.loads((trials_dir / "result-summary.json").read_text(encoding="utf-8"))
    assert (status, stderr) == (0, "")
    assert json.loads((trials_dir / "campaign-result.json").read_text()) == result
    assert (trials_dir / "comparison-report.json").is_file()
    assert len(summary["trials"]) == 3
    arm = source["arms"][0]
    assert all(trial["cli"] == {
        "name": vendor_agent, "version": arm["vendor_cli_version"],
    } for trial in summary["trials"])
    assert [trial["model"] for trial in summary["trials"]] == [arm["model"]] * 3
    assert [trial["image_digest"] for trial in summary["trials"]] == [
        task["image_ref"].split("@", 1)[1] for task in source["tasks"]
    ]


# --- structured success, failure and dry run ----------------------------------------------------


def test_a_successful_campaign_returns_structured_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    RecordingTrialPath(default_requests=1).install(monkeypatch)

    status, result, stderr = run_cli(capsys, "run", "--config", str(write_campaign(tmp_path)))

    assert (status, stderr) == (0, "")
    assert result["ok"] is True
    assert result["campaign"] == "camp-01"
    assert result["state"] == "completed"
    assert result["concurrency"] == 1
    assert result["started_at"].endswith("Z") and result["ended_at"].endswith("Z")
    first = result["trials"][0]
    assert first["started_at"].endswith("Z") and first["finished_at"].endswith("Z")
    assert {key: value for key, value in first.items()
            if key not in {"started_at", "finished_at"}} == {
        "trial_id": "camp-01-task-one-cortex-a", "arm": "cortex-a", "task_id": "task-one",
        "state": "ran", "outcome_state": "terminal-success",
        "verifier_rewards": {"reward": 1.0}, "score_status": "available",
        "requests": 1, "metered_requests": 1, "slot": 0,
        "outer_envelope_path": str(
            tmp_path / "trials" / "camp-01-task-one-cortex-a" / "artifacts"
            / OUTER_ENVELOPE_FILENAME),
        "grader_admission": {"admitted": True},
    }


@pytest.mark.parametrize(("vendor_agent", "config_path"), COMMITTED_VENDOR_CONFIGS.items())
def test_a_committed_vendor_campaign_dry_run_arms_nothing(
    vendor_agent: str, config_path: Path, monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    recorder = RecordingTrialPath().install(monkeypatch)

    status, result, stderr = run_cli(
        capsys, "run", "--config", str(config_path), "--dry-run")

    assert (status, stderr) == (0, "")
    assert recorder.events == []
    assert result["dry_run"] is True
    assert len(result["trials"]) == 3
    (arm,) = load_campaign_config(config_path).arms
    assert arm["vendor_agent"] == vendor_agent
    assert arm["vendor_cli_version"]


def test_a_vendor_success_root_carries_rewards_into_the_comparison_report(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    RecordingTrialPath(default_requests=1).install(monkeypatch)
    document = campaign_document(tmp_path)
    document["arms"] = [vendor_arm_document("pure-pi")]
    document["tasks"] = [document["tasks"][0]]
    document["comparisons"] = []

    status, result, stderr = run_cli(
        capsys, "run", "--config", str(write_campaign(tmp_path, document)))

    assert (status, stderr) == (0, "")
    report = json.loads(Path(str(result["report_path"])).read_text(encoding="utf-8"))
    assert report["runs"][0]["outcome_state"] == "terminal-success"
    assert report["runs"][0]["verifier_rewards"] == {"reward": 1.0}
    assert report["runs"][0]["score_status"] == "available"
    assert report["runs"][0]["grader_admission"] == {"admitted": True}


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
    assert result["slots"] == [
        {"slot": 0, "subnet": "172.30.240.0/24", "gateway": "172.30.240.1",
         "container_ip": "172.30.240.2"},
    ], "a dry run states the addresses the campaign would use before it uses one"
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
    for index, plan in enumerate(config.trials()):
        slot = config.slot(index % config.concurrency)
        manifest = dict(config.trial_manifest(plan))
        for field in ("wheel_path", "lockfile_path", "npm_artifact_path"):
            stub = workspace / f"{plan.trial_id}-{Path(str(manifest[field])).name}"
            stub.write_bytes(b"campaign admission fixture")
            manifest[field] = str(stub)
        built = build_harbor_trial_config(
            dict(plan.arm), task_path=plan.task.path,
            trials_dir=workspace / "admitted-trials", manifest=manifest,
            trial_seed=config.trial_seed(plan), cli_version=config.cli_version,
            host_scan_policy=dict(config.host_scan_policy),
            trial_proxy=config.slot_proxy(slot),
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
    assert config.concurrency >= 1
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


# The declared request-cost / output-cap pairing proofs stood here. The pair only ever expressed
# `floor(max_cost_usd / max_request_cost_usd)` requests: the 2026-08-13 paid attempt declared
# $2.00 against $0.50 and bought exactly four before the route answered 429 budget_exhausted. That
# bound is now declared directly as `max_provider_requests`, so the two statements those tests kept
# in agreement no longer both exist, and the proxy prices nothing to pair against.


# --- the committed paid campaign ----------------------------------------------------------------


def test_the_committed_paid_campaign_declares_both_harbor_phase_timeouts() -> None:
    config = load_campaign_config(COMMITTED_PAID_CONFIG)

    assert config.timeouts == {"agent_seconds": 2100, "verifier_seconds": 1800}


def test_the_committed_paid_agent_phase_outlives_the_deadline_it_bounds() -> None:
    """What ended r4 on its first trial: an agent phase equal to the inner run's own deadline.

    A trial that uses its whole budget then has no interval in which to stop itself, publish the
    terminal marker every downstream gate reads, and be finalized. The gap has to exceed the
    terminal grace the host waits out after the marker appears.
    """
    config = load_campaign_config(COMMITTED_PAID_CONFIG)
    (arm,) = config.arms

    deadline = int(str(arm["limits"]["deadline_seconds"]))
    production_grace = SERVER_READY_TIMEOUT_SECONDS + SERVER_STOP_TIMEOUT_SECONDS
    assert config.timeouts["agent_seconds"] - deadline > production_grace


@pytest.mark.parametrize("block, message", [
    ({"agent_seconds": 0}, "positive integer"),
    ({"agent_seconds": 2100.5}, "positive integer"),
    ({"agent_seconds": "true"}, "positive integer"),
    ({"wall_clock_seconds": 1800}, "unknown"),
])
def test_a_malformed_timeouts_block_is_refused(block: dict, message: str) -> None:
    text = COMMITTED_PAID_CONFIG.read_text(encoding="utf-8").replace(
        "timeouts:\n  agent_seconds: 2100\n  verifier_seconds: 1800\n",
        "timeouts:\n" + "".join(f"  {k}: {v}\n" for k, v in block.items()))

    with pytest.raises(CampaignConfigError, match=message):
        parse_campaign_config(
            text, base_dir=COMMITTED_PAID_CONFIG.parent, source="timeouts-test")


def test_an_absent_timeouts_block_leaves_every_phase_at_its_default() -> None:
    text = COMMITTED_PAID_CONFIG.read_text(encoding="utf-8").replace(
        "timeouts:\n  agent_seconds: 2100\n  verifier_seconds: 1800\n", "")

    config = parse_campaign_config(
        text, base_dir=COMMITTED_PAID_CONFIG.parent, source="timeouts-test")

    assert config.timeouts == {}


def test_the_committed_paid_campaign_config_declares_the_approved_envelope() -> None:
    config = load_campaign_config(COMMITTED_PAID_CONFIG)
    (arm,) = config.arms
    limits = arm["limits"]

    assert config.paid is True
    assert (arm["kind"], arm["backend"], arm["provider"], arm["model"]) == (
        "cortex", "pi", "deepseek", "deepseek-v4-flash")
    assert arm["orchestration"] == {"mode": "direct", "ask_manager": False}
    assert int(limits["max_output_tokens"]) >= 32768
    assert [task.task_id for task in config.tasks] == [
        "chess-best-move", "constraints-scheduling", "db-wal-recovery"]
    assert [task.image_digest for task in config.tasks] == [
        f"sha256:{digest}" for digest in (
            "f84a499762df4e6f1171cce718628b419e58a910513f371e119740171236798b",
            "6cad45f1f79e0c178d4b23ec1c930179d7d5dba2e0bdf27900dfc29c6a1bd04c",
            "0ace05c2bcd266e4ff7b8da863667b959393404a82d981b548d41493704a335a",
        )]


def test_the_committed_paid_campaign_stays_within_every_capability_ceiling() -> None:
    config = load_campaign_config(COMMITTED_PAID_CONFIG)
    (arm,) = config.arms
    ceilings = load_capability_ceilings()[str(arm["credential_capability"])]
    declared = validate_paid_envelope(
        arm, parse_trial_proxy_spec(config.slot_proxy(config.slot(0))),
        str(arm["credential_capability"]))

    assert declared and all(value <= ceilings[field] for field, value in declared.items())


def test_the_committed_paid_campaign_declares_the_request_bound_it_was_approved_for() -> None:
    """The one statement of the trial's route cap, pinned.

    It used to be pinned twice over, because it was expressed twice: `max_provider_requests`
    beside a cost pair that independently funded `floor(max_cost_usd / max_request_cost_usd)`
    requests, with config refusals holding the two in agreement. The pair is gone and this is now
    the only place the number is written, so the ceiling check above — which only proves it is not
    too large — is no longer enough on its own to notice it changing.
    """
    (arm,) = load_campaign_config(COMMITTED_PAID_CONFIG).arms

    assert int(arm["limits"]["max_provider_requests"]) == 500


# The 2026-08-13 attempts whose roots are preserved as immutable evidence: `tb21-paid` (four
# funded requests, then `429 budget_exhausted`) and `tb21-paid-r2` (refused before admission).
PRESERVED_ATTEMPT_ROOTS = {
    "tb21-paid": Path("/var/tmp/cortex-bench/tb21-paid-2026-08-13-37cf"),
    "tb21-paid-r2": Path("/var/tmp/cortex-bench/tb21-paid-r2-2026-08-13-46b6"),
    "tb21-paid-r3": Path("/var/tmp/cortex-bench/tb21-paid-r3-2026-08-13-4e25"),
    "tb21-paid-r4": Path("/var/tmp/cortex-bench/tb21-paid-r4-2026-08-13-ebe7"),
    "tb21-paid-r5": Path("/var/tmp/cortex-bench/tb21-paid-r5-2026-08-13-d3df"),
    "tb21-paid-r6": Path("/var/tmp/cortex-bench/tb21-paid-r6-2026-08-14-90d8"),
}


def test_the_committed_paid_campaign_uses_a_fresh_identity() -> None:
    """The committed document never names a preserved attempt's identity, root or trial ids.

    Whether a root exists yet is host state, not a property of the document: the earlier
    `not config.trials_dir.exists()` assertion was falsified by the very campaign it guards, since
    any attempt materialises that directory. An existing root without a published envelope is
    refused at run time by `test_an_existing_trial_root_without_a_published_envelope_is_refused`,
    and one with an envelope is resumed rather than rewritten by
    `test_an_existing_completed_trial_root_is_skipped_and_its_requests_still_count` and
    `test_re_running_a_finished_campaign_arms_nothing_and_is_idempotent`, so this test stays true
    once the campaign has actually run.
    """
    config = load_campaign_config(COMMITTED_PAID_CONFIG)

    assert config.campaign not in PRESERVED_ATTEMPT_ROOTS
    for root in PRESERVED_ATTEMPT_ROOTS.values():
        # Neither the same root, nor a root this campaign would write inside of, nor one that
        # would contain it: preserved evidence cannot be written into or resumed from.
        assert config.trials_dir != root
        assert root not in config.trials_dir.parents
        assert config.trials_dir not in root.parents
    assert config.trials_dir.name.startswith(f"{config.campaign}-")
    assert all(plan.trial_id.startswith(f"{config.campaign}-") for plan in config.trials())
    preserved_trial_ids = {
        f"{preserved}-{task.task_id}-{arm['name']}"
        for preserved in PRESERVED_ATTEMPT_ROOTS
        for task in config.tasks for arm in config.arms
    }
    assert {plan.trial_id for plan in config.trials()}.isdisjoint(preserved_trial_ids)


def test_the_committed_paid_campaign_names_the_launch_procedure_that_supplies_its_references(
) -> None:
    """Every host reference the campaign declares is one the committed launcher resolves; a bare
    `cortex-bench run` supplies none of them, which is what refused the r2 attempt."""
    config = load_campaign_config(COMMITTED_PAID_CONFIG)
    policy = config.host_scan_policy

    declared = {str(policy["repository_checkout_environment"])}
    for field in (
        "secret_environment", "forbidden_environment", "forbidden_argv_environment",
        "host_identity_environment",
    ):
        declared.update(str(name) for name in policy[field].values())
    assert declared == {
        "CORTEX_BENCH_DEEPSEEK_CREDENTIAL", "CORTEX_BENCH_PAID_CHECKOUT",
        "CORTEX_BENCH_PAID_FORBIDDEN", "CORTEX_BENCH_PAID_FORBIDDEN_ARGV",
        "CORTEX_BENCH_PAID_IDENTITY",
    }
    assert str(config.proxy["credential_env"]) == "CORTEX_BENCH_DEEPSEEK_CREDENTIAL"
    assert LAUNCH_SCRIPT.is_file()
    assert str(LAUNCH_SCRIPT.name) in COMMITTED_PAID_CONFIG.read_text(encoding="utf-8")


def test_an_absent_network_block_leaves_the_trial_open(tmp_path: Path) -> None:
    document = campaign_document(tmp_path)
    assert "network" not in document

    config = parse_campaign_config(
        yaml.safe_dump(document), base_dir=tmp_path, source="network-test")

    assert config.network.mode == "open"
    assert not config.network.filtered


def test_a_declared_filtered_network_reaches_the_config(tmp_path: Path) -> None:
    document = campaign_document(
        tmp_path, network={"mode": "filtered", "allowlist": ["example.com"]})

    config = parse_campaign_config(
        yaml.safe_dump(document), base_dir=tmp_path, source="network-test")

    assert config.network.filtered
    assert config.network.allowlist == ("example.com",)


@pytest.mark.parametrize("block,message", [
    ({"mode": "open", "allowlist": ["example.com"]}, "enforces nothing"),
    ({"mode": "permissive"}, "mode must be one of"),
    ({"mode": "filtered", "allow": ["example.com"]}, "unknown field"),
    ({"mode": "filtered", "denylist": ["*.example.com"]}, "wildcard"),
    ({"mode": "filtered", "allowlist": ["https://example.com"]}, "allowlist is invalid"),
])
def test_a_malformed_network_block_is_refused_as_a_campaign_refusal(
    tmp_path: Path, block: dict, message: str,
) -> None:
    document = campaign_document(tmp_path, network=block)

    with pytest.raises(CampaignConfigError, match=message):
        parse_campaign_config(
            yaml.safe_dump(document), base_dir=tmp_path, source="network-test")
