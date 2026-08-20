# input:  offline capability, bounded request, credential, scan policy
# output: no-retry request, provider-identifier-safe response diagnostic, promotion evidence
# pos:    Bootstrap authorization for one live provider handshake
# >>> If I am updated, update my header and folder CORTEX.md <<<

import base64
import hashlib
import json
import re
import threading
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from http.client import HTTPConnection, HTTPResponse, IncompleteRead
from pathlib import Path
from types import MappingProxyType
from urllib.parse import urlsplit

import zstandard

from ..proxy.lease import LeaseTerms
from ..proxy.models import ProxyLimits
from ..proxy.server import host_now_ms, start_trial_proxy
from ..scan import scan_trial_artifacts
from ..scan.models import ArtifactInventory, ScanPolicy
from . import credential_capabilities as capabilities
from .capability_evidence import (
    CAPABILITY_EVIDENCE_METADATA,
    CAPABILITY_EVIDENCE_SCHEMA_VERSION,
    validate_capability_evidence,
)
from .credential_capabilities import CredentialCapabilityKey
from .trial_proxy import (
    TrialProxySession,
    TrialProxySpec,
    TrialRevocation,
    _adapter_selection_record,
    _require_contained,
    _select_trial_adapter,
    _write_json,
    revoke_trial_proxy,
)

MAX_PROVIDER_REQUESTS = 1
MAX_DEADLINE_SECONDS = 120
MAX_OUTPUT_TOKENS = 256
MAX_CODEX_OUTPUT_TOKENS = 65_536
MAX_BODY_BYTES = 67_108_864
RUN_CONFIG_FILENAME = "live-handshake-run-config.json"
REQUEST_METADATA_FILENAME = "live-handshake-request.json"
REQUEST_BODY_FILENAME = "live-handshake-request.body"
RESPONSE_DIAGNOSTIC_FILENAME = "live-handshake-response.json"
RUN_CONFIG_SCHEMA_VERSION = "cortex-bench-live-handshake-run/1"
RESPONSE_DIAGNOSTIC_SCHEMA_VERSION = "cortex-bench-live-handshake-response/1"
_SENSITIVE_RESPONSE_HEADERS = frozenset({
    "authorization", "proxy-authorization", "set-cookie", "x-api-key",
    "chatgpt-account-id", "request-id", "x-request-id",
    "anthropic-organization-id", "anthropic-workspace-id",
    "traceresponse", "traceparent", "tracestate", "cf-ray", "x-amz-cf-id",
})
_PROVIDER_IDENTIFIER_BODY_KEYS = frozenset({
    "account_id", "accountid", "cdn_id", "cdnid", "organization_id",
    "organizationid", "request_id", "requestid", "trace_id", "traceid",
    "workspace_id", "workspaceid",
})
_HOME_PATH = re.compile(rb"/home/(?!\.)[^/\x00\s\"']+(?:/[^\x00\s\"']*)?")


class LiveHandshakePermitRefused(Exception):
    """A bootstrap permit was reused or asked to exceed its one-request authority."""


@dataclass(frozen=True)
class LiveHandshakeRequest:
    target: str
    headers: Mapping[str, str]
    body: bytes


@dataclass(frozen=True)
class _HandshakeAuthority:
    capability_id: str
    key: CredentialCapabilityKey
    metadata: Mapping[str, object]
    model: str
    limits: Mapping[str, object]


@dataclass(frozen=True)
class _PermitGrant:
    authority: _HandshakeAuthority
    upstream: str
    spec: TrialProxySpec
    request: LiveHandshakeRequest


@dataclass
class _PermitState:
    lock: threading.Lock
    consumed: bool = False


_ISSUER = object()


