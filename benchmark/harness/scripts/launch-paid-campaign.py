#!/usr/bin/env python3
# input:  a committed campaign document and the host gateway or Codex auth source
# output: the five resolved host-scan references, a redacted report and the campaign run
# pos:    Host-only paid campaign launch procedure
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# `cortex-bench run` reads five host references it never sets itself: the provider credential named
# by `proxy.credential_env`, and the four `host_scan_policy` references
# (`host_finalization.parse_host_scan_policy` resolves all of them while the agent is constructed,
# before the proxy is armed). The 2026-08-13 r2 attempt exported only the credential and was
# refused there in 0.7s with `host scan policy environment reference is unavailable`, after
# creating an incomplete trial root and consuming nothing. This script is the launch procedure that
# cannot make that mistake: it resolves every reference the document declares, proves the exact
# parse that refused r2 now succeeds, and only then runs the campaign in this same process.
#
# Credential hygiene, which is why the credential is not simply exported by the operator:
#   * it is read at execution time from the configured host source: DeepSeek campaigns still use
#     the strict gateway loader (`launcher.deepseek_paid_smoke.load_deepseek_relay_credential`),
#     while all-Codex campaigns read only `tokens.access_token` from the named Codex auth JSON and
#     validate it locally as a JWT; a pre-set credential variable is always a refusal, because
#     `cortex-run --env` persists whatever it is given into private run metadata;
#   * it lives only in this process's environment, is never written to argv, stdout or any file,
#     and is removed from the environment as soon as the campaign returns.
#
# Both modes also refuse a campaign whose pinned artifacts were not built from this checkout's
# current source (see `verify_artifacts`). That is the r6 gate, and it is why the build step below
# is part of the procedure rather than something an operator is trusted to remember.
#
# THE LAUNCH PROCEDURE, exactly (run on the host that owns the credential source; no `--env`
# anywhere):
#
#   cd <checkout>/benchmark/harness
#   PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 uv run --offline --frozen \
#     python scripts/build-trial-artifacts.py \
#       --config ../campaigns/terminal-bench-2.1-deepseek-paid.yaml
#   PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 uv run --offline --frozen \
#     python scripts/launch-paid-campaign.py \
#       --config ../campaigns/terminal-bench-2.1-deepseek-paid.yaml --preflight
#   PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 uv run --offline --frozen \
#     python scripts/launch-paid-campaign.py \
#       --config ../campaigns/terminal-bench-2.1-deepseek-paid.yaml --run
#
# `--preflight` is the whole procedure minus the trials: it loads the credential, resolves the five
# references, parses the scan policy, verifies both artifacts against current source and dry-runs
# the campaign, arming nothing and paying nothing.
# `--run` writes the campaign's own JSON result to stdout and this redacted report to stderr.
# Under cortex-run, wrap the `--run` line only — never pass a reference through `--env`.
#
# A paid campaign is ~40 minutes and must outlive the session that starts it: run `--run` detached
# (`setsid`/`nohup`, output to a file). The r6 attempt was launched as a child of an agent session
# and was killed at 31 minutes when that session ended.

import argparse
import json
import os
import secrets
import socket
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

HARNESS = Path(__file__).resolve().parents[1]
if str(HARNESS / "src") not in sys.path:
    sys.path.insert(0, str(HARNESS / "src"))

from cortex_bench_harness import campaign  # noqa: E402
from cortex_bench_harness.artifact_provenance import (  # noqa: E402
    NPM_SCOPE,
    WHEEL_SCOPE,
    ProvenanceError,
    verify_artifact,
)
from cortex_bench_harness.campaign_config import (  # noqa: E402
    CampaignConfig,
    CampaignConfigError,
    load_campaign_config,
)
from cortex_bench_harness.host_finalization import parse_host_scan_policy  # noqa: E402
from cortex_bench_harness.launcher.deepseek_paid_smoke import (  # noqa: E402
    load_deepseek_relay_credential,
)
from cortex_bench_harness.proxy.adapters.openai_codex_responses import (  # noqa: E402
    extract_access_expiry_ms,
    extract_account_id,
)

