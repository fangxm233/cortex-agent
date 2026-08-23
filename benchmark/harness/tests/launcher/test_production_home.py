# input:  committed arm bundles, hostile env, launcher facts
# output: fresh-home, residue, digest, attestation and refusal proofs
# pos:    Contract tests for the production arm materializer
# >>> If I am updated, update my header and folder CORTEX.md <<<

import base64
import dataclasses
import hashlib
import json
import stat
from pathlib import Path

import pytest

from cortex_bench_harness.scan import (
    ArtifactInventory,
    ScanPolicy,
    scan_trial_artifacts,
)
from cortex_bench_harness.launcher import (
    ProductionArmLaunchFacts,
    ProductionHomeError,
    materialize_production_home,
    production_home,
)
from cortex_bench_harness.launcher.production_arms import (
    ProductionArmBundle,
    production_arm_bundle,
)


def dummy_oauth_jwt() -> str:
    def segment(document: dict[str, object]) -> str:
        return base64.urlsafe_b64encode(
            json.dumps(document, separators=(",", ":")).encode()
        ).decode().rstrip("=")

    return ".".join((
        segment({"alg": "none", "typ": "JWT"}),
        segment({
            "https://api.openai.com/auth": {"chatgpt_account_id": "dummy-account"},
            "exp": 4_102_444_800,
        }),
        segment({"synthetic": True}),
    ))


DUMMY_OAUTH_JWT = dummy_oauth_jwt()
DIRECT_BUNDLE = production_arm_bundle("direct-pi-deepseek")
DIRECT_CODEX_BUNDLE = production_arm_bundle("direct-pi-openai-codex")
AUDIT_RETRY_BUNDLE = production_arm_bundle("coder-review-audit-retry-pi-deepseek")
MANAGER_BUNDLE = production_arm_bundle("manager-qa-off-pi-deepseek")