class LiveHandshakePermit:
    """Process-local consume-once grant; re-issuance is a separate authorization act."""

    __slots__ = ("__grant", "__state")

    def __init__(self, grant=None, *, _issuer=None) -> None:
        if _issuer is not _ISSUER:
            raise TypeError("use issue_live_handshake_permit to mint a permit")
        object.__setattr__(self, "_LiveHandshakePermit__grant", grant)
        object.__setattr__(self, "_LiveHandshakePermit__state", _PermitState(threading.Lock()))

    def __setattr__(self, _name: str, _value: object) -> None:
        raise AttributeError("live handshake permits are immutable")

    def require_names(self, capability_id: str) -> None:
        if capability_id != self.__grant.authority.capability_id:
            raise LiveHandshakePermitRefused(
                f"permit for {self.__grant.authority.capability_id!r} "
                f"does not name {capability_id!r}")

    def consume(self, capability_id: str) -> _PermitGrant:
        self.require_names(capability_id)
        with self.__state.lock:
            if self.__state.consumed:
                raise LiveHandshakePermitRefused("live handshake permit was already consumed")
            self.__state.consumed = True
            return self.__grant


@dataclass(frozen=True)
class _HandshakeSession:
    proxy: TrialProxySession
    authority: _HandshakeAuthority
    adapter_id: str
    armed_at_ms: int
    absolute_deadline_ms: int
    upstream_identity: str


@dataclass(frozen=True)
class _HandshakeResponse:
    status: int
    incomplete: IncompleteRead | None = None


def issue_live_handshake_permit(
    *, capability_id: str, model: str, limits: Mapping[str, object],
    upstream_base_url: str, spec: TrialProxySpec, request: LiveHandshakeRequest,
) -> LiveHandshakePermit:
    sealed_limits = MappingProxyType(dict(limits))
    sealed_request = LiveHandshakeRequest(
        request.target, MappingProxyType(dict(request.headers)), bytes(request.body))
    authority = _authorize(capability_id, model, sealed_limits, spec, sealed_request)
    grant = _PermitGrant(authority, upstream_base_url, spec, sealed_request)
    return LiveHandshakePermit(grant, _issuer=_ISSUER)


def run_live_handshake(
    *, permit: LiveHandshakePermit, capability_id: str,
    artifact_dir: Path, evidence_dir: Path, host_credential: str,
    scan_policy: ScanPolicy, implementation_commit: str,
    conservative_cost_usd: str,
) -> Path:
    """Run the closed host-only handshake operation; no Harbor task object is accepted."""
    permit.require_names(capability_id)
    _require_credential_scan(scan_policy, host_credential)
    _require_contained(artifact_dir / "proxy", (artifact_dir,))
    grant = permit.consume(capability_id)
    session = _start_session(
        grant.authority, grant.upstream, grant.spec,
        artifact_dir / "proxy", host_credential,
    )
    try:
        response, revocation, request_error = _request_and_revoke(
            session, grant.request, grant.spec, artifact_dir, scan_policy)
    except BaseException:
        session.proxy.handle.stop()
        raise
    scan_clean = _scan_clean(revocation.inventory, scan_policy)
    if request_error is not None:
        raise request_error
    assert response is not None
    _require_successful_response(response, revocation.export_path)
    return _complete(
        session, revocation, scan_clean, evidence_dir, implementation_commit,
        grant.request.body, conservative_cost_usd,
    )


def _authorize(
    capability_id: str, model: str, limits: Mapping[str, object],
    spec: TrialProxySpec, request: LiveHandshakeRequest,
) -> _HandshakeAuthority:
    if not isinstance(model, str) or not model:
        raise LiveHandshakePermitRefused("live handshake model must be non-empty text")
    key, metadata = _require_offline_capability(capability_id)
    _require_limits(limits, spec, key.protocol)
    _require_request(request, key, limits, spec)
    return _HandshakeAuthority(
        capability_id, key, MappingProxyType(dict(metadata)), model,
        MappingProxyType(dict(limits)),
    )


def _require_offline_capability(
    capability_id: str,
) -> tuple[CredentialCapabilityKey, Mapping[str, object]]:
    try:
        key = capabilities.capability_key_for(capability_id)
    except LookupError as error:
        raise LiveHandshakePermitRefused(str(error)) from error
    row = capabilities.CAPABILITY_REGISTRY[key]
    if row.state != "offline-contract-passed":
        raise LiveHandshakePermitRefused(
            f"credential capability {capability_id!r} is {row.state}; "
            "live handshake permits require offline-contract-passed")
    metadata = _offline_metadata(key, row)
    return key, metadata


