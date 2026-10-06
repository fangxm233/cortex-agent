import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol


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


class _ClearableHolder(Protocol):
    def clear(self) -> None: ...


class HostTokenHolders:
    """Host-side token holders shared by every trial of one campaign, addressed by a handle.

    The handle names a holder and carries no secret, so it may travel in a Harbor agent
    configuration exactly as a credential *name* does; the tokens never leave this process.
    Releasing a handle clears its holder, which is how a campaign drops its rotated tokens.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._holders: dict[str, _ClearableHolder] = {}

    def register(self, holder: _ClearableHolder) -> str:
        handle = f"holder-{secrets.token_urlsafe(18)}"
        with self._lock:
            self._holders[handle] = holder
        return handle

    def get(self, handle: str) -> _ClearableHolder:
        with self._lock:
            holder = self._holders.get(handle)
        if holder is None:
            raise LookupError("token holder handle is unavailable")
        return holder

    def release(self, handle: str) -> None:
        with self._lock:
            holder = self._holders.pop(handle, None)
        if holder is not None:
            holder.clear()


HOST_TOKEN_HOLDERS = HostTokenHolders()
