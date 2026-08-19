# input:  committed smoke config, pinned Docker images, synthetic gateway/upstream
# output: pre-arm refusal and one-request path-safe smoke evidence proofs
# pos:    Executable DeepSeek paid-smoke launcher tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
import yaml

from docker_gate import docker_opt_in
from cortex_bench_harness.launcher import deepseek_paid_smoke
from cortex_bench_harness.launcher import deepseek_paid_smoke_launcher as launcher

HARNESS_DIR = Path(__file__).resolve().parents[2]
CAMPAIGN = HARNESS_DIR.parent / "campaigns" / "terminal-bench-2.1-deepseek-paid-smoke.yaml"
PI_ONLY_IMAGE = (
    "cortex-terminal-bench-2.1@"
    "sha256:f7cd67351adf773328d8a07a483daaff838a05388205872cfe65c187aef9b353"
)
CORTEX_IMAGE = (
    "cortex-terminal-bench-2.1@"
    "sha256:002574fdff7d6c7fa3ae377253d36c86eebdbc05eb53a34995154944ea7420f1"
)


def test_committed_smoke_config_pins_the_cortex_task_image() -> None:
    config, plan = launcher.load_smoke_config(CAMPAIGN)

    assert config.paid is True
    assert plan.task.task_id == "constraints-scheduling"
    assert plan.task.image_ref == CORTEX_IMAGE
    assert plan.task.path.name == "constraints-scheduling"
    assert plan.task.path.parent.name == "terminal-bench-2.1"
    assert plan.arm["limits"] == {
        "max_provider_requests": 1,
        "max_cost_usd": "0.05",
        "deadline_seconds": 120,
        "max_output_tokens": 256,
    }


def test_missing_prerequisite_refuses_before_credential_or_network(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    def fail_preflight(_image_ref: str) -> dict[str, str]:
        calls.append("preflight")
        raise launcher.SmokeLaunchError("image prerequisite missing: npm")

    def forbidden(*_args: object, **_kwargs: object) -> object:
        calls.append("forbidden")
        raise AssertionError("credential loading, network creation, and route arming are forbidden")

    monkeypatch.setattr(launcher, "preflight_image", fail_preflight)
    monkeypatch.setattr(launcher, "load_deepseek_relay_credential", forbidden)
    monkeypatch.setattr(launcher, "create_smoke_network", forbidden)
    monkeypatch.setattr(launcher, "run_deepseek_paid_smoke", forbidden)

    with pytest.raises(launcher.SmokeLaunchError, match="npm"):
        asyncio.run(launcher.launch_smoke(config_path=CAMPAIGN, gateway_path=Path("unused")))

    assert calls == ["preflight"]


@docker_opt_in
def test_pi_only_image_reproduces_the_missing_npm_setup_failure() -> None:
    with pytest.raises(launcher.SmokeLaunchError, match="npm"):
        launcher.preflight_image(PI_ONLY_IMAGE)


@docker_opt_in
def test_compatible_image_passes_every_cortex_setup_prerequisite() -> None:
    evidence = launcher.preflight_image(CORTEX_IMAGE)

    assert evidence == {
        "image_digest": CORTEX_IMAGE.rsplit("@", 1)[1],
        "node": "v22.19.0",
        "npm": "10.9.3",
        "pi": "0.82.1",
        "prerequisites": list(launcher.CORTEX_SETUP_PREREQUISITES),
    }


class OneRequestUpstream:
    def __init__(self) -> None:
        self.requests = 0
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                owner.requests += 1
                body = self.rfile.read(int(self.headers.get("content-length", "0")))
                request = json.loads(body)
                assert request["model"] == "deepseek-v4-flash"
                payload = _final_sse()
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, _format: str, *_args: object) -> None:
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self) -> str:
        host, port = self.server.server_address
        return f"http://{host}:{port}/m/deepseek/deepseek"

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


def _final_sse() -> bytes:
    chunks = [
        {"id": "smoke", "model": "deepseek-v4-flash",
         "choices": [{"index": 0, "delta": {"content": "done"}, "finish_reason": "stop"}]},
        {"id": "smoke", "model": "deepseek-v4-flash", "choices": [],
         "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
    ]
    return ("".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks)
            + "data: [DONE]\n\n").encode()