def _offline_metadata(key, row) -> Mapping[str, object]:
    try:
        capabilities._validate_evidence_binding(key, row)
    except ValueError as error:
        raise LiveHandshakePermitRefused(str(error)) from error
    path = capabilities._evidence_path(row.id, "offline-contract-passed")
    document = json.loads(path.read_bytes())
    fields = CAPABILITY_EVIDENCE_METADATA[row.id].metadata_fields
    return {field: document[field] for field in fields}


def _require_limits(
    limits: Mapping[str, object], spec: TrialProxySpec, protocol: str,
) -> None:
    _require_exact(limits, "max_provider_requests", MAX_PROVIDER_REQUESTS)
    _require_at_most(limits, "deadline_seconds", MAX_DEADLINE_SECONDS)
    output_ceiling = (
        MAX_CODEX_OUTPUT_TOKENS
        if protocol == "openai-codex-responses" else MAX_OUTPUT_TOKENS
    )
    _require_at_most(limits, "max_output_tokens", output_ceiling)
    _require_bound("request_body_limit_bytes", spec.request_body_limit_bytes, MAX_BODY_BYTES)
    _require_bound("response_body_limit_bytes", spec.response_body_limit_bytes, MAX_BODY_BYTES)


def _require_exact(values: Mapping[str, object], field: str, expected: int) -> None:
    if values.get(field) != expected:
        raise LiveHandshakePermitRefused(
            f"live handshake {field} must be exactly {expected}")


def _require_at_most(values: Mapping[str, object], field: str, ceiling: int) -> None:
    _require_bound(field, values.get(field), ceiling)


def _require_bound(field: str, value: object, ceiling: int) -> None:
    if not isinstance(value, int) or isinstance(value, bool) or not 0 < value <= ceiling:
        raise LiveHandshakePermitRefused(
            f"live handshake {field} must be a positive integer at most {ceiling}")


def _require_request(
    request: LiveHandshakeRequest, key: CredentialCapabilityKey,
    limits: Mapping[str, object], spec: TrialProxySpec,
) -> None:
    if not isinstance(request.body, bytes) or len(request.body) > spec.request_body_limit_bytes:
        raise LiveHandshakePermitRefused("live handshake request body exceeds its byte limit")
    _require_safe_headers(request.headers)
    document = _request_document(request.body, key.protocol)
    field = _output_cap_field(key.protocol)
    cap = document.get(field)
    if cap is None and key.protocol == "openai-codex-responses":
        return
    declared = limits["max_output_tokens"]
    if not isinstance(cap, int) or isinstance(cap, bool) or not 0 < cap <= declared:
        raise LiveHandshakePermitRefused("live handshake request output cap exceeds its permit")


def _require_credential_scan(policy: ScanPolicy, host_credential: str) -> None:
    if not host_credential or host_credential not in policy.secrets.values():
        raise LiveHandshakePermitRefused(
            "live handshake scan policy must name the actual host credential")


def _require_safe_headers(headers: Mapping[str, str]) -> None:
    denied = {"authorization", "x-api-key", "chatgpt-account-id"}
    for name, value in headers.items():
        if not isinstance(name, str) or not isinstance(value, str) or not name or "\n" in value:
            raise LiveHandshakePermitRefused("live handshake request headers are malformed")
        if name.lower() in denied:
            raise LiveHandshakePermitRefused("live handshake request carries a credential header")


def _request_document(body: bytes, protocol: str) -> Mapping[str, object]:
    payload = body
    if protocol == "openai-codex-responses":
        try:
            payload = zstandard.ZstdDecompressor().decompress(
                body, max_output_size=MAX_BODY_BYTES)
        except zstandard.ZstdError as error:
            raise LiveHandshakePermitRefused("live handshake request is not valid zstd") from error
    try:
        document = json.loads(payload)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise LiveHandshakePermitRefused("live handshake request body is not JSON") from error
    if not isinstance(document, dict):
        raise LiveHandshakePermitRefused("live handshake request body must be an object")
    return document


