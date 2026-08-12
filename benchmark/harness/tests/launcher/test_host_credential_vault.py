# input:  process-local credential vault and monotonic clock
# output: consume-once, expiry, purge, and secret-free handle proofs
# pos:    Host-only benchmark credential vault tests
# >>> If I am updated, update my header and folder CORTEX.md <<<

import pytest

from cortex_bench_harness.launcher.host_credential_vault import HostCredentialVault

SECRET = "relay-secret-UNIQUE"


def test_consumes_a_credential_once_without_putting_it_in_the_handle() -> None:
    vault = HostCredentialVault(now=lambda: 10.0)
    handle = vault.store(SECRET, ttl_seconds=5)
    assert SECRET not in handle
    assert vault.consume(handle) == SECRET
    with pytest.raises(LookupError, match="unavailable"):
        vault.consume(handle)


def test_expired_credentials_are_deleted_and_refused() -> None:
    current = [10.0]
    vault = HostCredentialVault(now=lambda: current[0])
    handle = vault.store(SECRET, ttl_seconds=1)
    current[0] = 12.0
    with pytest.raises(LookupError, match="expired"):
        vault.consume(handle)
    assert vault.pending_count == 0


def test_purge_is_idempotent_and_does_not_echo_the_secret() -> None:
    vault = HostCredentialVault(now=lambda: 10.0)
    handle = vault.store(SECRET, ttl_seconds=5)
    vault.purge(handle)
    vault.purge(handle)
    with pytest.raises(LookupError) as error:
        vault.consume(handle)
    assert SECRET not in str(error.value)
