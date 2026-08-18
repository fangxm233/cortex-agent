# input:  a campaign's declared network block, the trial proxy host, and host DNS
# output: the trial's Harbor network policies, a denylist address set, and the evidence fragment
# pos:    Trial network access boundary
# >>> If I am updated, update my header and folder CORTEX.md <<<
#
# A trial used to have exactly one network shape: deny everything, allow the one credential route.
# That shape is now one of three, and this module is where a campaign's declaration becomes them.
# It exists so the decision is made once, against a document, before anything is armed — admission
# consumes what this produces and never re-derives it.
#
# WHAT THE MODES MEAN
#
# `open` is a container that can reach the internet. Harbor is handed PUBLIC, which makes
# `_requires_egress_control` false, which means no egress sidecar is built at all and `main` holds
# its own network namespace. There is nothing to filter with and nothing claiming to filter.
#
# `filtered` builds the sidecar by declaring an empty ALLOWLIST baseline, then narrows to the
# effective policy once the container is up. An allowlist is enforced by gost, which is a real
# control. A denylist is enforced by an nftables set this harness installs itself, which is NOT a
# real control against an adversary — see below.
#
# WHY A DENYLIST IS BEST-EFFORT, STATED ONCE HERE
#
# gost has no deny concept; its allowlist file is the only thing it reads. So a denylist is
# enforced out-of-band, by rejecting packets to a set of ADDRESSES in the sidecar's network
# namespace. Hostnames are resolved to addresses once, on the host, at admission time. That
# snapshot is stale the moment DNS rotates, a CDN answers differently, or the container dials an
# address directly. A denylist keeps an honest agent off a host; it does not keep a determined one
# off. Wildcard entries are refused outright rather than accepted and quietly ignored, because
# `*.example.com` has no address set to compute and pretending otherwise is the failure this
# boundary exists to prevent.

import ipaddress
import socket
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from harbor.models.task.config import NetworkMode, NetworkPolicy, normalize_allowed_hosts

MODE_OPEN = "open"
MODE_FILTERED = "filtered"
NETWORK_MODES = (MODE_OPEN, MODE_FILTERED)
NETWORK_FIELDS = frozenset({"mode", "allowlist", "denylist"})
# Restated from `trial_admission._forbidden_network_hosts` so a campaign that would name one is
# refused while it is still a document. Naming a metadata address in either list is a refusal, not
# a narrowing: in a denylist it implies the other addresses are reachable, and in an allowlist it
# asks for the one destination admission exists to keep unreachable.
METADATA_HOSTS = frozenset({"169.254.169.254", "metadata.google.internal"})
DENYLIST_ENFORCEMENT = "best-effort-dns-snapshot"


class NetworkAccessError(ValueError):
    """A declared network block does not describe an enforceable trial network."""


@dataclass(frozen=True)
class DenylistEntry:
    """One declared denylist entry and the addresses it resolved to at admission time."""

    host: str
    resolved: tuple[str, ...]

    def record(self) -> dict[str, object]:
        return {
            "host": self.host,
            "resolved": list(self.resolved),
            "enforcement": DENYLIST_ENFORCEMENT,
        }


@dataclass(frozen=True)
class NetworkAccess:
    """What a campaign declared its trials may reach."""

    mode: str
    allowlist: tuple[str, ...] = ()
    denylist: tuple[str, ...] = ()

    @property
    def filtered(self) -> bool:
        return self.mode == MODE_FILTERED

    def startup_policy(self) -> NetworkPolicy:
        """The policy Harbor constructs the environment with.

        `filtered` starts from an empty allowlist rather than the effective one: it is what makes
        `_requires_egress_control` true so the sidecar exists, and it means the container is born
        denied and is widened only after it is up, never the reverse.
        """
        if not self.filtered:
            return NetworkPolicy(network_mode=NetworkMode.PUBLIC)
        return NetworkPolicy(network_mode=NetworkMode.ALLOWLIST, allowed_hosts=[])

    def effective_policy(self, proxy_host: str) -> NetworkPolicy:
        """The policy the running container is left under.

        Three shapes. An allowlist always gains the trial's own proxy host, because the credential
        route is not the campaign's to forget and a campaign that had to restate it could get it
        wrong. A denylist with no allowlist is "everything except these", so gost is told to stop
        filtering and the address set is the only thing left enforcing anything. An empty
        `filtered` block is the strictest reading of the word: nothing was allowed, so the trial
        reaches its credential route and nothing else — which is the shape every benchmark ran
        under before the network was opened, and the one to return to for a trustworthy score.
        """
        if not self.filtered:
            return NetworkPolicy(network_mode=NetworkMode.PUBLIC)
        if not self.allowlist and self.denylist:
            return NetworkPolicy(network_mode=NetworkMode.PUBLIC)
        hosts = sorted({*self.allowlist, proxy_host})
        return NetworkPolicy(network_mode=NetworkMode.ALLOWLIST, allowed_hosts=hosts)


