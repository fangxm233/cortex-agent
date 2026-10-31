"""Where a paid DeepSeek trial's host-side proxy sends requests, and the credential it sends.

Both come from one source so they always belong together: a relay token is only good at the relay
it was issued for. The default source is the `deepseek` PI connection in the Cortex home's
`config/connections.json` (its `baseUrl` and `key`). A `gateway.yaml` written by an earlier Cortex
is read only when named explicitly: the `deepseek` route's `base_url` and first key, with a `$VAR`
key resolved from that Cortex home's `config/.env`.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

PROVIDER = "deepseek"
# Keys that, directly on a gateway.yaml section, make the section itself the one route.
FLAT_ROUTE_KEYS = frozenset({
    "keys", "base_url", "auth_style", "passthrough", "fallbacks", "model_fallbacks",
})
VARIABLE_REFERENCE = re.compile(r"^\$(?:\{(?P<braced>[A-Za-z_][A-Za-z0-9_]*)\}|(?P<bare>[A-Za-z_][A-Za-z0-9_]*))$")


class DeepSeekUpstreamError(ValueError):
    """The source holds no usable DeepSeek upstream. The message never carries a secret."""


@dataclass(frozen=True)
class DeepSeekUpstream:
    base_url: str
    credential: str = field(repr=False)


def default_cortex_home(environ: Mapping[str, str] = os.environ) -> Path:
    return Path(environ.get("CORTEX_HOME") or "~/.cortex").expanduser()


def load_deepseek_upstream(
    *, cortex_home: Path | None = None, gateway_path: Path | None = None,
) -> DeepSeekUpstream:
    """The DeepSeek upstream from connections.json, or from `gateway_path` when one is given."""
    home = cortex_home if cortex_home is not None else default_cortex_home()
    if gateway_path is not None:
        return _from_gateway(gateway_path, home / "config" / ".env")
    return _from_connections(home / "config" / "connections.json")


def _from_connections(path: Path) -> DeepSeekUpstream:
    document = _read_json(path)
    entries = document.get("connections") if isinstance(document, Mapping) else None
    if not isinstance(entries, list):
        raise DeepSeekUpstreamError(f"{path} lists no connections")
    entry = next((item for item in entries if _is_deepseek(item)), None)
    if entry is None:
        raise DeepSeekUpstreamError(f"{path} has no `deepseek` PI connection")
    return DeepSeekUpstream(
        base_url=_required(entry, "baseUrl", f"the `deepseek` connection in {path}"),
        credential=_required(entry, "key", f"the `deepseek` connection in {path}"),
    )


def _is_deepseek(entry: object) -> bool:
    return (isinstance(entry, Mapping) and entry.get("backend") == "pi"
            and entry.get("provider", entry.get("id")) == PROVIDER)


def _from_gateway(path: Path, env_path: Path) -> DeepSeekUpstream:
    route = _gateway_route(_read_yaml(path), path)
    label = f"the `deepseek` route in {path}"
    keys = route.get("keys")
    if not isinstance(keys, list) or not keys:
        raise DeepSeekUpstreamError(f"{label} carries no key")
    key = keys[0]
    if not isinstance(key, str) or not key.strip():
        raise DeepSeekUpstreamError(f"{label} has an empty first key")
    return DeepSeekUpstream(
        base_url=_required(route, "base_url", label),
        credential=_resolve_reference(key.strip(), env_path, label),
    )


def _gateway_route(document: object, path: Path) -> Mapping[str, Any]:
    section = document.get(PROVIDER) if isinstance(document, Mapping) else None
    if not isinstance(section, Mapping):
        raise DeepSeekUpstreamError(f"{path} has no `deepseek` section")
    if FLAT_ROUTE_KEYS & set(section):
        return section
    named = section.get(PROVIDER)
    if isinstance(named, Mapping):
        return named
    first = next((route for route in section.values() if isinstance(route, Mapping)), None)
    if first is None:
        raise DeepSeekUpstreamError(f"the `deepseek` section of {path} holds no route")
    return first


def _resolve_reference(key: str, env_path: Path, label: str) -> str:
    match = VARIABLE_REFERENCE.match(key)
    if match is None:
        return key
    name = match.group("braced") or match.group("bare")
    value = read_dotenv(env_path).get(name, "").strip()
    if not value:
        raise DeepSeekUpstreamError(f"{label} names ${name}, which {env_path} does not set")
    return value


def read_dotenv(path: Path) -> dict[str, str]:
    """`KEY=VALUE` lines, `export` and quotes allowed; a missing file is empty."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return {}
    values: dict[str, str] = {}
    for line in lines:
        name, separator, value = line.strip().removeprefix("export ").partition("=")
        if separator and name.strip() and not name.lstrip().startswith("#"):
            values[name.strip()] = _unquote(value.strip())
    return values


def _unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def _required(source: Mapping[str, Any], key: str, label: str) -> str:
    value = source.get(key)
    if not isinstance(value, str) or not value.strip():
        raise DeepSeekUpstreamError(f"{label} has no {key}")
    return value.strip()


def _read_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise DeepSeekUpstreamError(f"cannot read {path}: {type(error).__name__}") from None


def _read_yaml(path: Path) -> object:
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as error:
        raise DeepSeekUpstreamError(f"cannot read {path}: {type(error).__name__}") from None