def _output_cap_field(protocol: str) -> str:
    fields = {
        "anthropic-messages": "max_tokens",
        "openai-completions": "max_completion_tokens",
        "openai-codex-responses": "max_output_tokens",
    }
    field = fields.get(protocol)
    if field is None:
        raise LiveHandshakePermitRefused(
            f"live handshake protocol {protocol!r} has no output-cap binding")
    return field


def _start_session(
    authority: _HandshakeAuthority, upstream: str, spec: TrialProxySpec,
    proxy_dir: Path, host_credential: str,
) -> _HandshakeSession:
    arm = {"model": authority.model, "limits": authority.limits}
    adapter = _select_trial_adapter(
        authority.key, arm, upstream, host_credential, spec.access_expires_at_ms)
    armed_at_ms = host_now_ms()
    deadline_ms = armed_at_ms + int(authority.limits["deadline_seconds"]) * 1000
    proxy = _start_handshake_proxy(
        arm, authority, upstream, spec, proxy_dir, adapter, armed_at_ms, deadline_ms)
    return _HandshakeSession(
        proxy, authority, adapter.adapter_id, armed_at_ms, deadline_ms,
        _upstream_identity(upstream),
    )


def _start_handshake_proxy(
    arm: Mapping[str, object], authority: _HandshakeAuthority, upstream: str,
    spec: TrialProxySpec, proxy_dir: Path, adapter, armed_at_ms: int, deadline_ms: int,
) -> TrialProxySession:
    trial_id = f"live-handshake-{authority.capability_id}"
    handle = start_trial_proxy(
        trial_id=trial_id, upstream_base_url=upstream, adapter=adapter,
        bound_source_ip=spec.bound_source_ip, absolute_deadline=_epoch(deadline_ms),
        limits=ProxyLimits(MAX_PROVIDER_REQUESTS),
        log_path=proxy_dir / "proxy-audit.jsonl",
        lease_terms=LeaseTerms(int(authority.limits["deadline_seconds"]) * 1000, 0),
        listen_host=spec.listen_host, advertised_host=spec.advertised_host,
        request_body_limit_bytes=spec.request_body_limit_bytes,
        response_body_limit_bytes=spec.response_body_limit_bytes,
        allow_retry=False,
    )
    session = TrialProxySession(handle, upstream, _epoch(deadline_ms), deadline_ms, proxy_dir)
    try:
        _write_json(session.adapter_selection_path, _adapter_selection_record(
            trial_id, adapter, authority.capability_id, authority.key))
    except BaseException:
        handle.stop()
        raise
    return session


def _request_and_revoke(
    session: _HandshakeSession, request: LiveHandshakeRequest,
    spec: TrialProxySpec, artifact_dir: Path, scan_policy: ScanPolicy,
) -> tuple[
    _HandshakeResponse | None, TrialRevocation, LiveHandshakePermitRefused | None,
]:
    sources = _artifact_sources(artifact_dir)
    inventory = _inventory(artifact_dir, sources, session.proxy)
    response = None
    request_error = None
    try:
        _write_run_artifacts(session, request, spec, sources)
        try:
            response = _perform_request(
                session.proxy, request, sources["response_diagnostic"], scan_policy)
        except LiveHandshakePermitRefused as error:
            request_error = error
    finally:
        revocation = revoke_trial_proxy(
            session.proxy, capture_inventory=lambda: inventory)
    return response, revocation, request_error


def _artifact_sources(artifact_dir: Path) -> dict[str, Path]:
    return {
        "run_config": artifact_dir / RUN_CONFIG_FILENAME,
        "request_metadata": artifact_dir / REQUEST_METADATA_FILENAME,
        "request_body": artifact_dir / REQUEST_BODY_FILENAME,
        "response_diagnostic": artifact_dir / RESPONSE_DIAGNOSTIC_FILENAME,
    }