LAUNCH_SCHEMA_VERSION = "cortex-bench-paid-launch/1"
GATEWAY_PATH = Path("/home/fangxin/.aistatus/gateway.yaml")
CODEX_AUTH_PATH = Path("~/.codex/auth.json")
CREDENTIAL_RULE = "provider_credential"
CODEX_AUTH_ORIGIN = "codex-auth"
GATEWAY_ORIGIN = "gateway"
CODEX_CREDENTIAL_CAPABILITIES = frozenset({
    "pi-openai-codex-oauth", "codex-subscription",
})
# The generated references are leak canaries, not secrets: the scanner fails the trial if one of
# these literals reaches a published artifact, which is how host environment or argv leakage is
# detected. They are generated per launch and stay fixed for the whole campaign process.
SENTINEL_PREFIXES = {
    "CORTEX_BENCH_PAID_FORBIDDEN": "cortex-bench-paid-forbidden",
    "CORTEX_BENCH_PAID_FORBIDDEN_ARGV": "cortex-bench-paid-argv",
}
SENTINEL_ENTROPY_BYTES = 8


class LaunchError(RuntimeError):
    """The launch procedure could not be completed without weakening the paid boundary."""


@dataclass(frozen=True)
class ReferenceValue:
    name: str
    value: str
    origin: str
    secret: bool


@dataclass(frozen=True)
class LaunchEnvironment:
    credential_env: str
    credential_origin: str
    references: tuple[ReferenceValue, ...]

    @property
    def values(self) -> dict[str, str]:
        return {reference.name: reference.value for reference in self.references}

    def as_report(self) -> dict[str, object]:
        """Every reference by name and origin; the value only when it is not the credential."""
        return {
            "credential_reference": self.credential_env,
            "references": [
                {"name": reference.name, "origin": reference.origin,
                 "secret": reference.secret,
                 **({} if reference.secret else {"value": reference.value})}
                for reference in sorted(self.references, key=lambda entry: entry.name)
            ],
        }


def host_scan_reference_names(config: CampaignConfig) -> dict[str, str]:
    """The four `host_scan_policy` references, by the policy field that declares each one."""
    policy = config.host_scan_policy
    names: dict[str, str] = {}
    for field, declared in policy.items():
        if isinstance(declared, Mapping):
            for rule, name in declared.items():
                names[f"{field}.{rule}"] = str(name)
        else:
            names[field] = str(declared)
    return names


def credential_reference(config: CampaignConfig) -> str:
    """The one credential variable, which the proxy and the scan policy must agree on.

    They are two independent declarations of the same secret: the proxy reads it to arm the route,
    the scanner reads it to refuse any artifact that echoes it. A campaign that named two variables
    would arm with one and scan for the other, so the disagreement is refused here.
    """
    proxy_name = str(config.proxy["credential_env"])
    secrets_policy = config.host_scan_policy.get("secret_environment")
    if not isinstance(secrets_policy, Mapping) or CREDENTIAL_RULE not in secrets_policy:
        raise LaunchError(
            f"campaign host_scan_policy secret_environment must declare the "
            f"{CREDENTIAL_RULE!r} rule; got {sorted(secrets_policy or {})}")
    scan_name = str(secrets_policy[CREDENTIAL_RULE])
    if scan_name != proxy_name:
        raise LaunchError(
            f"campaign proxy credential_env {proxy_name!r} and host_scan_policy "
            f"secret_environment.{CREDENTIAL_RULE} {scan_name!r} name different variables: the "
            "route would be armed with one credential while the scanner looked for another")
    return proxy_name


def checkout_root(config: CampaignConfig) -> Path:
    """The checkout this campaign document belongs to, derived rather than declared."""
    source = Path(config.source).resolve()
    campaigns = source.parent
    if campaigns.name != "campaigns" or campaigns.parent.name != "benchmark":
        raise LaunchError(
            f"cannot derive the repository checkout from {source}: expected it under "
            "<checkout>/benchmark/campaigns/. Pass --checkout to name it explicitly")
    return campaigns.parent.parent


def resolve_launch_environment(
    config: CampaignConfig, *, gateway_path: Path, codex_auth_path: Path = CODEX_AUTH_PATH,
    environ: Mapping[str, str], checkout: Path | None = None,
) -> LaunchEnvironment:
    """Resolve all five references without reading the credential from the environment."""
    credential_env = credential_reference(config)
    credential_origin = _credential_origin(config)
    if environ.get(credential_env):
        raise LaunchError(
            f"{credential_env} is already set in this environment. The credential is loaded from "
            f"the {credential_origin} source at execution time and must not be inherited: "
            "passing it through cortex-run --env persists its value into private run metadata")
    credential = _credential(
        config, gateway_path=gateway_path, codex_auth_path=codex_auth_path)
    references = _reference_values(
        config, credential_env, credential_origin, credential, environ, checkout)
    _validate(references, credential_env)
    return LaunchEnvironment(
        credential_env=credential_env, credential_origin=credential_origin,
        references=tuple(references),
    )


