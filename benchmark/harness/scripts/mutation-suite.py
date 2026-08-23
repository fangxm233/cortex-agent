#!/usr/bin/env python3
# input:  DeepSeek adapter, proxy, evidence, sealed profile and spawn cap
# output: regenerated mutation manifest and offline capability evidence
# pos:    Capability mutation suite runner
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# One mutation is one named weakening of a mechanism the capability rests on. It is killed when the
# scoped test that names the property FAILS with it applied and PASSES without it; a mutation that
# survives is a gap in the suite, never a passing row, so this script refuses to write evidence
# unless every listed mutation is killed.
#
# The manifest records the commit the suite ran against, so the tree must be clean: the mutated
# files are the committed ones plus exactly the edits listed here.

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

HARNESS = Path(__file__).resolve().parents[1]
ROOT = HARNESS.parents[1]
AGENT_SERVER = ROOT / "agent-server"
EVIDENCE = HARNESS / "src/cortex_bench_harness/launcher/evidence"
MANIFEST_PATH = EVIDENCE / "pi-deepseek-api-key.mutation-manifest.json"
OFFLINE_PATH = EVIDENCE / "pi-deepseek-api-key.offline-contract-passed.json"
MANIFEST_SCHEMA_VERSION = "cortex-bench-mutation-manifest/1"

PROXY = "benchmark/harness/src/cortex_bench_harness/proxy"
LAUNCHER = "benchmark/harness/src/cortex_bench_harness/launcher"
DEEPSEEK = f"{PROXY}/adapters/deepseek_chat_completions.py"
SERVER = f"{PROXY}/server.py"
EVIDENCE_MODULE = f"{LAUNCHER}/capability_evidence.py"
PRODUCTION_HOME = f"{LAUNCHER}/production_home.py"
SPAWN_CONFIG = "agent-server/src/domain/agents/spawn-config.ts"
ADAPTER_TESTS = "tests/proxy/test_deepseek_adapter.py"