def _write_run_artifacts(
    session: _HandshakeSession, request: LiveHandshakeRequest,
    spec: TrialProxySpec, sources: Mapping[str, Path],
) -> None:
    _write_json(sources["run_config"], _run_config(session, spec))
    _write_json(sources["request_metadata"], {
        "method": "POST", "target": request.target,
        "headers": dict(sorted(request.headers.items())),
    })
    sources["request_body"].write_bytes(request.body)


def _run_config(session: _HandshakeSession, spec: TrialProxySpec) -> dict[str, object]:
    authority = session.authority
    return {
        "schema_version": RUN_CONFIG_SCHEMA_VERSION,
        "capability_id": authority.capability_id,
        "capability_key": asdict(authority.key),
        "model": authority.model,
        "limits": dict(authority.limits),
        "proxy": {
            "request_body_limit_bytes": spec.request_body_limit_bytes,
            "response_body_limit_bytes": spec.response_body_limit_bytes,
            "retry": False,
        },
        "armed_at_epoch_ms": session.armed_at_ms,
        "absolute_deadline_epoch_ms": session.absolute_deadline_ms,
        "upstream_identity": session.upstream_identity,
    }


def _inventory(
    root: Path, sources: Mapping[str, Path], proxy: TrialProxySession,
) -> ArtifactInventory:
    declared = {**sources, **proxy.artifact_sources}
    return ArtifactInventory(declared, frozenset(declared), (root,))


def _scan_clean(inventory: ArtifactInventory, policy: ScanPolicy) -> bool:
    scan = scan_trial_artifacts(inventory, policy)
    if not scan.clean:
        raise LiveHandshakePermitRefused("live handshake artifact scan was not clean")
    return True


def _perform_request(session: TrialProxySession, request: LiveHandshakeRequest,
                     diagnostic_path: Path, scan_policy: ScanPolicy) -> _HandshakeResponse:
    endpoint = urlsplit(session.handle.base_url)
    connection = HTTPConnection(endpoint.hostname, endpoint.port, timeout=120)
    headers = dict(request.headers)
    headers["authorization"] = f"Bearer {session.handle.dummy_token}"
    status = None
    response_headers: tuple[tuple[str, str], ...] = ()
    body = bytearray()
    failure = None
    try:
        connection.request("POST", request.target, body=request.body, headers=headers)
        response = connection.getresponse()
        status = response.status
        response_headers = tuple(response.getheaders())
        captured = _capture_response(response, body)
        if captured.incomplete is not None:
            failure = type(captured.incomplete).__name__
        return captured
    except Exception as error:
        failure = type(error).__name__
        raise LiveHandshakePermitRefused(
            "live handshake provider request failed before completion") from error
    finally:
        try:
            _write_response_diagnostic(
                diagnostic_path, status, response_headers, bytes(body), failure, scan_policy)
        finally:
            connection.close()


def _capture_response(
    response: HTTPResponse, body: bytearray,
) -> _HandshakeResponse:
    try:
        _read_response(response, body)
    except IncompleteRead as error:
        return _HandshakeResponse(response.status, error)
    return _HandshakeResponse(response.status)


def _read_response(response: HTTPResponse, body: bytearray) -> None:
    while True:
        try:
            chunk = response.read1(64 * 1024)
        except IncompleteRead as error:
            body.extend(error.partial)
            raise IncompleteRead(bytes(body), error.expected) from error
        if not chunk:
            return
        body.extend(chunk)


def _write_response_diagnostic(
    path: Path, status: int | None, headers: tuple[tuple[str, str], ...],
    body: bytes, failure: str | None, policy: ScanPolicy,
) -> None:
    redacted_body = _redact_response_body(body, policy)
    _write_json(path, {
        "schema_version": RESPONSE_DIAGNOSTIC_SCHEMA_VERSION,
        "status": status,
        "headers": _redact_headers(headers, policy),
        "body_bytes_received": len(body),
        "body_base64": base64.b64encode(redacted_body).decode("ascii"),
        "body_latin1": redacted_body.decode("latin-1"),
        "complete": failure is None,
        "failure": failure,
    })