def _reference_values(
    config: CampaignConfig, credential_env: str, credential_origin: str,
    credential: str, environ: Mapping[str, str], checkout: Path | None,
) -> list[ReferenceValue]:
    checkout_path = checkout if checkout is not None else checkout_root(config)
    derived = {
        "repository_checkout_environment": str(checkout_path),
        "host_identity_environment.machine": socket.gethostname(),
    }
    references = [ReferenceValue(
        credential_env, credential, credential_origin, True)]
    for field, name in sorted(host_scan_reference_names(config).items()):
        if name == credential_env:
            continue
        inherited = environ.get(name)
        origin = "environment" if inherited else "derived"
        value = inherited or _generated(field, name, derived)
        references.append(ReferenceValue(name, value, origin, False))
    return references


def _credential_origin(config: CampaignConfig) -> str:
    return CODEX_AUTH_ORIGIN if _uses_codex_auth(config) else GATEWAY_ORIGIN


def _uses_codex_auth(config: CampaignConfig) -> bool:
    return bool(config.arms) and all(
        str(arm["credential_capability"]) in CODEX_CREDENTIAL_CAPABILITIES
        for arm in config.arms
    )


def _credential(
    config: CampaignConfig, *, gateway_path: Path, codex_auth_path: Path,
) -> str:
    if _uses_codex_auth(config):
        return _codex_access_token(codex_auth_path)
    try:
        credential = load_deepseek_relay_credential(gateway_path)
    except (OSError, ValueError) as error:
        raise LaunchError(f"cannot load the provider credential from {gateway_path}: {error}"
                          ) from error
    if not credential.strip():
        raise LaunchError(f"the provider credential in {gateway_path} is empty")
    return credential


def _codex_access_token(auth_path: Path) -> str:
    try:
        document = json.loads(auth_path.expanduser().read_text(encoding="utf-8"))
    except OSError as error:
        raise LaunchError(
            "cannot load the provider credential from codex-auth: auth file is unreadable"
        ) from error
    except ValueError as error:
        raise LaunchError(
            "cannot load the provider credential from codex-auth: auth file is not valid JSON"
        ) from error
    if not isinstance(document, Mapping):
        raise LaunchError(
            "cannot load the provider credential from codex-auth: auth file must be a JSON object"
        )
    tokens = document.get("tokens")
    access = tokens.get("access_token") if isinstance(tokens, Mapping) else None
    if not isinstance(access, str) or not access.strip():
        raise LaunchError(
            "cannot load the provider credential from codex-auth: "
            "tokens.access_token must be non-empty text"
        )
    token = access.strip()
    try:
        extract_account_id(token)
        extract_access_expiry_ms(token)
    except ValueError as error:
        raise LaunchError(f"cannot load the provider credential from codex-auth: {error}") from error
    return token


def _generated(field: str, name: str, derived: Mapping[str, str]) -> str:
    if field in derived:
        return derived[field]
    prefix = SENTINEL_PREFIXES.get(name)
    if prefix is None:
        raise LaunchError(
            f"campaign host_scan_policy {field} names {name!r}, for which this launcher has no "
            "value: export it before launching, or add a rule for it here")
    return f"{prefix}-{secrets.token_hex(SENTINEL_ENTROPY_BYTES)}"


def _validate(references: list[ReferenceValue], credential_env: str) -> None:
    seen = {reference.name for reference in references}
    if len(seen) != len(references):
        raise LaunchError("the campaign declares one variable for two references")
    credential = next(
        reference.value for reference in references if reference.name == credential_env)
    for reference in references:
        if not reference.value or "\n" in reference.value or "\r" in reference.value:
            raise LaunchError(
                f"{reference.name} must resolve to a non-empty single-line value")
        if not reference.secret and credential in reference.value:
            raise LaunchError(
                f"{reference.name} carries the provider credential; a non-secret reference is "
                "reported and must never hold it")
    for index, argument in enumerate(sys.argv):
        if credential in argument:
            raise LaunchError(
                f"argv[{index}] carries the provider credential; it is loaded only at execution "
                "time and never passed on a command line")


def preflight(
    config: CampaignConfig, environment: LaunchEnvironment, *, environ: Mapping[str, str],
) -> None:
    """Prove the exact resolution that refused r2 now succeeds, arming nothing."""
    values = {**environ, **environment.values}
    try:
        parse_host_scan_policy(config.host_scan_policy, values)
    except ValueError as error:
        raise LaunchError(f"host scan policy is still unresolved: {error}") from error