EXPECTED_PROFILE = {
    "defaultProfile": "benchmark-direct",
    "profiles": {"benchmark-direct": {
        "model": "deepseek-v4-flash", "backend": "pi", "mode": "trial",
        "provider": "deepseek", "thinking": "off", "maxOutputTokens": 65536,
        "fallback": [],
    }},
}
EXPECTED_SETTINGS = {
    "clientHotReloadEnabled": False, "taskDispatchMaxConcurrent": 1,
    "taskDispatchEnabled": False, "taskDispatchIntervalMs": 2147483647,
    "dispatchReconcilerEnabled": False, "taskArchiveEnabled": False,
    "taskArchiveIntervalMs": 2147483647, "storeArchiveEnabled": False,
    "memoryIndexRegenEnabled": False, "memoryIndexRegenIntervalMs": 2147483647,
    "serverUpdateDisable": True, "diskMonitor": False, "waitingSweepMs": 0,
    "eventLog": False,
}
EXPECTED_AGENT = {
    "name": "benchmark-direct",
    "description": "Single production agent for the direct benchmark arm",
    "profile": "benchmark-direct", "persistSession": False,
    "promptTemplate": "{{input}}", "directive": "file:benchmark-direct.md",
    "systemPrompt": "file:benchmark-direct.md",
    "tools": "Agent,Bash,Edit,Glob,Grep,Read,Skill,TodoWrite,WebFetch,WebSearch,Write",
    "pluginDirs": [], "mcpComposition": "none", "mcpToolAllowlist": [],
}
EXPECTED_TEMPLATE = {
    "name": "benchmark-direct",
    "description": "One production agent step with no orchestration fork",
    "agents": ["benchmark-direct"], "transitions": [],
    "entryAgent": "benchmark-direct", "maxTotalSteps": 1,
    "maxTotalCostUsd": 100, "disableHooks": True,
}
EXPECTED_CODEX_PROFILE = {
    "defaultProfile": "benchmark-direct",
    "profiles": {"benchmark-direct": {
        "model": "gpt-5.6-sol", "backend": "pi", "mode": "trial",
        "provider": "openai-codex", "thinking": "xhigh", "maxOutputTokens": 65536,
        "fallback": [],
    }},
}
EXPECTED_GATEWAY = (
    "port: 9880\nmode: trial\nstatus_check: false\nmax_body_size_mb: 64\n"
    "deepseek:\n  trial:\n"
    "    base_url: http://trial-direct-001.proxy.invalid:49152\n"
    "    auth_style: openai\n    keys:\n      - trial-dummy-token\n"
)
EXPECTED_CODEX_GATEWAY = (
    "port: 9880\nmode: trial\nstatus_check: false\nmax_body_size_mb: 64\n"
    "openai-codex:\n  trial:\n"
    "    base_url: http://trial-direct-001.proxy.invalid:49152\n"
    f"    auth_style: openai\n    keys:\n      - {DUMMY_OAUTH_JWT}\n"
)
HOSTILE_ENVIRONMENT = {
    "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
    "CORTEX_HOME": "/host/private/.cortex",
    "CORTEX_PROJECTS_DIR": "/host/private/projects", "HOME": "/host/private",
    "SLACK_BOT_TOKEN": "xoxb-host-secret", "SLACK_CHANNEL": "host-channel",
    "FEISHU_APP_ID": "host-app", "FEISHU_APP_SECRET": "host-secret",
    "LARK_VERIFICATION_TOKEN": "host-token", "ANTHROPIC_API_KEY": "sk-ant-host",
    "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
    "DEEPSEEK_API_KEY": "host-deepseek",
    "DEEPSEEK_BASE_URL": "https://api.deepseek.com",
    "OPENAI_API_KEY": "host-openai", "OPENAI_BASE_URL": "https://api.openai.com/v1",
    "MISTRAL_TOKEN": "host-mistral",
    "GOOGLE_APPLICATION_CREDENTIALS": "/host/private/google.json",
    "CLAUDE_CODE_OAUTH_TOKEN": "host-oauth",
}
# Host variables the server itself reads that name no provider: each one either redirects a
# credential or state file out of the sealed home, overrides the arm, or carries a host secret.
HOST_REDIRECT_ENVIRONMENT = {
    "PI_CODING_AGENT_DIR": "/host/private/.cortex/data/pi",
    "CLAUDE_CONFIG_DIR": "/host/private/.claude",
    "CLAUDE_CODE_MESSAGING_SOCKET": "/host/private/run/claude.sock",
    "CLAUDE_CODE_MESSAGING_TOKEN": "host-messaging-token",
    "CORTEX_BUDGET_FILE": "/host/private/.cortex/config/budget.json",
    "CORTEX_COSTS_FILE": "/host/private/.cortex/data/costs.jsonl",
    "CORTEX_EXECUTIONS_FILE": "/host/private/.cortex/data/executions.json",
    "CORTEX_PROFILE": "host-profile",
    "CORTEX_BACKEND": "claude",
    "CORTEX_MACHINE": "host-machine",
    "CORTEX_THREAD_ID": "thr-host",
    "CORTEX_WEBHOOK_TOKEN": "host-webhook-secret",
    "CORTEX_CLIENT_TOKEN": "host-client-secret",
    "CORTEX_TUI": "1",
    "CF_ACCESS_CLIENT_SECRET": "host-cf-secret",
    "GITHUB_WEBHOOK_SECRET": "host-github-secret",
}
SEALED_ENVIRONMENT_KEYS = {
    "PATH", "LANG", "CORTEX_HOME", "CORTEX_PROJECTS_DIR", "HOME",
    "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "CORTEX_CONFIG_IMMUTABLE",
    "WEBHOOK_PORT", "CORTEX_TUI", "CORTEX_TUI_PORT",
    "CORTEX_WEBHOOK_THREAD_OP_ONLY", "CORTEX_WEBHOOK_SINGLE_ROOT",
    "CORTEX_WEBHOOK_SINGLE_ROOT_TEMPLATE",
}


def canonical_sha256(value: object) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode()).hexdigest()


def tree_digest(root: Path) -> tuple[str, int]:
    entries = [
        {
            "path": path.relative_to(root).as_posix(),
            "type": "file",
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }
        for path in sorted(root.rglob("*"))
        if path.is_file()
    ]
    return canonical_sha256(entries), len(entries)


