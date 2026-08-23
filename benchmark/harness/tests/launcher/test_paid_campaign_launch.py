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

import base64
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
# The real checkout, which the committed artifacts were built from. A document copied into tmp_path
# derives its checkout as tmp_path, so any test planning against a moved document must name this
# explicitly -- exactly as `--checkout` exists for.
CHECKOUT_ROOT = HARNESS_ROOT.parents[1]
COMMITTED_PAID_CONFIG = CAMPAIGNS_DIR / "terminal-bench-2.1-deepseek-paid.yaml"
COMMITTED_CODEX_CONFIGS = {
    "pi": CAMPAIGNS_DIR / "terminal-bench-2.1-pi-codex-xhigh.yaml",
    "cortex": CAMPAIGNS_DIR / "terminal-bench-2.1-cortex-direct-codex-xhigh.yaml",
    "native": CAMPAIGNS_DIR / "terminal-bench-2.1-native-codex-xhigh.yaml",
}
# Never a real credential: the shape the strict loader accepts, with an unmistakable body.
FAKE_CREDENTIAL = "test-not-a-real-deepseek-credential-0123456789abcdef"
DEEPSEEK_CREDENTIAL_ENV = "CORTEX_BENCH_DEEPSEEK_CREDENTIAL"
CODEX_CREDENTIAL_ENV = "CORTEX_BENCH_CODEX_CREDENTIAL"
COMMON_REFERENCES = (
    "CORTEX_BENCH_PAID_CHECKOUT",
    "CORTEX_BENCH_PAID_FORBIDDEN",
    "CORTEX_BENCH_PAID_FORBIDDEN_ARGV",
    "CORTEX_BENCH_PAID_IDENTITY",
)
REQUIRED_REFERENCES = (DEEPSEEK_CREDENTIAL_ENV, *COMMON_REFERENCES)
CODEX_REQUIRED_REFERENCES = (CODEX_CREDENTIAL_ENV, *COMMON_REFERENCES)


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
    for name in (*REQUIRED_REFERENCES, *CODEX_REQUIRED_REFERENCES):
        monkeypatch.delenv(name, raising=False)
    return dict(os.environ)


@pytest.fixture
def hermetic_campaign(tmp_path: Path) -> Path:
    """The committed document with its trial roots moved into `tmp_path`, and nothing else changed.

    Whether the committed root exists is host state — the campaign this document describes creates
    it — so a test that plans against the real `trials_dir` reports `would-skip` the moment the
    campaign has run, which is the coupling this task removed from `test_campaign.py`. Everything
    the launcher is being proven on (the five references, the arm, the pairing, the three pinned
    tasks) is still the committed declaration; only the roots the plan is read against are local.
    The copy keeps the `<checkout>/benchmark/campaigns/` shape so the checkout literal is derived
    exactly as it is in production, and the manifest and task paths are pinned to the committed
    checkout before the move, because they resolve against the document's own directory.
    """
    import yaml

    document = yaml.safe_load(COMMITTED_PAID_CONFIG.read_text(encoding="utf-8"))
    document["manifest"] = {
        key: value if key == "lockfile_manifest_path"
        else str((COMMITTED_PAID_CONFIG.parent / value).resolve())
        for key, value in document["manifest"].items()
    }
    for task in document["tasks"]:
        task["path"] = str((COMMITTED_PAID_CONFIG.parent / task["path"]).resolve())
    document["trials_dir"] = str(tmp_path / "trials")
    campaigns = tmp_path / "benchmark" / "campaigns"
    campaigns.mkdir(parents=True)
    path = campaigns / COMMITTED_PAID_CONFIG.name
    path.write_text(yaml.safe_dump(document), encoding="utf-8")
    return path


def committed_config() -> object:
    return launcher.load_campaign_config(COMMITTED_PAID_CONFIG)


def codex_token(*, exp_seconds: int = 4_102_444_800, account_id: str = "dummy-codex-account") -> str:
    def segment(document: dict[str, object]) -> str:
        return base64.urlsafe_b64encode(
            json.dumps(document, separators=(",", ":")).encode()
        ).decode().rstrip("=")

    return ".".join((
        segment({"alg": "none", "typ": "JWT"}),
        segment({
            "https://api.openai.com/auth": {"chatgpt_account_id": account_id},
            "exp": exp_seconds,
        }),
        segment({"synthetic": True}),
    ))


FAKE_CODEX_TOKEN = codex_token()