def _synthetic_config(tmp_path: Path, upstream: str) -> Path:
    document = yaml.safe_load(CAMPAIGN.read_text(encoding="utf-8"))
    document["trials_dir"] = str(tmp_path / "trials")
    document["credential"]["upstream_base_url"] = upstream
    document["manifest"] = {
        "wheel_path": str(HARNESS_DIR / "dist/cortex_bench_harness-0.1.0-py3-none-any.whl"),
        "npm_artifact_path": str(HARNESS_DIR / "dist/cortex-agent-server-2026.8.6.tgz"),
        "lockfile_path": str(HARNESS_DIR / "uv.lock"),
        "lockfile_manifest_path": "benchmark/harness/uv.lock",
    }
    document["tasks"][0]["path"] = str(
        HARNESS_DIR.parent / "campaigns/tasks/terminal-bench-2.1/constraints-scheduling")
    path = tmp_path / "smoke.yaml"
    path.write_text(yaml.safe_dump(document, sort_keys=False), encoding="utf-8")
    return path


def _run_synthetic_smoke(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> tuple[dict[str, object], int, Path, str, Path]:
    upstream = OneRequestUpstream()
    gateway = tmp_path / "gateway.yaml"
    secret = "synthetic-only-smoke-credential"
    gateway.write_text(f"deepseek:\n  deepseek:\n    keys:\n      - {secret}\n", encoding="utf-8")
    config = _synthetic_config(tmp_path, upstream.base_url)
    real_loader = deepseek_paid_smoke.load_deepseek_relay_credential
    loaded: list[Path] = []

    def synthetic_loader(path: Path) -> str:
        assert path == gateway
        loaded.append(path)
        return real_loader(path)

    monkeypatch.setattr(launcher, "load_deepseek_relay_credential", synthetic_loader)
    monkeypatch.setattr(deepseek_paid_smoke, "load_deepseek_relay_credential", synthetic_loader)
    monkeypatch.setattr(deepseek_paid_smoke, "UPSTREAM", upstream.base_url)
    monkeypatch.setattr(launcher, "_checkout_root", lambda _config: str(HARNESS_DIR.parents[1]))
    try:
        result = asyncio.run(launcher.launch_smoke(config_path=config, gateway_path=gateway))
    finally:
        upstream.stop()
    assert loaded == [gateway, gateway]
    return result, upstream.requests, config, secret, gateway


@docker_opt_in
def test_compatible_path_reaches_one_synthetic_request_without_real_credential(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    result, requests, config, secret, _gateway = _run_synthetic_smoke(tmp_path, monkeypatch)
    assert requests == 1
    assert result["terminal"]["state"] in {"terminal-success", "harness-incomplete"}
    assert result["counters"]["requests"] == 1
    assert isinstance(result["leak_scan"]["clean"], bool)
    assert result["leak_scan"]["credential_matches"] == 0
    assert result["network"] == {"created": True, "removed": True}
    assert result["revocation"]["listener_present"] is False
    assert result["revocation"]["route_active"] in {False, None}
    recorded = Path(yaml.safe_load(config.read_text())["trials_dir"]) / launcher.EVIDENCE_FILENAME
    assert json.loads(recorded.read_text(encoding="utf-8")) == result
    encoded = json.dumps(result, sort_keys=True)
    assert secret not in encoded
    assert str(tmp_path) not in encoded


def _incomplete_trial(tmp_path: Path, secret: str) -> Path:
    trial_root = tmp_path / "trial"
    (trial_root / "artifacts/proxy").mkdir(parents=True)
    (trial_root / "result.json").write_text(json.dumps({"exception_info": {
        "exception_type": "NonZeroAgentExitCodeError",
        "exception_message": f"failed under {tmp_path} with {secret}",
    }}), encoding="utf-8")
    counters = {
        name: {"status": "available", "value": 0}
        for name in ("requests", "input_tokens", "output_tokens", "cached_tokens")
    }
    (trial_root / "artifacts/proxy/proxy-export.json").write_text(
        json.dumps(counters), encoding="utf-8")
    return trial_root


def test_path_safe_evidence_omits_paths_credentials_and_raw_reasons(tmp_path: Path) -> None:
    secret = "synthetic-smoke-secret"
    record = launcher.path_safe_evidence(
        trial_root=_incomplete_trial(tmp_path, secret), trial_id="smoke-trial",
        arm_name=launcher.SMOKE_ARM_NAME, image_digest=CORTEX_IMAGE.rsplit("@", 1)[1],
        scan_policy=launcher.synthetic_scan_policy(secret, tmp_path), network_removed=True,
    )
    encoded = json.dumps(record, sort_keys=True)
    assert str(tmp_path) not in encoded
    assert secret not in encoded
    assert "exception_message" not in encoded
    assert record["terminal"]["state"] == "harness-incomplete"
    assert record["counters"]["requests"] == 0
    assert record["network"] == {"created": True, "removed": True}
    assert record["leak_scan"]["credential_matches"] == 1
