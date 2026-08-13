# input:  the committed paid campaign, a fake gateway file and hostile launch environments
# output: reference-completeness, credential-hygiene and arms-nothing proofs for the launcher
# pos:    Paid campaign launch procedure tests
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# The launcher is proven against the committed paid document itself, because the failure it exists
# to prevent is a launch that satisfies a fixture while leaving one of the five host references
# unset — which is exactly how the r2 attempt created an incomplete trial root. The provider
# credential is always a fake read from a temporary gateway file: no test reads the host gateway,
# and every test that emits a report asserts the credential is absent from it.

import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest

from cortex_bench_harness.host_finalization import parse_host_scan_policy

HARNESS_ROOT = Path(__file__).resolve().parents[2]
LAUNCH_SCRIPT = HARNESS_ROOT / "scripts" / "launch-paid-campaign.py"
CAMPAIGNS_DIR = HARNESS_ROOT.parents[0] / "campaigns"
COMMITTED_PAID_CONFIG = CAMPAIGNS_DIR / "terminal-bench-2.1-deepseek-paid.yaml"
# Never a real credential: the shape the strict loader accepts, with an unmistakable body.
FAKE_CREDENTIAL = "test-not-a-real-deepseek-credential-0123456789abcdef"
REQUIRED_REFERENCES = (
    "CORTEX_BENCH_DEEPSEEK_CREDENTIAL",
    "CORTEX_BENCH_PAID_CHECKOUT",
    "CORTEX_BENCH_PAID_FORBIDDEN",
    "CORTEX_BENCH_PAID_FORBIDDEN_ARGV",
    "CORTEX_BENCH_PAID_IDENTITY",
)