def verify_artifacts(config: CampaignConfig, checkout: Path) -> dict[str, object]:
    """Refuse to launch artifacts that were not built from the source being launched from.

    This is the r6 gate. That campaign pinned an agent-server packed 34 hours before the fix it was
    meant to be measuring, ran three trials against the already-fixed bug, and recorded every
    artifact digest correctly while doing it -- because a digest says which bytes ran and nothing
    said whether they were the right ones.

    It is checked in both modes and before anything is armed, so `--preflight` answers "would this
    run measure my current code", which is the question an operator actually has.
    """
    checks: dict[str, object] = {}
    for key, scope in (("wheel_path", WHEEL_SCOPE), ("npm_artifact_path", NPM_SCOPE)):
        artifact = Path(str(config.manifest[key]))
        try:
            checks[key] = verify_artifact(artifact, checkout, scope)
        except ProvenanceError as error:
            raise LaunchError(
                f"{key} is not current: {error}") from error
    return checks


def report(
    config: CampaignConfig, environment: LaunchEnvironment, mode: str,
    gateway_path: Path, artifacts: Mapping[str, object],
    dry_run: Mapping[str, object] | None = None,
) -> dict[str, object]:
    document: dict[str, object] = {
        "ok": True, "schema_version": LAUNCH_SCHEMA_VERSION, "mode": mode,
        "config": config.source, "campaign": config.campaign, "paid": config.paid,
        "trials_dir": str(config.trials_dir),
        "credential_source": environment.credential_origin,
        "host_scan_policy_resolved": True,
        "artifacts_verified": dict(artifacts),
        **environment.as_report(),
    }
    if environment.credential_origin == GATEWAY_ORIGIN:
        document["gateway_path"] = str(gateway_path)
    if dry_run is not None:
        document["dry_run"] = dict(dry_run)
    return document


def launch(arguments: argparse.Namespace) -> tuple[dict[str, object], int]:
    config = load_campaign_config(arguments.config)
    gateway_path = Path(arguments.gateway)
    checkout = Path(arguments.checkout).resolve() if arguments.checkout else None
    environment = resolve_launch_environment(
        config,
        gateway_path=gateway_path,
        codex_auth_path=Path(arguments.codex_auth),
        environ=os.environ,
        checkout=checkout,
    )
    preflight(config, environment, environ=os.environ)
    artifacts = verify_artifacts(
        config, checkout if checkout is not None else checkout_root(config))
    if arguments.mode == "preflight":
        # The public dry-run, through the same CLI entry the run uses, so the procedure is proven
        # end to end without arming a trial or reading the provider.
        planned = campaign.run(
            argparse.Namespace(config=arguments.config, dry_run=True))
        return report(
            config, environment, "preflight", gateway_path, artifacts, planned), 0
    os.environ.update(environment.values)
    try:
        print(json.dumps(
            report(config, environment, "run", gateway_path, artifacts), sort_keys=True),
            file=sys.stderr)
        return {}, campaign.main(["run", "--config", arguments.config])
    finally:
        for name in environment.values:
            os.environ.pop(name, None)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="launch-paid-campaign.py",
        description=(
            "Launch a committed paid campaign from this host: load the provider credential from "
            "the gateway or Codex auth at execution time, resolve every host_scan_policy "
            "reference, and run the campaign in this process."),
        epilog=(
            "The credential value is never accepted from the environment, stdin or a flag, and "
            "never appears in argv, stdout or the emitted report."),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--config", required=True, help="Campaign YAML path")
    _add_source_arguments(parser)
    _add_mode_arguments(parser)
    parser.set_defaults(mode="preflight")
    return parser


def _add_source_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--gateway", default=str(GATEWAY_PATH),
        help="aistatus gateway file the provider credential is read from")
    parser.add_argument(
        "--codex-auth", default=str(CODEX_AUTH_PATH),
        help="Codex auth JSON the access token is read from when every arm uses Codex OAuth")
    parser.add_argument(
        "--checkout", default=None,
        help="Repository checkout literal for the scan policy; derived from --config by default")


def _add_mode_arguments(parser: argparse.ArgumentParser) -> None:
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--preflight", dest="mode", action="store_const", const="preflight",
        help="Resolve and validate every reference, then dry-run the campaign (default)")
    mode.add_argument(
        "--run", dest="mode", action="store_const", const="run",
        help="Resolve every reference and run the campaign")


def main(argv: list[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    try:
        document, code = launch(arguments)
    except (LaunchError, CampaignConfigError, campaign.CampaignError, OSError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, sort_keys=True), file=sys.stderr)
        return 1
    if document:
        print(json.dumps(document, sort_keys=True), flush=True)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