def parse_network_access(value: object) -> NetworkAccess:
    """Read the optional `network` block, closed-world.

    An absent block is `open`: this is the declared default, and a campaign that says nothing about
    its network gets a container that can reach the internet.
    """
    if value is None:
        return NetworkAccess(mode=MODE_OPEN)
    if not isinstance(value, Mapping):
        raise NetworkAccessError("campaign network must be a mapping")
    unknown = sorted(set(value) - NETWORK_FIELDS)
    if unknown:
        raise NetworkAccessError(
            f"campaign network has unknown field(s) {unknown}; it accepts "
            f"{sorted(NETWORK_FIELDS)}")
    mode = value.get("mode")
    if mode not in NETWORK_MODES:
        raise NetworkAccessError(
            f"campaign network mode must be one of {list(NETWORK_MODES)}; got {mode!r}")
    allowlist = _entries(value.get("allowlist"), "allowlist")
    denylist = _entries(value.get("denylist"), "denylist")
    if mode == MODE_OPEN and (allowlist or denylist):
        raise NetworkAccessError(
            "campaign network mode 'open' enforces nothing, so it cannot declare an allowlist or "
            "a denylist. Declaring a list that does not run is the one failure this block exists "
            "to prevent; use mode 'filtered' to enforce it")
    for entry in denylist:
        if entry.startswith("*."):
            raise NetworkAccessError(
                f"campaign network denylist entry {entry!r} is a wildcard. A denylist is enforced "
                "as a set of addresses resolved once at admission, and a wildcard has no address "
                "set; name the hosts, an IP, or a CIDR range")
    return NetworkAccess(mode=mode, allowlist=allowlist, denylist=denylist)


def _entries(value: object, field: str) -> tuple[str, ...]:
    """Validate one declared list through Harbor's own normalizer.

    Reusing `normalize_allowed_hosts` is deliberate: whatever this accepts is handed to Harbor
    verbatim, so accepting a form Harbor would later refuse would move a config error into a
    running trial.
    """
    if value is None:
        return ()
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise NetworkAccessError(f"campaign network {field} must be a list")
    if not all(isinstance(entry, str) for entry in value):
        raise NetworkAccessError(f"campaign network {field} entries must be strings")
    try:
        normalized = normalize_allowed_hosts(list(value))
    except ValueError as error:
        raise NetworkAccessError(f"campaign network {field} is invalid: {error}") from error
    forbidden = sorted(set(normalized) & METADATA_HOSTS)
    if forbidden:
        raise NetworkAccessError(
            f"campaign network {field} names the instance metadata address(es) {forbidden}, "
            "which admission refuses outright")
    duplicates = sorted({entry for entry in normalized if normalized.count(entry) > 1})
    if duplicates:
        raise NetworkAccessError(f"campaign network {field} repeats {duplicates}")
    return tuple(normalized)


def resolve_denylist(access: NetworkAccess) -> tuple[DenylistEntry, ...]:
    """Snapshot each denylist entry as the addresses it names right now.

    Literal addresses and CIDR ranges resolve to themselves. Hostnames are looked up on the host,
    once. A hostname that resolves to nothing is kept with an empty set rather than refused: the
    campaign said to deny it, and a name that does not resolve is not reachable to begin with.
    """
    return tuple(
        DenylistEntry(host=host, resolved=_addresses(host)) for host in access.denylist
    )


def denylist_addresses(entries: Sequence[DenylistEntry]) -> tuple[list[str], list[str]]:
    """Split every resolved address into the v4 and v6 sets the nftables rules are built from."""
    v4: list[str] = []
    v6: list[str] = []
    for entry in entries:
        for value in entry.resolved:
            target = v4 if _is_v4(value) else v6
            if value not in target:
                target.append(value)
    return sorted(v4), sorted(v6)


def _is_v4(value: str) -> bool:
    if "/" in value:
        return ipaddress.ip_network(value, strict=True).version == 4
    return ipaddress.ip_address(value).version == 4


def _addresses(host: str) -> tuple[str, ...]:
    if "/" in host:
        return (host,)
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        return (host,)
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        return ()
    return tuple(sorted({str(info[4][0]) for info in infos}))


def network_record(
    access: NetworkAccess, startup: NetworkPolicy, effective: NetworkPolicy,
    denylist: Sequence[DenylistEntry],
) -> dict[str, object]:
    """The evidence fragment, which states what is enforced rather than what was hoped for.

    `denied` is derived from the effective policy, not asserted. Under `open` the two categories
    that used to be listed unconditionally — arbitrary egress and the public network — are absent,
    because they are no longer denied, and evidence that claimed otherwise would be false.
    """
    return {
        "mode": access.mode,
        "default": "deny" if effective.network_mode is NetworkMode.ALLOWLIST else "allow",
        "loopback": "allow",
        "startup_policy": _policy_record(startup),
        "effective_policy": _policy_record(effective),
        "allowlist": {
            "declared": list(access.allowlist),
            "enforcement": "gost-allowlist" if access.allowlist else "none",
        },
        "denylist": {
            "declared": list(access.denylist),
            "entries": [entry.record() for entry in denylist],
            "enforcement": DENYLIST_ENFORCEMENT if access.denylist else "none",
            "caveat": (
                "Addresses were resolved once on the host at admission. DNS rotation, CDN "
                "re-mapping and direct-to-IP connections are not covered."
            ) if access.denylist else None,
        },
        "denied": denied_categories(effective),
    }


def denied_categories(effective: NetworkPolicy) -> list[str]:
    """The destination classes the effective policy actually refuses.

    Credential isolation is what the first four state, and it does not depend on the network mode:
    the provider key never enters the container, so a direct provider call has nothing to send and
    a sibling trial's route answers only its own bound source address.
    """
    denied = ["direct-provider", "host-daemon", "instance-metadata", "sibling-route"]
    if effective.network_mode is NetworkMode.ALLOWLIST:
        denied.extend(["arbitrary-egress", "public-network"])
    return sorted(denied)


def _policy_record(policy: NetworkPolicy) -> dict[str, object]:
    return {
        "network_mode": policy.network_mode.value,
        "allowed_hosts": list(policy.allowed_hosts),
    }
