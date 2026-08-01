# input:  existing H3 manifest and safe trial proxy handle
# output: atomically updated credential-free proxy block
# pos:    Proxy manifest persistence
# >>> If I am updated, update my header and folder CORTEX.md <<<

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from ..manifest import SCHEMA_VERSION
from .server import TrialProxyHandle


def fill_proxy_manifest(
    manifest_path: Path, handle: TrialProxyHandle,
) -> dict[str, Any]:
    document = json.loads(manifest_path.read_text())
    if not isinstance(document, dict) or document.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(f"manifest must use {SCHEMA_VERSION}")
    if document.get("trial_id") != handle.trial_id:
        raise ValueError("manifest trial_id does not match the proxy trial")
    existing = document.get("proxy")
    if existing not in (None, handle.manifest_block):
        raise ValueError("manifest proxy block is already populated")
    document["proxy"] = handle.manifest_block
    _atomic_write(manifest_path, document)
    return document


def _atomic_write(path: Path, document: dict[str, Any]) -> None:
    payload = json.dumps(document, indent=2, sort_keys=True) + "\n"
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.",
            delete=False,
        ) as output:
            temporary = output.name
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and os.path.exists(temporary):
            os.unlink(temporary)