def load_launcher() -> object:
    spec = importlib.util.spec_from_file_location("paid_campaign_launch", LAUNCH_SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


launcher = load_launcher()


@pytest.fixture
def gateway(tmp_path: Path) -> Path:
    path = tmp_path / "gateway.yaml"
    path.write_text(
        f"deepseek:\n  deepseek:\n    keys:\n      - {FAKE_CREDENTIAL}\n", encoding="utf-8")
    return path


@pytest.fixture
def clean_environment(monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    for name in REQUIRED_REFERENCES:
        monkeypatch.delenv(name, raising=False)
    return dict(os.environ)


def committed_config() -> object:
    return launcher.load_campaign_config(COMMITTED_PAID_CONFIG)


def resolve(gateway: Path, **overrides: object) -> object:
    return launcher.resolve_launch_environment(
        committed_config(), gateway_path=gateway, environ=overrides.pop("environ", os.environ),
        **overrides)


# --- the five references ------------------------------------------------------------------------


def test_the_committed_campaign_declares_exactly_the_five_documented_references() -> None:
    config = committed_config()

    declared = launcher.host_scan_reference_names(config)

    assert declared == {
        "secret_environment.provider_credential": "CORTEX_BENCH_DEEPSEEK_CREDENTIAL",
        "forbidden_environment.host_forbidden": "CORTEX_BENCH_PAID_FORBIDDEN",
        "forbidden_argv_environment.host_argv": "CORTEX_BENCH_PAID_FORBIDDEN_ARGV",
        "repository_checkout_environment": "CORTEX_BENCH_PAID_CHECKOUT",
        "host_identity_environment.machine": "CORTEX_BENCH_PAID_IDENTITY",
    }
    assert launcher.credential_reference(config) == "CORTEX_BENCH_DEEPSEEK_CREDENTIAL"


def test_the_launcher_resolves_every_reference_the_campaign_declares(
    gateway: Path, clean_environment: dict[str, str],
) -> None:
    environment = resolve(gateway)

    assert tuple(sorted(environment.values)) == REQUIRED_REFERENCES
    assert all(value and "\n" not in value for value in environment.values.values())


def test_the_resolved_environment_satisfies_the_parse_that_refused_the_r2_attempt(
    gateway: Path, clean_environment: dict[str, str],
) -> None:
    """The refusal r2 hit is `parse_host_scan_policy`; the launcher is proven against it."""
    config = committed_config()
    environment = resolve(gateway)

    policy = parse_host_scan_policy(
        config.host_scan_policy, {**clean_environment, **environment.values})

    assert policy.secrets == {"provider_credential": FAKE_CREDENTIAL}
    assert policy.repository_checkout == str(launcher.checkout_root(config))
    assert set(policy.forbidden_environment) == {"host_forbidden"}
    assert set(policy.forbidden_argv) == {"host_argv"}
    assert set(policy.host_identities) == {"machine"}


def test_supplying_only_the_credential_still_reproduces_the_r2_refusal(
    clean_environment: dict[str, str],
) -> None:
    """The r2 launch, restated: four missing references, refused before anything is armed."""
    config = committed_config()

    with pytest.raises(ValueError) as error:
        parse_host_scan_policy(
            config.host_scan_policy,
            {**clean_environment, "CORTEX_BENCH_DEEPSEEK_CREDENTIAL": FAKE_CREDENTIAL})

    assert str(error.value) == "host scan policy environment reference is unavailable"


def test_an_already_exported_reference_is_reused_rather_than_regenerated(
    gateway: Path, clean_environment: dict[str, str], monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CORTEX_BENCH_PAID_FORBIDDEN", "operator-chosen-sentinel")

    environment = resolve(gateway)

    origins = {
        reference.name: reference.origin for reference in environment.references}
    assert environment.values["CORTEX_BENCH_PAID_FORBIDDEN"] == "operator-chosen-sentinel"
    assert origins["CORTEX_BENCH_PAID_FORBIDDEN"] == "environment"
    assert origins["CORTEX_BENCH_PAID_IDENTITY"] == "derived"


def test_each_launch_generates_its_own_leak_canaries(
    gateway: Path, clean_environment: dict[str, str],
) -> None:
    first = resolve(gateway).values
    second = resolve(gateway).values

    for name in ("CORTEX_BENCH_PAID_FORBIDDEN", "CORTEX_BENCH_PAID_FORBIDDEN_ARGV"):
        assert first[name] != second[name]
        assert FAKE_CREDENTIAL not in first[name]
    assert first["CORTEX_BENCH_PAID_CHECKOUT"] == second["CORTEX_BENCH_PAID_CHECKOUT"]
    assert first["CORTEX_BENCH_PAID_IDENTITY"] == second["CORTEX_BENCH_PAID_IDENTITY"]


# --- credential hygiene -------------------------------------------------------------------------


def test_the_credential_comes_from_the_gateway_through_the_strict_loader(
    gateway: Path, clean_environment: dict[str, str],
) -> None:
    environment = resolve(gateway)

    assert environment.values["CORTEX_BENCH_DEEPSEEK_CREDENTIAL"] == FAKE_CREDENTIAL
    assert [reference.origin for reference in environment.references
            if reference.secret] == ["gateway"]


@pytest.mark.parametrize("document", [
    "deepseek:\n  deepseek:\n    keys: []\n",
    "deepseek:\n  deepseek:\n    keys:\n      - one\n      - two\n",
    "deepseek:\n  deepseek:\n    keys:\n      - ''\n",
    "deepseek: {}\n",
])
def test_a_gateway_the_strict_loader_refuses_is_a_launch_refusal(
    tmp_path: Path, clean_environment: dict[str, str], document: str,
) -> None:
    path = tmp_path / "broken.yaml"
    path.write_text(document, encoding="utf-8")

    with pytest.raises(launcher.LaunchError) as error:
        resolve(path)

    assert "cannot load the provider credential" in str(error.value)


def test_a_missing_gateway_file_is_a_launch_refusal(
    tmp_path: Path, clean_environment: dict[str, str],
) -> None:
    with pytest.raises(launcher.LaunchError):
        resolve(tmp_path / "absent.yaml")


def test_an_inherited_credential_variable_is_refused(
    gateway: Path, clean_environment: dict[str, str], monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`cortex-run --env` persists whatever it is given, so an inherited value is never used."""
    monkeypatch.setenv("CORTEX_BENCH_DEEPSEEK_CREDENTIAL", "inherited-value")

    with pytest.raises(launcher.LaunchError) as error:
        resolve(gateway)

    assert "cortex-run --env" in str(error.value)


def test_a_credential_that_reached_argv_is_refused(
    gateway: Path, clean_environment: dict[str, str], monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sys, "argv", ["launch-paid-campaign.py", f"--x={FAKE_CREDENTIAL}"])

    with pytest.raises(launcher.LaunchError) as error:
        resolve(gateway)

    assert "argv[1]" in str(error.value)


def test_a_non_secret_reference_holding_the_credential_is_refused(
    gateway: Path, clean_environment: dict[str, str], monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CORTEX_BENCH_PAID_FORBIDDEN", FAKE_CREDENTIAL)

    with pytest.raises(launcher.LaunchError) as error:
        resolve(gateway)

    assert "carries the provider credential" in str(error.value)


def test_the_emitted_report_names_every_reference_and_carries_no_credential(
    gateway: Path, clean_environment: dict[str, str],
) -> None:
    config = committed_config()
    environment = resolve(gateway)

    document = launcher.report(config, environment, "preflight", gateway)

    payload = json.dumps(document, sort_keys=True)
    assert FAKE_CREDENTIAL not in payload
    assert [entry["name"] for entry in document["references"]] == sorted(REQUIRED_REFERENCES)
    assert [entry for entry in document["references"] if entry["secret"]] == [
        {"name": "CORTEX_BENCH_DEEPSEEK_CREDENTIAL", "origin": "gateway", "secret": True}]


def test_a_campaign_whose_proxy_and_scan_credential_disagree_is_refused(
    tmp_path: Path,
) -> None:
    import yaml

    document = yaml.safe_load(COMMITTED_PAID_CONFIG.read_text(encoding="utf-8"))
    document["proxy"]["credential_env"] = "CORTEX_BENCH_OTHER_CREDENTIAL"
    path = tmp_path / "campaign.yaml"
    path.write_text(yaml.safe_dump(document), encoding="utf-8")

    with pytest.raises(launcher.LaunchError) as error:
        launcher.credential_reference(launcher.load_campaign_config(path))

    assert "name different variables" in str(error.value)


# --- the launch itself --------------------------------------------------------------------------


def test_preflight_plans_every_declared_trial_and_arms_none(
    gateway: Path, clean_environment: dict[str, str], capsys: pytest.CaptureFixture[str],
) -> None:
    code = launcher.main(
        ["--config", str(COMMITTED_PAID_CONFIG), "--gateway", str(gateway)])

    captured = capsys.readouterr()
    document = json.loads(captured.out)
    assert (code, document["ok"], document["mode"]) == (0, True, "preflight")
    assert document["campaign"] == committed_config().campaign
    assert document["host_scan_policy_resolved"] is True
    assert [trial["state"] for trial in document["dry_run"]["trials"]] == ["would-arm"] * 3
    assert not Path(document["trials_dir"]).exists()
    assert FAKE_CREDENTIAL not in captured.out + captured.err
    assert "CORTEX_BENCH_DEEPSEEK_CREDENTIAL" not in os.environ


def test_preflight_refuses_structurally_when_a_reference_cannot_be_resolved(
    tmp_path: Path, clean_environment: dict[str, str], capsys: pytest.CaptureFixture[str],
) -> None:
    code = launcher.main(
        ["--config", str(COMMITTED_PAID_CONFIG), "--gateway", str(tmp_path / "absent.yaml")])

    captured = capsys.readouterr()
    assert (code, captured.out) == (1, "")
    assert json.loads(captured.err)["ok"] is False


def test_run_hands_the_campaign_every_reference_and_then_clears_them(
    gateway: Path, clean_environment: dict[str, str], monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The credential reaches the campaign only through this process's own environment."""
    observed: dict[str, str] = {}

    def recorder(argv: list[str]) -> int:
        observed.update({name: os.environ[name] for name in REQUIRED_REFERENCES})
        observed["argv"] = " ".join(argv)
        return 0

    monkeypatch.setattr(launcher.campaign, "main", recorder)

    code = launcher.main(
        ["--config", str(COMMITTED_PAID_CONFIG), "--gateway", str(gateway), "--run"])

    captured = capsys.readouterr()
    assert code == 0
    assert observed["CORTEX_BENCH_DEEPSEEK_CREDENTIAL"] == FAKE_CREDENTIAL
    assert observed["argv"] == f"run --config {COMMITTED_PAID_CONFIG}"
    assert all(name not in os.environ for name in REQUIRED_REFERENCES)
    assert FAKE_CREDENTIAL not in captured.out + captured.err
    assert json.loads(captured.err)["mode"] == "run"