ROUTE_GUARD = "        if target.path not in CHAT_COMPLETIONS_PATHS or target.query:"
ACCOUNTED = (
    "        stream.done and not stream.malformed and not stream.data_after_done\n"
    "        and models == {frozen_model} and valid_usage"
)
# (name, file, [(find, replace)], test_file, test_selector)
MUTATIONS: tuple[tuple[str, str, list[tuple[str, str]], str, str], ...] = (
    # --- adapter selection ---
    ("selection", f"{PROXY}/adapters/__init__.py", [(
        '    ("pi", "deepseek", "openai-completions", "api-key", PROXY_SCHEMA_VERSION):\n'
        '        DeepSeekChatCompletionsApiKeyAdapter,',
        '    ("pi", "deepseek", "openai-completions", "api-key", PROXY_SCHEMA_VERSION):\n'
        '        AnthropicMessagesApiKeyAdapter,',
    )], "tests/proxy/test_adapter_selection.py", "selects_the_exact_deepseek"),
    # --- route admission ---
    ("route_path", DEEPSEEK, [(ROUTE_GUARD, "        if target.query:")],
     ADAPTER_TESTS, "admits_only_exact"),
    ("route_method", DEEPSEEK, [(
        '        if method != "POST":', '        if method not in ("POST", "GET"):',
    )], ADAPTER_TESTS, "admits_only_exact"),
    ("route_query", DEEPSEEK, [(
        ROUTE_GUARD, "        if target.path not in CHAT_COMPLETIONS_PATHS:",
    )], ADAPTER_TESTS, "admits_only_exact"),
    # --- request body policy ---
    ("model", DEEPSEEK, [(
        "        if model != self._frozen_model:", "        if model is None:",
    )], ADAPTER_TESTS, "rejects_model_stream"),
    ("stream", DEEPSEEK, [(
        '        if document.get("stream") is not True:',
        '        if document.get("stream") is None:',
    )], ADAPTER_TESTS, "rejects_model_stream"),
    ("stream_usage", DEEPSEEK, [(
        '        if not isinstance(options, dict) or options.get("include_usage") is not True:',
        "        if not isinstance(options, dict):",
    )], ADAPTER_TESTS, "rejects_model_stream"),
    ("cap_alias", DEEPSEEK, [(
        'COMPLETION_CAP_FIELDS = ("max_completion_tokens", "max_tokens")',
        'COMPLETION_CAP_FIELDS = ("max_completion_tokens",)',
    )], ADAPTER_TESTS, "admits_either_name"),
    ("cap_conflict", DEEPSEEK, [(
        "    if len(fields) != 1:", "    if not fields:",
    )], ADAPTER_TESTS, "rejects_model_stream"),
    ("cap_value", DEEPSEEK, [(
        "    if not _token(declared) or declared != frozen_completion_cap:", "    if False:",
    )], ADAPTER_TESTS, "rejects_model_stream"),
    ("cap_unfrozen", DEEPSEEK, [(
        '    if frozen_completion_cap is None:\n'
        '        return "request_completion_cap_unfrozen"',
        '    if False:\n'
        '        return "request_completion_cap_unfrozen"',
    )], ADAPTER_TESTS, "no_completion_cap_is_frozen"),
    # --- credential injection ---
    ("auth_injection", DEEPSEEK, [(
        '        outbound["authorization"] = f"Bearer {self._credential}"',
        "        pass",
    )], ADAPTER_TESTS, "injects_only_allowlisted"),
    ("header_allowlist", DEEPSEEK, [(
        "            if key.lower() in FORWARDED_HEADERS", "            if True"
    )], ADAPTER_TESTS, "injects_only_allowlisted"),
    ("bearer_header", DEEPSEEK, [(
        '        outbound["authorization"] = f"Bearer {self._credential}"',
        '        outbound["authorization"] = self._credential',
    )], ADAPTER_TESTS, "injects_only_allowlisted"),
    # --- usage accounting ---
    ("usage_content_type", DEEPSEEK, [(
        '        if "text/event-stream" not in content_type:',
        '        if "text/event-stream" in content_type:',
    )], ADAPTER_TESTS, "extracts_one_terminal"),
    ("usage_done", DEEPSEEK, [(
        ACCOUNTED, ACCOUNTED.replace("stream.done and ", ""),
    )], ADAPTER_TESTS, "partial_duplicate"),
    ("usage_model", DEEPSEEK, [(
        ACCOUNTED, ACCOUNTED.replace("models == {frozen_model}", "bool(models)"),
    )], ADAPTER_TESTS, "partial_duplicate"),
    ("usage_count", DEEPSEEK, [
        ("        if len(usages) != 1:", "        if not usages:"),
        ("    valid_usage = len(usages) == 1 and min(usages[0][0], usages[0][1]) >= 0",
         "    valid_usage = bool(usages) and min(usages[0][0], usages[0][1]) >= 0"),
    ], ADAPTER_TESTS, "partial_duplicate"),
    ("usage_token_type", DEEPSEEK, [(
        "    return isinstance(value, int) and not isinstance(value, bool) and value >= 0",
        "    return isinstance(value, int) and value >= 0",
    )], ADAPTER_TESTS, "invalid_tokens"),
    ("usage_malformed", DEEPSEEK, [(
        ACCOUNTED, ACCOUNTED.replace("not stream.malformed and ", ""),
    )], ADAPTER_TESTS, "invalid_tokens"),
    ("usage_after_done", DEEPSEEK, [(
        ACCOUNTED, ACCOUNTED.replace(" and not stream.data_after_done", ""),
    )], ADAPTER_TESTS, "invalid_tokens"),
    # --- declared byte envelope ---
    ("request_bytes", SERVER, [(
        "        if limit is not None and length > limit:", "        if False:",
    )], ADAPTER_TESTS, "declared_request_over"),
    ("response_bytes", f"{PROXY}/upstream.py", [(
        "        if limit is not None and total > limit:", "        if False:",
    )], ADAPTER_TESTS, "oversized_response"),
    # --- request count, deadline, upstream and revocation ---
    ("request_reservation", SERVER, [(
        "        if self.reserved_requests >= self.limits.max_requests:",
        "        if False:",
    )], "tests/proxy/test_proxy.py", "after_the_request_count_is_consumed"),
    # The whole refusal, not one of its two readings: the lease timer and the clock comparison are
    # each sufficient, so a mutation of either alone survives this test by design.
    ("deadline", SERVER, [(
        "        if self.deadline_expired():\n            return 410, \"deadline_expired\"",
        '        if False:\n            return 410, "deadline_expired"',
    )], "tests/proxy/test_proxy.py", "after_absolute_deadline"),
    ("upstream_host", SERVER, [(
        "    if host not in adapter.upstream_hosts:", "    if False:",
    )], "tests/proxy/test_adapter_seam.py", "refuses_to_start_for_an_upstream"),
    ("revocation_overflow", SERVER, [(
        '        if failure.reason == "upstream_response_too_large":',
        '        if failure.reason == "never_matched":',
    )], ADAPTER_TESTS, "oversized_response"),
    ("credential_clear", SERVER, [(
        "        self._server.upstream.clear_credential()", "        pass",
    )], ADAPTER_TESTS, "stop_clears"),
    # --- arming ---
    ("cap_key_binding", f"{LAUNCHER}/trial_proxy.py", [(
        "    if runner != key.runner_or_backend or provider != key.provider:",
        "    if False:",
    )], "tests/launcher/test_trial_proxy_wiring.py", "provider_drift"),
    ("paid_envelope_ceiling", f"{LAUNCHER}/trial_proxy.py", [(
        "        if value > ceiling:", "        if False:",
    )], "tests/launcher/test_trial_proxy_wiring.py", "above_its_ceiling"),
    # --- the run record that now carries the declared numbers ---
    ("manifest_body_limits", f"{PROXY}/models.py", [(
        '            "request_body_limit_bytes": self.request_body_limit_bytes,\n'
        '            "response_body_limit_bytes": self.response_body_limit_bytes,\n',
        "",
    )], "tests/proxy/test_proxy_manifest.py", "fills_h3_proxy_block"),
    # --- promotion evidence ---
    ("evidence_frozen_contract", EVIDENCE_MODULE, [(
        "        if document.get(field) != expected:", "        if False:",
    )], "tests/launcher/test_capability_evidence.py", "exact_runtime_contract"),
    ("evidence_numeric_envelope", EVIDENCE_MODULE, [(
        "    if set(document) != expected_fields:",
        '    if set(document) - {"max_output_tokens", "request_limit_bytes", '
        '"response_limit_bytes"} != expected_fields:',
    )], "tests/launcher/test_capability_evidence.py", "carrying_a_declared_envelope_number"),
    ("evidence_manifest_counts", EVIDENCE_MODULE, [(
        '    if len(mutations) != document["mutations_total"]:', "    if False:",
    )], "tests/launcher/test_capability_evidence.py", "counts_kills_or_binding"),
    ("evidence_manifest_kills", EVIDENCE_MODULE, [(
        '    if mutation["killed"] is not True:', "    if False:",
    )], "tests/launcher/test_capability_evidence.py", "counts_kills_or_binding"),
    # --- the current two-step projection of the declared cap ---
    ("pi_cap_declared", PRODUCTION_HOME, [(
        '    profile["maxOutputTokens"] = max_output_tokens',
        '    profile["maxOutputTokens"] = max_output_tokens + 1',
    )], "tests/launcher/test_production_home.py",
     "declared_output_cap_is_projected_into_the_sealed_profile"),
    ("pi_cap_projection", SPAWN_CONFIG, [(
        "    piModelMaxTokens: config.backend === 'pi' "
        "? config.maxOutputTokens ?? undefined : undefined,",
        "    piModelMaxTokens: undefined,",
    )], "tests/domain/agents/profile-thinking.test.ts",
     "PI maxOutputTokens is validated and propagated into the resolved spawn"),
)