def stage_campaign(tmp_path: Path, source_path: Path) -> Path:
    import yaml

    document = yaml.safe_load(source_path.read_text(encoding="utf-8"))
    document["manifest"] = {
        key: value if key == "lockfile_manifest_path"
        else str((source_path.parent / value).resolve())
        for key, value in document["manifest"].items()
    }
    for task in document["tasks"]:
        task["path"] = str((source_path.parent / task["path"]).resolve())
    document["trials_dir"] = str(tmp_path / "trials")
    path = tmp_path / source_path.name
    path.write_text(yaml.safe_dump(document), encoding="utf-8")
    return path


@pytest.fixture
def codex_auth(tmp_path: Path) -> Path:
    path = tmp_path / "auth.json"
    path.write_text(json.dumps({
        "tokens": {
            "id_token": "not-a-jwt-and-never-read",
            "access_token": FAKE_CODEX_TOKEN,
            "refresh_token": "not-forwarded",
        }
    }), encoding="utf-8")
    return path


def resolve(gateway: Path, **overrides: object) -> object:
    return launcher.resolve_launch_environment(
        committed_config(), gateway_path=gateway, environ=overrides.pop("environ", os.environ),
        **overrides)


# --- the five references ------------------------------------------------------------------------


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

    document = launcher.report(config, environment, "preflight", gateway, {})

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


@pytest.mark.parametrize("source_path", COMMITTED_CODEX_CONFIGS.values())
def test_codex_campaigns_load_only_tokens_access_token_and_report_only_codex_auth_origin(
    source_path: Path, gateway: Path, codex_auth: Path, clean_environment: dict[str, str],
    tmp_path: Path,
) -> None:
    config_path = stage_campaign(tmp_path, source_path)
    config = launcher.load_campaign_config(config_path)
    environment = launcher.resolve_launch_environment(
        config,
        gateway_path=gateway,
        codex_auth_path=codex_auth,
        environ=clean_environment,
        checkout=CHECKOUT_ROOT,
    )

    assert tuple(sorted(environment.values)) == tuple(sorted(CODEX_REQUIRED_REFERENCES))
    assert environment.values[CODEX_CREDENTIAL_ENV] == FAKE_CODEX_TOKEN
    assert [reference.origin for reference in environment.references if reference.secret] == [
        "codex-auth"]

    document = launcher.report(config, environment, "preflight", gateway, {})
    payload = json.dumps(document, sort_keys=True)
    assert document["credential_source"] == "codex-auth"
    assert "gateway_path" not in document
    assert str(codex_auth) not in payload
    assert FAKE_CODEX_TOKEN not in payload
    assert [entry for entry in document["references"] if entry["secret"]] == [
        {"name": CODEX_CREDENTIAL_ENV, "origin": "codex-auth", "secret": True}]


@pytest.mark.parametrize("access_token", [
    "not-a-jwt",
    codex_token(account_id=""),
    ".".join(codex_token().split(".")[:1] + [
        base64.urlsafe_b64encode(json.dumps({
            "https://api.openai.com/auth": {"chatgpt_account_id": "missing-exp"},
        }, separators=(",", ":")).encode()).decode().rstrip("="),
        codex_token().split(".")[2],
    ]),
])
def test_a_codex_auth_file_without_a_valid_access_token_is_a_launch_refusal(
    access_token: str, gateway: Path, clean_environment: dict[str, str],
    tmp_path: Path,
) -> None:
    config_path = stage_campaign(tmp_path, COMMITTED_CODEX_CONFIGS["native"])
    auth_path = tmp_path / "auth.json"
    auth_path.write_text(json.dumps({"tokens": {"access_token": access_token}}), encoding="utf-8")

    with pytest.raises(launcher.LaunchError) as error:
        launcher.resolve_launch_environment(
            launcher.load_campaign_config(config_path),
            gateway_path=gateway,
            codex_auth_path=auth_path,
            environ=clean_environment,
            checkout=CHECKOUT_ROOT,
        )

    assert "codex-auth" in str(error.value)
    assert str(auth_path) not in str(error.value)


# --- the launch itself --------------------------------------------------------------------------


