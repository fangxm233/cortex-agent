import json
from pathlib import Path

import pytest

from cortex_bench_harness.launcher.deepseek_upstream import (
    DeepSeekUpstream,
    DeepSeekUpstreamError,
    default_cortex_home,
    load_deepseek_upstream,
)

RELAY = "https://deepseek-relay.example.com/v1"
FAKE_KEY = "fake-relay-token-0001"


def _home(tmp_path: Path, connections: list[object] | None = None, dotenv: str | None = None) -> Path:
    config = tmp_path / "home" / "config"
    config.mkdir(parents=True)
    if connections is not None:
        (config / "connections.json").write_text(
            json.dumps({"version": 1, "connections": connections}), encoding="utf-8")
    if dotenv is not None:
        (config / ".env").write_text(dotenv, encoding="utf-8")
    return tmp_path / "home"


def _gateway(tmp_path: Path, text: str) -> Path:
    path = tmp_path / "gateway.yaml"
    path.write_text(text, encoding="utf-8")
    return path


def test_reads_the_deepseek_pi_connection_by_default(tmp_path: Path) -> None:
    home = _home(tmp_path, [
        {"id": "relay", "backend": "claude", "baseUrl": "https://claude.example.com", "key": "fake-claude"},
        {"id": "deepseek", "backend": "pi", "provider": "deepseek", "baseUrl": RELAY, "key": FAKE_KEY},
    ])
    assert load_deepseek_upstream(cortex_home=home) == DeepSeekUpstream(RELAY, FAKE_KEY)


def test_the_credential_never_shows_in_repr(tmp_path: Path) -> None:
    home = _home(tmp_path, [{"id": "deepseek", "backend": "pi", "baseUrl": RELAY, "key": FAKE_KEY}])
    assert FAKE_KEY not in repr(load_deepseek_upstream(cortex_home=home))


def test_the_cortex_home_defaults_to_cortex_home_then_dot_cortex(tmp_path: Path) -> None:
    assert default_cortex_home({"CORTEX_HOME": str(tmp_path)}) == tmp_path
    assert default_cortex_home({}) == Path("~/.cortex").expanduser()


@pytest.mark.parametrize(("connections", "message"), [
    (None, "cannot read"),
    ([{"id": "openai", "backend": "pi", "baseUrl": RELAY, "key": FAKE_KEY}], "no `deepseek` PI connection"),
    ([{"id": "deepseek", "backend": "pi", "baseUrl": RELAY}], "has no key"),
    ([{"id": "deepseek", "backend": "pi", "key": FAKE_KEY}], "has no baseUrl"),
])
def test_refuses_a_connection_it_cannot_use(
    tmp_path: Path, connections: list[object] | None, message: str,
) -> None:
    with pytest.raises(DeepSeekUpstreamError, match=message) as refusal:
        load_deepseek_upstream(cortex_home=_home(tmp_path, connections))
    assert FAKE_KEY not in str(refusal.value)


def test_reads_a_named_gateway_route_when_one_is_given(tmp_path: Path) -> None:
    gateway = _gateway(tmp_path, (
        "port: 9880\n"
        "deepseek:\n"
        "  other:\n    base_url: https://other.example.com\n    keys: [fake-other]\n"
        f"  deepseek:\n    base_url: {RELAY}\n    keys: [{FAKE_KEY}]\n"))
    home = _home(tmp_path, [{"id": "deepseek", "backend": "pi", "baseUrl": "https://ignored.invalid", "key": "x"}])
    assert load_deepseek_upstream(cortex_home=home, gateway_path=gateway) == DeepSeekUpstream(RELAY, FAKE_KEY)


def test_reads_a_flat_section_or_its_first_mode(tmp_path: Path) -> None:
    flat = _gateway(tmp_path, f"deepseek:\n  base_url: {RELAY}\n  keys: [{FAKE_KEY}]\n")
    home = _home(tmp_path)
    assert load_deepseek_upstream(cortex_home=home, gateway_path=flat).base_url == RELAY
    first = _gateway(tmp_path, f"deepseek:\n  relay:\n    base_url: {RELAY}\n    keys: [{FAKE_KEY}]\n")
    assert load_deepseek_upstream(cortex_home=home, gateway_path=first).credential == FAKE_KEY


@pytest.mark.parametrize("reference", ["$RELAY_TOKEN", "${RELAY_TOKEN}"])
def test_resolves_a_key_reference_from_the_home_dotenv(tmp_path: Path, reference: str) -> None:
    home = _home(tmp_path, dotenv=f"# relay\nexport RELAY_TOKEN=\"{FAKE_KEY}\"\nOTHER=1\n")
    gateway = _gateway(tmp_path, f"deepseek:\n  deepseek:\n    base_url: {RELAY}\n    keys: ['{reference}']\n")
    assert load_deepseek_upstream(cortex_home=home, gateway_path=gateway).credential == FAKE_KEY


def test_refuses_a_reference_the_dotenv_does_not_set(tmp_path: Path) -> None:
    gateway = _gateway(tmp_path, f"deepseek:\n  base_url: {RELAY}\n  keys: [$RELAY_TOKEN]\n")
    with pytest.raises(DeepSeekUpstreamError, match=r"names \$RELAY_TOKEN"):
        load_deepseek_upstream(cortex_home=_home(tmp_path), gateway_path=gateway)


@pytest.mark.parametrize(("text", "message"), [
    ("anthropic: {}\n", "no `deepseek` section"),
    ("deepseek:\n  note: text\n", "holds no route"),
    (f"deepseek:\n  base_url: {RELAY}\n  keys: []\n", "carries no key"),
    ("deepseek:\n  keys: [fake]\n", "has no base_url"),
])
def test_refuses_a_gateway_route_it_cannot_use(tmp_path: Path, text: str, message: str) -> None:
    with pytest.raises(DeepSeekUpstreamError, match=message):
        load_deepseek_upstream(cortex_home=_home(tmp_path), gateway_path=_gateway(tmp_path, text))