def run_test(test_file: str, selector: str) -> int:
    if test_file.endswith(".ts"):
        command = ["npx", "vitest", "run", test_file, "-t", selector]
        cwd = AGENT_SERVER
    else:
        command = [
            "uv", "run", "--offline", "pytest", test_file, "-k", selector,
            "-p", "no:randomly", "-q",
        ]
        cwd = HARNESS
    environment = {key: value for key, value in os.environ.items() if key != "PYTHONPATH"}
    return subprocess.run(  # noqa: S603
        command, cwd=cwd, env=environment, capture_output=True, text=True,
    ).returncode


def apply_edits(path: Path, edits: list[tuple[str, str]]) -> str:
    text = original = path.read_text(encoding="utf-8")
    for find, replace in edits:
        if text.count(find) != 1:
            raise SystemExit(f"{path}: mutation anchor is not unique ({text.count(find)} matches)")
        text = text.replace(find, replace)
    if text == original:
        raise SystemExit(f"{path}: mutation changed nothing")
    path.write_text(text, encoding="utf-8")
    return text


def mutate(index: int, mutation) -> dict[str, object]:
    name, relative, edits, test_file, selector = mutation
    path = ROOT / relative
    restore = path.read_text(encoding="utf-8")
    try:
        mutated = apply_edits(path, edits)
        return_code = run_test(test_file, selector)
    finally:
        path.write_text(restore, encoding="utf-8")
    return {
        "id": index,
        "name": name,
        "file": relative,
        "test_file": test_file,
        "test_selector": selector,
        "mutation_sha256": hashlib.sha256(mutated.encode("utf-8")).hexdigest(),
        "killed": return_code != 0,
        "return_code": return_code,
    }