def _redact_headers(
    headers: tuple[tuple[str, str], ...], policy: ScanPolicy,
) -> list[list[str]]:
    return [
        [_redact_bytes(name.encode(), policy).decode(errors="replace"),
         "" if name.lower() in _SENSITIVE_RESPONSE_HEADERS else
         _redact_bytes(value.encode(), policy).decode(errors="replace")]
        for name, value in headers
    ]


def _redact_response_body(payload: bytes, policy: ScanPolicy) -> bytes:
    redacted = _redact_bytes(payload, policy)
    try:
        document = json.loads(redacted)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return redacted
    sanitized = _blank_provider_identifier_fields(document)
    return json.dumps(
        sanitized, ensure_ascii=False, separators=(",", ":"),
    ).encode("utf-8")


def _blank_provider_identifier_fields(value: object) -> object:
    if isinstance(value, Mapping):
        return {
            key: "" if _provider_identifier_body_key(key) else
            _blank_provider_identifier_fields(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_blank_provider_identifier_fields(item) for item in value]
    return value


def _provider_identifier_body_key(key: object) -> bool:
    if not isinstance(key, str):
        return False
    normalized = key.lower().replace("-", "_")
    return normalized in _PROVIDER_IDENTIFIER_BODY_KEYS


def _redact_bytes(payload: bytes, policy: ScanPolicy) -> bytes:
    redacted = payload
    literals = (
        *policy.secrets.values(), *policy.forbidden_environment.values(),
        *policy.forbidden_argv.values(), policy.repository_checkout,
        policy.hostname, *policy.host_identities.values(),
        *((policy.home_path,) if policy.home_path else ()),
    )
    for literal in sorted(literals, key=len, reverse=True):
        redacted = redacted.replace(literal.encode(), b"")
    return _HOME_PATH.sub(b"", redacted)


def _require_successful_response(response: _HandshakeResponse, export_path: Path) -> None:
    if response.incomplete is not None:
        outcome = _proxy_failure_outcome(export_path)
        raise LiveHandshakePermitRefused(
            f"live handshake proxy ended HTTP {response.status} response after "
            f"{len(response.incomplete.partial)} bytes: {outcome}"
        ) from response.incomplete
    if not 200 <= response.status < 300:
        raise LiveHandshakePermitRefused(
            f"live handshake provider request failed with HTTP {response.status}")


def _proxy_failure_outcome(path: Path) -> str:
    document = json.loads(path.read_bytes())
    audit = _available_value(document, "audit_log")
    outcomes = audit.get("outcomes") if isinstance(audit, Mapping) else None
    if not isinstance(outcomes, Mapping):
        return "proxy_outcome_unavailable"
    observed = [
        outcome for outcome, count in outcomes.items()
        if isinstance(outcome, str) and count == 1
    ]
    return observed[0] if len(observed) == 1 else "proxy_outcome_unavailable"


def _complete(
    session: _HandshakeSession, revocation: TrialRevocation, scan_clean: bool,
    evidence_dir: Path, implementation_commit: str, request_body: bytes,
    conservative_cost_usd: str,
) -> Path:
    if not scan_clean:
        raise LiveHandshakePermitRefused("live handshake artifact scan was not clean")
    if not _revocation_proven(revocation.revocation, session.proxy.handle.trial_id):
        raise LiveHandshakePermitRefused("live handshake proxy revocation was not proven")
    request_count, input_tokens, output_tokens = _accounting(
        revocation.export_path, session)
    record = _evidence_record(
        session, implementation_commit, request_body, conservative_cost_usd,
        request_count, input_tokens, output_tokens,
    )
    path = evidence_dir / f"{session.authority.capability_id}.live-handshake-passed.json"
    _write_validated_evidence(path, record, session)
    return path


def _accounting(path: Path, session: _HandshakeSession) -> tuple[int, int, int]:
    document = json.loads(path.read_bytes())
    expected = {
        "schema_version": "cortex-bench-proxy-export/1",
        "trial_id": session.proxy.handle.trial_id,
        "adapter_id": session.adapter_id,
        "source": "proxy_export",
    }
    if any(document.get(field) != value for field, value in expected.items()):
        raise LiveHandshakePermitRefused("live handshake proxy export identity differs")
    audit = _available_value(document, "audit_log")
    if not isinstance(audit, Mapping) or audit.get("agrees_with_counters") is not True:
        raise LiveHandshakePermitRefused("live handshake proxy accounting did not agree")
    if audit.get("durable_requests") != 1 or audit.get("outcomes") != {}:
        raise LiveHandshakePermitRefused("live handshake proxy recorded a failed request")
    counters = tuple(
        _counter(_available_value(document, field), field)
        for field in ("requests", "input_tokens", "output_tokens"))
    if counters[0] != 1:
        raise LiveHandshakePermitRefused("live handshake did not account exactly one request")
    return counters


def _available_value(document: Mapping[str, object], field: str) -> object:
    slot = document.get(field)
    if not isinstance(slot, Mapping) or slot.get("status") != "available":
        raise LiveHandshakePermitRefused(
            f"live handshake proxy {field} was unavailable")
    return slot.get("value")


def _counter(value: object, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise LiveHandshakePermitRefused(
            f"live handshake proxy {field} counter was invalid")
    return value


def _revocation_proven(record: Mapping[str, object], trial_id: str) -> bool:
    return record == {
        "schema_version": "cortex-bench-proxy-revocation/1",
        "trial_id": trial_id,
        "route_active": False,
        "listener_present": False,
        "serving_thread_alive": False,
        "active_handlers": 0,
        "body_handlers": 0,
    }


def _evidence_record(
    session: _HandshakeSession, implementation_commit: str, request_body: bytes,
    conservative_cost_usd: str, request_count: int, input_tokens: int, output_tokens: int,
) -> dict[str, object]:
    _cost(conservative_cost_usd)
    authority = session.authority
    return {
        "schema_version": CAPABILITY_EVIDENCE_SCHEMA_VERSION,
        "capability_id": authority.capability_id,
        "state": "live-handshake-passed",
        "capability_key": asdict(authority.key),
        "adapter_id": session.adapter_id,
        "implementation_commit": implementation_commit,
        **authority.metadata,
        "run_config_sha256": _sha256(
            (session.proxy.proxy_dir.parent / RUN_CONFIG_FILENAME).read_bytes()),
        "request_sha256": _sha256(request_body),
        "request_count": request_count,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "conservative_cost_usd": conservative_cost_usd,
        "scan_clean": True,
        "revocation_proven": True,
        "upstream_identity": session.upstream_identity,
    }


def _cost(value: str) -> Decimal:
    try:
        parsed = Decimal(value)
    except (InvalidOperation, TypeError) as error:
        raise LiveHandshakePermitRefused("conservative cost must be a decimal string") from error
    if not isinstance(value, str) or not parsed.is_finite() or parsed < 0:
        raise LiveHandshakePermitRefused("conservative cost must be a nonnegative decimal string")
    return parsed


def _write_validated_evidence(
    path: Path, record: Mapping[str, object], session: _HandshakeSession,
) -> None:
    payload = json.dumps(record, sort_keys=True, separators=(",", ":")).encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_bytes(payload)
    try:
        validate_capability_evidence(
            temporary, _sha256(payload),
            capability_id=session.authority.capability_id,
            key=session.authority.key, state="live-handshake-passed",
            adapter_id=session.adapter_id,
        )
        temporary.replace(path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _upstream_identity(upstream_base_url: str) -> str:
    target = urlsplit(upstream_base_url)
    return f"{target.netloc}{target.path.rstrip('/')}"


def _epoch(epoch_ms: int) -> datetime:
    return datetime(1970, 1, 1, tzinfo=UTC) + timedelta(milliseconds=epoch_ms)


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()