def facts(
    tmp_path: Path, bundle: ProductionArmBundle = DIRECT_BUNDLE,
) -> ProductionArmLaunchFacts:
    npm_artifact = tmp_path / "cortex-agent-server.tgz"
    npm_artifact.write_bytes(b"pinned npm artifact\n")
    return ProductionArmLaunchFacts(
        arm_bundle=bundle,
        trial_id="trial-direct-001",
        root_run_id="trial-direct-001.cortex-direct",
        npm_artifact=npm_artifact,
        backend_cli_version="0.82.1",
        proxy_base_url="http://trial-direct-001.proxy.invalid:49152",
        dummy_token_ref=(
            DUMMY_OAUTH_JWT if bundle.provider == "openai-codex" else "trial-dummy-token"
        ),
        model_alias_policy={"policy": "exact"},
    )


def materialize(
    tmp_path: Path, environment: dict[str, str] | None = None,
    bundle: ProductionArmBundle = DIRECT_BUNDLE,
):
    return materialize_production_home(
        cortex_home=tmp_path / "fresh-cortex-home",
        runtime_cortex_home=Path("/logs/agent/production-cortex-home"),
        artifacts_dir=tmp_path / "artifacts",
        facts=facts(tmp_path, bundle),
        inherited_environment=environment or {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
    )


def read_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def expected_attestation(
    launch: ProductionArmLaunchFacts, bundle_sha: str, bundle_count: int,
    home_sha: str, home_count: int,
) -> tuple[dict[str, object], str]:
    npm_sha = hashlib.sha256(launch.npm_artifact.read_bytes()).hexdigest()
    backend = {"name": "pi", "version": "0.82.1"}
    manifest = canonical_sha256({
        "npm_artifact_sha256": npm_sha, "backend_cli": backend,
        "pre_boot_input_bundle_sha256": bundle_sha,
    })
    return {
        "schema_version": "cortex-bench-launch-attestation/4",
        "trial_id": "trial-direct-001", "capture_boundary": "launcher_pre_boot",
        "arm_bundle": {
            "key": "direct-pi-deepseek", "profile_name": "benchmark-direct",
            "root_template": "benchmark-direct",
        },
        "arm_confinement": DIRECT_BUNDLE.confinement_record(),
        "npm_artifact_sha256": npm_sha, "backend_cli": backend,
        "pre_boot_input_bundle_sha256": bundle_sha,
        "input_bundle_file_count": bundle_count,
        "cortex_home_tree_sha256": home_sha, "cortex_home_file_count": home_count,
        "bundle_manifest_hash": manifest,
    }, manifest


def copy_bundle(destination: Path, symlink_target: Path | None = None) -> ProductionArmBundle:
    destination.mkdir()
    for source in DIRECT_BUNDLE.bundle_dir.rglob("*"):
        relative = source.relative_to(DIRECT_BUNDLE.bundle_dir)
        output = destination / relative
        if source.is_dir():
            output.mkdir()
        elif relative.as_posix() == "config/machines.json" and symlink_target:
            output.symlink_to(symlink_target)
        else:
            output.write_bytes(source.read_bytes())
    return dataclasses.replace(DIRECT_BUNDLE, bundle_dir=destination)


def test_committed_bundle_is_the_exact_production_direct_surface(tmp_path: Path) -> None:
    home = materialize(tmp_path).cortex_home

    assert read_json(home / "config/profiles.json") == EXPECTED_PROFILE
    assert read_json(home / "config/settings.json") == EXPECTED_SETTINGS
    agent = home / "config/thread-templates/agents/benchmark-direct.json"
    template = home / "config/thread-templates/templates/benchmark-direct.json"
    assert read_json(agent) == EXPECTED_AGENT
    assert read_json(template) == EXPECTED_TEMPLATE
    assert read_json(home / "config/machines.json") == {}
    assert read_json(home / "data/schedules.json") == {"tasks": []}
    assert read_json(home / "data/mode.json") == {
        "mode": "api", "claudeMode": "api", "backend": "pi",
        "claudeModel": "deepseek-v4-flash", "activeProfile": "benchmark-direct",
        "defaultAgent": "benchmark-direct", "channelProfiles": {},
    }
    assert (home / "context/projects/general/TASKS.yaml").read_text() == "tasks: []\n"
    # The bundle is the only copy of these prompts. `agent-server/defaults` carried a second one
    # that this test byte-compared against, but the architecture that read it (arm_resolution.py
    # and policy-compiler.ts) was removed in 6102a101 and the orphaned copy was deleted with it.
    # What remains worth asserting is that materialization carries both prompts into the home
    # with content -- an empty or missing prompt is how a trial silently runs with no directive.
    for kind in ("directives", "systemPrompts"):
        assert (home / "prompts" / kind / "benchmark-direct.md").read_bytes().strip()


def test_direct_openai_codex_bundle_seals_its_xhigh_profile(tmp_path: Path) -> None:
    home = materialize(tmp_path, bundle=DIRECT_CODEX_BUNDLE).cortex_home

    assert read_json(home / "config/profiles.json") == EXPECTED_CODEX_PROFILE
    assert read_json(home / "config/settings.json") == EXPECTED_SETTINGS
    assert read_json(home / "data/mode.json") == {
        "mode": "api", "claudeMode": "api", "backend": "pi",
        "claudeModel": "gpt-5.6-sol", "activeProfile": "benchmark-direct",
        "defaultAgent": "benchmark-direct", "channelProfiles": {},
    }


def test_declared_output_cap_is_projected_into_the_sealed_profile(tmp_path: Path) -> None:
    launch = dataclasses.replace(facts(tmp_path), max_output_tokens=256)
    result = materialize_production_home(
        cortex_home=tmp_path / "smoke-home",
        runtime_cortex_home=Path("/logs/agent/production-cortex-home"),
        artifacts_dir=tmp_path / "artifacts",
        facts=launch,
        inherited_environment={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
    )

    profile = read_json(result.cortex_home / "config/profiles.json")
    assert profile["profiles"]["benchmark-direct"]["maxOutputTokens"] == 256
    context = result.production_evidence_context
    assert context["model_execution"]["max_output_tokens"] == 256


def test_manager_qa_route_is_opened_only_for_the_qa_on_arm(tmp_path: Path) -> None:
    qa_on = production_arm_bundle("manager-qa-on-pi-deepseek")
    on_root, off_root = tmp_path / "on", tmp_path / "off"
    on_root.mkdir()
    off_root.mkdir()
    on = materialize(on_root, bundle=qa_on).process_environment
    off = materialize(off_root, bundle=MANAGER_BUNDLE).process_environment

    assert on["CORTEX_WEBHOOK_MANAGER_QA_ALLOWED"] == "1"
    assert "CORTEX_WEBHOOK_MANAGER_QA_ALLOWED" not in off


def test_materializes_without_host_home_and_scrubs_provider_and_chat_residue(tmp_path: Path) -> None:
    result = materialize(tmp_path, HOSTILE_ENVIRONMENT)
    environment = result.process_environment

    assert environment["PATH"] == "/usr/bin:/bin"
    runtime_home = Path("/logs/agent/production-cortex-home")
    assert environment["CORTEX_HOME"] == str(runtime_home)
    assert environment["CORTEX_PROJECTS_DIR"] == str(runtime_home / "context/projects")
    assert environment["HOME"] == str(runtime_home / "container-home")
    assert environment["CORTEX_TUI"] == "1"
    assert environment["WEBHOOK_PORT"] == "3001"
    assert environment["CORTEX_TUI_PORT"] == "3003"
    assert environment["CORTEX_CONFIG_IMMUTABLE"] == "1"
    assert environment["CORTEX_WEBHOOK_THREAD_OP_ONLY"] == "1"
    assert environment["CORTEX_WEBHOOK_SINGLE_ROOT"] == "1"
    auth_tokens = {result.client_token, result.webhook_token}
    assert len(auth_tokens) == 2
    assert all(len(token) == 64 and int(token, 16) >= 0 for token in auth_tokens)
    assert not auth_tokens & {"host-client-secret", "host-webhook-secret"}
    assert "CORTEX_CLIENT_TOKEN" not in environment
    assert "CORTEX_WEBHOOK_TOKEN" not in environment
    assert not (result.cortex_home / "config/.env").exists()
    assert not any(
        key.startswith((
            "SLACK_", "FEISHU_", "LARK_", "CLAUDE_CODE_OAUTH_",
            "ANTHROPIC_", "DEEPSEEK_", "OPENAI_", "MISTRAL_", "GOOGLE_",
        )) or key.endswith(("_API_KEY", "_BASE_URL")) for key in environment
    )
    assert "/host/private" not in json.dumps(environment)
    assert read_json(result.cortex_home / "data/pi/auth.json") == {
        "deepseek": {"type": "api_key", "key": "trial-dummy-token"},
    }
    gateway = (result.cortex_home / "container-home/.aistatus/gateway.yaml").read_text()
    assert gateway == EXPECTED_GATEWAY
    assert "anthropic" not in gateway.lower() and "api.deepseek.com" not in gateway


def test_openai_codex_materializes_oauth_auth_gateway_and_attested_bundle_digest(
    tmp_path: Path,
) -> None:
    result = materialize(tmp_path, HOSTILE_ENVIRONMENT, bundle=DIRECT_CODEX_BUNDLE)
    auth = {
        "openai-codex": {
            "type": "oauth", "access": DUMMY_OAUTH_JWT,
            "refresh": "dummy-refresh-never-forward", "expires": 4_102_444_800_000,
        }
    }
    bundle_sha, bundle_count = tree_digest(DIRECT_CODEX_BUNDLE.bundle_dir)
    attestation = read_json(result.launch_attestation_path)

    assert read_json(result.cortex_home / "container-home/.pi/agent/auth.json") == auth
    assert read_json(result.cortex_home / "data/pi/auth.json") == auth
    assert (result.cortex_home / "container-home/.aistatus/gateway.yaml").read_text() == (
        EXPECTED_CODEX_GATEWAY)
    assert attestation["arm_bundle"] == DIRECT_CODEX_BUNDLE.attested_record()
    assert attestation["pre_boot_input_bundle_sha256"] == bundle_sha
    assert attestation["input_bundle_file_count"] == bundle_count


def test_every_agent_of_the_arm_resolves_the_same_seeded_provider_credential(
    tmp_path: Path,
) -> None:
    """The daemon mirrors PI auth from the container HOME, once per agent spawn.

    A home that seeds only the private agent directory authenticates the first agent and no
    other: the first PI process creates an empty `$HOME/.pi/agent/auth.json`, and the next
    spawn's mirroring replaces the seeded file with a link to that empty one. A multi-agent arm
    then dies at its second role with "No API key found". Seeding the canonical location the
    mirror reads keeps every spawn resolving the one trial-scoped dummy token.
    """
    result = materialize(tmp_path)

    seeded = {"deepseek": {"type": "api_key", "key": "trial-dummy-token"}}
    assert read_json(result.cortex_home / "container-home/.pi/agent/auth.json") == seeded
    assert read_json(result.cortex_home / "data/pi/auth.json") == seeded


def test_sealed_home_paths_cannot_be_read_as_a_host_home_path(tmp_path: Path) -> None:
    """The server prints its own paths, and the leak scanner refuses any `/home/<name>`.

    A container HOME named `<CORTEX_HOME>/home` produces exactly that shape, so the production
    gateway logging its own config path was scanned as a host-identity leak and the trial was
    refused with `output_leak_detected` after a complete, correct run.
    """
    result = materialize(tmp_path)
    emitted = tmp_path / "emitted"
    emitted.mkdir()
    log = emitted / "server.log"
    log.write_text(
        "\n".join(sorted(result.process_environment.values()))
        + "\n"
        + "\n".join(
            (Path(result.process_environment["CORTEX_HOME"]) / path.relative_to(
                result.cortex_home)).as_posix()
            for path in sorted(result.cortex_home.rglob("*"))
        )
        + "\n",
        encoding="utf-8",
    )
    policy = ScanPolicy(
        secrets={"provider_credential": "synthetic-scan-credential"},
        repository_checkout="/srv/scan-checkout", hostname="scan-host",
        home_path="/home/scan-user",
    )

    report = scan_trial_artifacts(
        ArtifactInventory({"emitted": log}, frozenset({"emitted"}), (emitted,)), policy,
    )

    assert report.findings == ()


def test_seals_out_host_state_redirects_and_secrets_the_server_itself_reads(tmp_path: Path) -> None:
    hostile = {**HOSTILE_ENVIRONMENT, **HOST_REDIRECT_ENVIRONMENT}

    environment = materialize(tmp_path, hostile).process_environment

    assert set(environment) == SEALED_ENVIRONMENT_KEYS
    assert environment["PATH"] == "/usr/bin:/bin"
    assert environment["LANG"] == "C.UTF-8"
    serialized = json.dumps(environment)
    assert not any(
        marker in serialized
        for marker in ("/host/private", "host-", "xoxb-", "sk-ant", ".claude", ".pi")
    )


def test_hashes_both_trees_and_writes_exact_linked_attestation(tmp_path: Path) -> None:
    launch = facts(tmp_path)
    result = materialize_production_home(
        cortex_home=tmp_path / "fresh-cortex-home", artifacts_dir=tmp_path / "artifacts",
        facts=launch, inherited_environment={"PATH": "/usr/bin:/bin"},
    )
    bundle_sha, bundle_count = tree_digest(DIRECT_BUNDLE.bundle_dir)
    home_sha, home_count = tree_digest(result.cortex_home)
    attestation, manifest = expected_attestation(
        launch, bundle_sha, bundle_count, home_sha, home_count,
    )

    assert read_json(result.launch_attestation_path) == attestation
    assert result.production_evidence_context == {
        "schema_version": "cortex-production-benchmark-evidence-context/1",
        "trial_id": "trial-direct-001", "root_run_id": "trial-direct-001.cortex-direct",
        "bundle_manifest_hash": manifest,
        "model_execution": {
            "model_alias_policy": {"policy": "exact"}, "cli_name": "pi",
            "cli_version": "0.82.1", "max_output_tokens": 65536,
        },
    }
    assert result.bundle_manifest_hash == manifest
    assert result.launch_attestation_path.exists()


def test_materialized_inputs_are_read_only_before_result_is_returned(tmp_path: Path) -> None:
    result = materialize(tmp_path)

    for path in result.cortex_home.rglob("*"):
        if path.is_file():
            assert stat.S_IMODE(path.stat().st_mode) == 0o444, path


def test_immutable_bundle_directories_cannot_replace_attested_inputs(tmp_path: Path) -> None:
    home = materialize(tmp_path).cortex_home

    for relative in ("config", "prompts", "context", "container-home/.aistatus"):
        root = home / relative
        assert stat.S_IMODE(root.stat().st_mode) == 0o555
        assert all(
            stat.S_IMODE(path.stat().st_mode) == 0o555
            for path in root.rglob("*") if path.is_dir()
        )
    assert stat.S_IMODE((home / "data").stat().st_mode) == 0o755
    assert stat.S_IMODE((home / "container-home").stat().st_mode) == 0o755


def test_manager_home_opens_only_the_directory_its_task_store_writes(tmp_path: Path) -> None:
    """Hazard: the built-in dispatcher and `cortex-task` write `TASKS.yaml` and its in-file lock,
    which a wholly read-only `context/` tree refuses. Exactly that directory opens; the tree above
    it and every other input stay sealed.
    """
    home = materialize(tmp_path, bundle=MANAGER_BUNDLE).cortex_home

    writable = home / "context/projects/general"
    assert stat.S_IMODE(writable.stat().st_mode) == 0o755
    assert stat.S_IMODE((writable / "TASKS.yaml").stat().st_mode) == 0o644
    for sealed in ("context", "context/projects", "config", "prompts"):
        assert stat.S_IMODE((home / sealed).stat().st_mode) == 0o555
    assert all(
        stat.S_IMODE(path.stat().st_mode) == 0o444
        for path in (home / "config").rglob("*") if path.is_file()
    )


def test_thread_root_homes_keep_their_whole_context_tree_read_only(tmp_path: Path) -> None:
    home = materialize(tmp_path, bundle=AUDIT_RETRY_BUNDLE).cortex_home

    assert stat.S_IMODE((home / "context/projects/general").stat().st_mode) == 0o555
    assert stat.S_IMODE(
        (home / "context/projects/general/TASKS.yaml").stat().st_mode) == 0o444


def test_task_root_home_carries_the_attested_evidence_context_the_dispatcher_reads(
    tmp_path: Path,
) -> None:
    """A dispatched root thread is created by the daemon, not posted to the webhook, so the
    launcher's evidence context has to reach it some other way: a file in the sealed home the
    sealed environment names. A thread-root arm carries neither.
    """
    result = materialize(tmp_path, bundle=MANAGER_BUNDLE)

    context_file = result.cortex_home / "production-benchmark-evidence-context.json"
    assert read_json(context_file) == dict(result.production_evidence_context)
    assert result.process_environment[
        "CORTEX_PRODUCTION_BENCHMARK_EVIDENCE_CONTEXT_FILE"
    ] == "/logs/agent/production-cortex-home/production-benchmark-evidence-context.json"
    (tmp_path / "direct").mkdir()
    direct = materialize(tmp_path / "direct")
    assert not (direct.cortex_home / "production-benchmark-evidence-context.json").exists()
    assert "CORTEX_PRODUCTION_BENCHMARK_EVIDENCE_CONTEXT_FILE" not in direct.process_environment


def test_attestation_records_the_confinement_each_arm_needed_opened(tmp_path: Path) -> None:
    manager = read_json(materialize(tmp_path, bundle=MANAGER_BUNDLE).launch_attestation_path)
    (tmp_path / "direct").mkdir()
    direct = read_json(materialize(tmp_path / "direct").launch_attestation_path)

    assert manager["arm_confinement"] == {
        "injection": "task-root",
        "webhook_endpoints": ["POST /webhook/thread-op"],
        "writable_home_paths": ["context/projects/general"],
    }
    assert direct["arm_confinement"] == {
        "injection": "thread-root",
        "webhook_endpoints": ["POST /webhook/thread-op"],
        "writable_home_paths": [],
    }


def test_attestation_is_the_last_materialization_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    observed: dict[str, object] = {}
    writer = production_home._write_json_atomic

    def observe(path: Path, value: dict[str, object]) -> None:
        home = tmp_path / "fresh-cortex-home"
        observed["home_sha"] = tree_digest(home)[0]
        observed["all_read_only"] = all(
            stat.S_IMODE(item.stat().st_mode) == 0o444
            for item in home.rglob("*") if item.is_file()
        )
        writer(path, value)

    monkeypatch.setattr(production_home, "_write_json_atomic", observe)
    result = materialize(tmp_path)

    assert observed == {
        "home_sha": result.cortex_home_tree_sha256,
        "all_read_only": True,
    }


def test_one_bundle_byte_mutation_changes_bundle_home_and_manifest_hashes(
    tmp_path: Path,
) -> None:
    copied_bundle = tmp_path / "bundle-copy"
    copied = copy_bundle(copied_bundle)

    before = materialize_production_home(
        cortex_home=tmp_path / "home-before", artifacts_dir=tmp_path / "artifacts-before",
        facts=facts(tmp_path, copied), inherited_environment={"PATH": "/bin"},
    )
    profile = copied_bundle / "config/profiles.json"
    profile.chmod(0o644)
    profile.write_bytes(profile.read_bytes() + b"\n")
    after = materialize_production_home(
        cortex_home=tmp_path / "home-after", artifacts_dir=tmp_path / "artifacts-after",
        facts=facts(tmp_path, copied), inherited_environment={"PATH": "/bin"},
    )

    assert after.input_bundle_sha256 != before.input_bundle_sha256
    assert after.cortex_home_tree_sha256 != before.cortex_home_tree_sha256
    assert after.bundle_manifest_hash != before.bundle_manifest_hash


def test_refuses_an_existing_home_before_writing_an_attestation(tmp_path: Path) -> None:
    existing = tmp_path / "existing-home"
    existing.mkdir()

    with pytest.raises(ProductionHomeError, match="fresh CORTEX_HOME"):
        materialize_production_home(
            cortex_home=existing, artifacts_dir=tmp_path / "artifacts-existing",
            facts=facts(tmp_path), inherited_environment={},
        )
    assert not (tmp_path / "artifacts-existing").exists()


def test_refuses_a_symlinked_bundle_before_creating_the_home(tmp_path: Path) -> None:
    copied_bundle = tmp_path / "bundle-symlink"
    linked_target = tmp_path / "outside.json"
    linked_target.write_text("{}\n")
    copied = copy_bundle(copied_bundle, linked_target)

    with pytest.raises(ProductionHomeError, match="regular files"):
        materialize_production_home(
            cortex_home=tmp_path / "symlink-home", artifacts_dir=tmp_path / "artifacts-link",
            facts=facts(tmp_path, copied), inherited_environment={},
        )
    assert not (tmp_path / "symlink-home").exists()


def test_refuses_a_direct_provider_route_before_creating_the_home(tmp_path: Path) -> None:
    launch = facts(tmp_path)
    invalid = dataclasses.replace(launch, proxy_base_url="http://api.deepseek.com")

    with pytest.raises(ProductionHomeError, match="trial-scoped"):
        materialize_production_home(
            cortex_home=tmp_path / "invalid-home", artifacts_dir=tmp_path / "artifacts-invalid",
            facts=invalid, inherited_environment={},
        )
    assert not (tmp_path / "invalid-home").exists()


def test_audit_retry_arm_materializes_its_own_bundle_and_never_the_direct_one(
    tmp_path: Path,
) -> None:
    """Hazard 4's other half: the home a coder-review trial boots is that arm's bundle."""
    result = materialize(tmp_path, bundle=AUDIT_RETRY_BUNDLE)
    home = result.cortex_home

    assert result.arm_bundle is AUDIT_RETRY_BUNDLE
    assert (home / "config/thread-templates/templates/benchmark-coder-review.json").is_file()
    assert not (home / "config/thread-templates/templates/benchmark-direct.json").exists()
    assert not (home / "prompts/directives/benchmark-direct.md").exists()
    assert read_json(home / "config/profiles.json")["defaultProfile"] == "benchmark-coder-review"
    bundle_sha, bundle_count = tree_digest(AUDIT_RETRY_BUNDLE.bundle_dir)
    assert (result.input_bundle_sha256, result.input_bundle_file_count) == (
        bundle_sha, bundle_count)
    (tmp_path / "direct").mkdir()
    assert result.input_bundle_sha256 != materialize(
        tmp_path / "direct", bundle=DIRECT_BUNDLE).input_bundle_sha256


def test_attestation_and_sealed_environment_state_the_arm_that_ran(tmp_path: Path) -> None:
    """The webhook's single-root guard is widened by exactly this attested template."""
    result = materialize(tmp_path, bundle=AUDIT_RETRY_BUNDLE)

    assert result.process_environment["CORTEX_WEBHOOK_SINGLE_ROOT"] == "1"
    assert result.process_environment["CORTEX_WEBHOOK_SINGLE_ROOT_TEMPLATE"] == (
        "benchmark-coder-review")
    attestation = read_json(result.launch_attestation_path)
    assert attestation["arm_bundle"] == {
        "key": "coder-review-audit-retry-pi-deepseek",
        "profile_name": "benchmark-coder-review",
        "root_template": "benchmark-coder-review",
    }
    assert attestation["schema_version"] == "cortex-bench-launch-attestation/4"


def test_committed_bundle_files_are_read_from_the_bundle_that_ran(tmp_path: Path) -> None:
    """`committed_input_bundle_files` answers per bundle key, never for one hardcoded arm."""
    entries = production_home.committed_input_bundle_files(AUDIT_RETRY_BUNDLE.key)
    paths = tuple(entry["path"] for entry in entries)

    assert "config/thread-templates/templates/benchmark-coder-review.json" in paths
    assert not any("benchmark-direct" in path for path in paths)
    for entry in entries:
        payload = (AUDIT_RETRY_BUNDLE.bundle_dir / entry["path"]).read_bytes()
        assert entry["sha256"] == hashlib.sha256(payload).hexdigest()
    assert production_home.committed_input_bundle_files(DIRECT_BUNDLE.key) != entries