def implementation_commit() -> str:
    dirty = subprocess.run(  # noqa: S603
        ["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()
    if dirty:
        raise SystemExit(
            "the tree must be clean: the manifest records the commit the suite ran against\n"
            + dirty)
    return subprocess.run(  # noqa: S603
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()


def baselines() -> None:
    """Every named test must pass unmutated, or a 'kill' would prove nothing."""
    for test_file, selector in sorted({(row[3], row[4]) for row in MUTATIONS}):
        code = run_test(test_file, selector)
        print(f"baseline {'ok ' if code == 0 else 'FAIL'} {test_file} -k {selector}")
        if code != 0:
            raise SystemExit(f"baseline failed: {test_file} -k {selector}")


def write_json(path: Path, document: dict[str, object]) -> str:
    payload = json.dumps(document, sort_keys=True, separators=(",", ":")).encode()
    path.write_bytes(payload)
    return hashlib.sha256(payload).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--write", action="store_true",
        help="rewrite the committed mutation manifest and offline evidence",
    )
    arguments = parser.parse_args()
    commit = implementation_commit()
    baselines()
    mutations = [mutate(index, row) for index, row in enumerate(MUTATIONS, start=1)]
    for mutation in mutations:
        print(f"{mutation['id']:>3} {'killed  ' if mutation['killed'] else 'SURVIVED'} "
              f"{mutation['name']} (rc={mutation['return_code']})")
    survivors = [mutation["name"] for mutation in mutations if not mutation["killed"]]
    if survivors:
        print(f"survivors: {survivors}", file=sys.stderr)
        return 1
    print(f"{len(mutations)}/{len(mutations)} killed at {commit}")
    if not arguments.write:
        return 0
    manifest_sha256 = write_json(MANIFEST_PATH, {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "implementation_commit": commit,
        "mutations": mutations,
    })
    evidence = json.loads(OFFLINE_PATH.read_bytes())
    evidence.update(
        implementation_commit=commit, mutation_manifest_sha256=manifest_sha256,
        mutations_total=len(mutations), mutations_killed=len(mutations),
    )
    print(f"mutation manifest sha256 {manifest_sha256}")
    print(f"offline evidence sha256  {write_json(OFFLINE_PATH, evidence)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