def test_preflight_plans_every_declared_trial_and_arms_none(
    gateway: Path, clean_environment: dict[str, str], hermetic_campaign: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Roots of their own, so `would-arm` and "nothing was created" mean what they say.

    The document is moved but the artifacts it pins are the committed ones, so the checkout they
    are verified against has to be named rather than derived from the moved document's location.
    """
    code = launcher.main(
        ["--config", str(hermetic_campaign), "--gateway", str(gateway),
         "--checkout", str(CHECKOUT_ROOT)])

    captured = capsys.readouterr()
    document = json.loads(captured.out)
    assert (code, document["ok"], document["mode"]) == (0, True, "preflight")
    assert document["campaign"] == committed_config().campaign
    assert document["host_scan_policy_resolved"] is True
    assert [trial["state"] for trial in document["dry_run"]["trials"]] == ["would-arm"] * 3
    assert not Path(document["trials_dir"]).exists()
    assert FAKE_CREDENTIAL not in captured.out + captured.err
    assert "CORTEX_BENCH_DEEPSEEK_CREDENTIAL" not in os.environ


def test_the_committed_document_preflights_whatever_state_its_roots_are_in(
    gateway: Path, clean_environment: dict[str, str], capsys: pytest.CaptureFixture[str],
) -> None:
    """The committed document itself, asserted only on what the document decides.

    A trial's planned state is host state — `would-skip` once its root exists — so this pins the
    plan's shape and the launcher's own output, and leaves what happens to an existing root to the
    runner's refusal and resume tests. It therefore stays true before, during and after a campaign.
    """
    code = launcher.main(
        ["--config", str(COMMITTED_PAID_CONFIG), "--gateway", str(gateway)])

    captured = capsys.readouterr()
    document = json.loads(captured.out)
    assert (code, document["ok"], document["mode"]) == (0, True, "preflight")
    assert document["campaign"] == committed_config().campaign
    assert document["host_scan_policy_resolved"] is True
    assert [trial["trial_id"] for trial in document["dry_run"]["trials"]] == [
        plan.trial_id for plan in committed_config().trials()]
    assert {trial["state"] for trial in document["dry_run"]["trials"]} <= {
        "would-arm", "would-skip"}
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
    assert observed[DEEPSEEK_CREDENTIAL_ENV] == FAKE_CREDENTIAL
    assert observed["argv"] == f"run --config {COMMITTED_PAID_CONFIG}"
    assert all(name not in os.environ for name in REQUIRED_REFERENCES)
    assert FAKE_CREDENTIAL not in captured.out + captured.err
    assert json.loads(captured.err)["mode"] == "run"


def test_run_hands_a_codex_campaign_the_access_token_and_then_clears_it(
    gateway: Path, codex_auth: Path, clean_environment: dict[str, str],
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], tmp_path: Path,
) -> None:
    observed: dict[str, str] = {}
    config_path = stage_campaign(tmp_path, COMMITTED_CODEX_CONFIGS["native"])

    def recorder(argv: list[str]) -> int:
        observed.update({name: os.environ[name] for name in CODEX_REQUIRED_REFERENCES})
        observed["argv"] = " ".join(argv)
        return 0

    monkeypatch.setattr(launcher, "verify_artifacts", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(launcher.campaign, "main", recorder)

    code = launcher.main([
        "--config", str(config_path),
        "--gateway", str(gateway),
        "--codex-auth", str(codex_auth),
        "--checkout", str(CHECKOUT_ROOT),
        "--run",
    ])

    captured = capsys.readouterr()
    assert code == 0
    assert observed[CODEX_CREDENTIAL_ENV] == FAKE_CODEX_TOKEN
    assert observed["argv"] == f"run --config {config_path}"
    assert all(name not in os.environ for name in CODEX_REQUIRED_REFERENCES)
    assert FAKE_CODEX_TOKEN not in captured.out + captured.err
    assert str(codex_auth) not in captured.out + captured.err
    report = json.loads(captured.err)
    assert report["mode"] == "run"
    assert report["credential_source"] == "codex-auth"
    assert "gateway_path" not in report


# --- the artifact staleness gate ----------------------------------------------------------------
#
# The r6 campaign pinned an agent-server packed 34 hours before the fix it was meant to measure,
# ran three trials against the already-fixed bug, and recorded every artifact digest correctly on
# the way. These prove the launcher now refuses that run instead of reporting it.


@pytest.fixture
def stale_campaign(tmp_path: Path) -> Path:
    """The committed document with its artifacts copied somewhere they can be spoiled.

    The copies keep their filenames and provenance sidecars, so what each test below changes is the
    one thing it means to change and nothing else.
    """
    import yaml

    document = yaml.safe_load(COMMITTED_PAID_CONFIG.read_text(encoding="utf-8"))
    artifacts = tmp_path / "dist"
    artifacts.mkdir()
    manifest = dict(document["manifest"])
    for key in ("wheel_path", "npm_artifact_path"):
        source = (COMMITTED_PAID_CONFIG.parent / manifest[key]).resolve()
        copied = artifacts / source.name
        copied.write_bytes(source.read_bytes())
        sidecar = source.with_name(source.name + ".provenance.json")
        if sidecar.is_file():
            copied.with_name(copied.name + ".provenance.json").write_bytes(sidecar.read_bytes())
        manifest[key] = str(copied)
    manifest["lockfile_path"] = str(
        (COMMITTED_PAID_CONFIG.parent / manifest["lockfile_path"]).resolve())
    document["manifest"] = manifest
    for task in document["tasks"]:
        task["path"] = str((COMMITTED_PAID_CONFIG.parent / task["path"]).resolve())
    document["trials_dir"] = str(tmp_path / "trials")
    campaigns = tmp_path / "benchmark" / "campaigns"
    campaigns.mkdir(parents=True)
    path = campaigns / COMMITTED_PAID_CONFIG.name
    path.write_text(yaml.safe_dump(document), encoding="utf-8")
    return path


def artifact_in(campaign_path: Path, key: str) -> Path:
    return Path(str(launcher.load_campaign_config(campaign_path).manifest[key]))


def test_preflight_verifies_both_pinned_artifacts_against_the_checkout(
    gateway: Path, clean_environment: dict[str, str], capsys: pytest.CaptureFixture[str],
) -> None:
    code = launcher.main(
        ["--config", str(COMMITTED_PAID_CONFIG), "--gateway", str(gateway)])

    document = json.loads(capsys.readouterr().out)
    assert code == 0
    assert sorted(document["artifacts_verified"]) == ["npm_artifact_path", "wheel_path"]
    assert document["artifacts_verified"]["npm_artifact_path"]["scope"] == "cortex_agent_server_npm"
    assert document["artifacts_verified"]["wheel_path"]["scope"] == "cortex_bench_harness_wheel"


@pytest.mark.parametrize("key", ["wheel_path", "npm_artifact_path"])
def test_an_artifact_that_no_longer_matches_its_source_refuses_the_launch(
    key: str, gateway: Path, clean_environment: dict[str, str], stale_campaign: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Either artifact alone is enough to stop the campaign: r6 was stale in only one of them."""
    artifact = artifact_in(stale_campaign, key)
    artifact.write_bytes(artifact.read_bytes() + b"drift")

    code = launcher.main(
        ["--config", str(stale_campaign), "--gateway", str(gateway),
         "--checkout", str(CHECKOUT_ROOT)])

    captured = capsys.readouterr()
    assert (code, captured.out) == (1, "")
    refusal = json.loads(captured.err)
    assert refusal["ok"] is False
    assert key in refusal["error"]
    assert "has changed since its provenance" in refusal["error"]


@pytest.mark.parametrize("key", ["wheel_path", "npm_artifact_path"])
def test_an_artifact_with_no_provenance_record_refuses_the_launch(
    key: str, gateway: Path, clean_environment: dict[str, str], stale_campaign: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """An artifact packed by hand carries no record, and is refused rather than assumed current."""
    artifact = artifact_in(stale_campaign, key)
    artifact.with_name(artifact.name + ".provenance.json").unlink()

    code = launcher.main(
        ["--config", str(stale_campaign), "--gateway", str(gateway),
         "--checkout", str(CHECKOUT_ROOT)])

    captured = capsys.readouterr()
    assert (code, captured.out) == (1, "")
    assert "carries no provenance record" in json.loads(captured.err)["error"]


def test_a_stale_artifact_refuses_a_run_before_the_credential_is_exported(
    gateway: Path, clean_environment: dict[str, str], stale_campaign: Path,
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    """The gate is a launch refusal, not a report field: `--run` must not reach the campaign.

    Ordering is the point. A stale artifact has to stop the run while nothing is armed and no
    credential has entered this process's environment.
    """
    def unreachable(argv: list[str]) -> int:
        raise AssertionError(f"the campaign ran with a stale artifact: {argv}")

    monkeypatch.setattr(launcher.campaign, "main", unreachable)
    artifact = artifact_in(stale_campaign, "npm_artifact_path")
    artifact.with_name(artifact.name + ".provenance.json").unlink()

    code = launcher.main(
        ["--config", str(stale_campaign), "--gateway", str(gateway),
         "--checkout", str(CHECKOUT_ROOT), "--run"])

    captured = capsys.readouterr()
    assert code == 1
    assert FAKE_CREDENTIAL not in captured.out + captured.err
    assert all(name not in os.environ for name in REQUIRED_REFERENCES)
