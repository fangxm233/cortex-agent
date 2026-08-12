# input:  host credential values, expiry durations, monotonic clock
# output: opaque handles with locked consume-once credential ownership
# pos:    Process-local paid-trial credential handoff
# >>> If I am updated, update my header and folder CORTEX.md <<<

import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass


@dataclass(frozen=True)
class _VaultEntry:
    credential: str
    expires_at: float


class HostCredentialVault:
    def __init__(self, now: Callable[[], float] = time.monotonic) -> None:
        self._now = now
        self._lock = threading.Lock()
        self._entries: dict[str, _VaultEntry] = {}

    @property
    def pending_count(self) -> int:
        with self._lock:
            return len(self._entries)

    def store(self, credential: str, *, ttl_seconds: float) -> str:
        if not credential or "\r" in credential or "\n" in credential:
            raise ValueError("credential must be a non-empty single line")
        if ttl_seconds <= 0:
            raise ValueError("credential ttl must be positive")
        handle = f"vault-{secrets.token_urlsafe(24)}"
        with self._lock:
            self._entries[handle] = _VaultEntry(credential, self._now() + ttl_seconds)
        return handle

    def consume(self, handle: str) -> str:
        with self._lock:
            entry = self._entries.pop(handle, None)
        if entry is None:
            raise LookupError("credential handle is unavailable")
        if self._now() >= entry.expires_at:
            raise LookupError("credential handle expired")
        return entry.credential

    def purge(self, handle: str) -> None:
        with self._lock:
            self._entries.pop(handle, None)


HOST_CREDENTIAL_VAULT = HostCredentialVault()
