# input:  one Harbor trial root and its declared trial identity
# output: terminal outcome, canonical verifier rewards, score status
# pos:    Trial result and outer-envelope outcome reader
# >>> If I am updated, update my header and folder CORTEX.md <<<

import hashlib
import json
import math
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from .host_finalization import OUTER_ENVELOPE_FILENAME, OUTER_ENVELOPE_SCHEMA_VERSION

TERMINAL_SUCCESS = "terminal-success"
TERMINAL_AGENT_FAILURE = "terminal-agent-failure"
TERMINAL_VERIFIER_FAILURE = "terminal-verifier-failure"
HARNESS_INCOMPLETE = "harness-incomplete"
SECURITY_FAILED = "security-failed"
SCORE_AVAILABLE = "available"
SCORE_FAILED = "failed"
SCORE_UNAVAILABLE = "unavailable"
REVOCATION_SCHEMA_VERSION = "cortex-bench-proxy-revocation/1"
_REQUIRED_ROOTS = frozenset({"agent", "verifier", "artifacts"})
_AGENT_EXCEPTION_TYPES = frozenset({
    "AgentTimeoutError", "NonZeroAgentExitCodeError", "ApiError",
    "ApiRateLimitError", "ApiUsageLimitError", "ApiInternalServerError",
    "ApiOverloadedError", "ApiConnectionClosedError", "ApiResponseStalledError",
    "OutputTokenExceededError", "ContextWindowExceededError", "UnknownApiError",
    "ApiProviderResourceNotFoundError", "AgentSafetyRefusalError",
    "AgentAuthenticationError", "ModelNotFoundError", "NetworkConnectionError",
})


@dataclass(frozen=True)
class ReadOutcome:
    outcome_state: str
    verifier_rewards: Mapping[str, int | float] | None
    score_status: str
    reason: str | None
    envelope: Mapping[str, object] | None = None
    envelope_path: Path | None = None
    envelope_sha256: str | None = None
    requests: int | None = None


@dataclass(frozen=True)
class _Envelope:
    document: Mapping[str, object]
    path: Path
    sha256: str
    requests: int


class TrialOutcomeReader:
    def __init__(self, *, trial_id: str, arm_name: str, trial_root: Path) -> None:
        self._trial_id = trial_id
        self._arm_name = arm_name
        self._trial_root = trial_root

    def read(self) -> ReadOutcome:
        envelope, reason = self._read_envelope()
        if envelope is None:
            return self._outcome(HARNESS_INCOMPLETE, SCORE_UNAVAILABLE, reason)
        security_reason = _security_reason(envelope.document, self._trial_id)
        if security_reason is not None:
            return self._outcome(
                SECURITY_FAILED, SCORE_UNAVAILABLE, security_reason, envelope=envelope)
        result, reason = _read_mapping(self._trial_root / "result.json", "Harbor result")
        if result is None:
            return self._outcome(
                HARNESS_INCOMPLETE, SCORE_UNAVAILABLE, reason, envelope=envelope)
        return self._result_outcome(result, envelope)

    def _read_envelope(self) -> tuple[_Envelope | None, str | None]:
        path = self._trial_root / "artifacts" / OUTER_ENVELOPE_FILENAME
        document, reason, payload = _read_mapping_with_payload(path, "outer envelope")
        if document is None or payload is None:
            return None, reason
        reason = _envelope_reason(document, self._trial_id, self._arm_name)
        if reason is not None:
            return None, reason
        requests = _request_count(document)
        return _Envelope(
            document=document, path=path, sha256=hashlib.sha256(payload).hexdigest(),
            requests=requests,
        ), None

    def _result_outcome(
        self, result: Mapping[str, object], envelope: _Envelope,
    ) -> ReadOutcome:
        rewards, reward_reason = _rewards(result)
        exception = result.get("exception_info")
        if exception is not None:
            return self._exception_outcome(exception, rewards, envelope)
        if rewards is None:
            return self._outcome(
                TERMINAL_VERIFIER_FAILURE, SCORE_UNAVAILABLE, reward_reason,
                envelope=envelope,
            )
        return self._outcome(
            TERMINAL_SUCCESS, SCORE_AVAILABLE, None, rewards=rewards, envelope=envelope)

    def _exception_outcome(
        self, exception: object, rewards: Mapping[str, int | float] | None,
        envelope: _Envelope,
    ) -> ReadOutcome:
        reason = _exception_reason(exception)
        if rewards is not None:
            return self._outcome(
                TERMINAL_AGENT_FAILURE, SCORE_AVAILABLE, reason,
                rewards=rewards, envelope=envelope,
            )
        state = TERMINAL_AGENT_FAILURE if _agent_exception(exception) else (
            TERMINAL_VERIFIER_FAILURE)
        return self._outcome(state, SCORE_FAILED, reason, envelope=envelope)

    def _outcome(
        self, state: str, score_status: str, reason: str | None, *,
        rewards: Mapping[str, int | float] | None = None,
        envelope: _Envelope | None = None,
    ) -> ReadOutcome:
        return ReadOutcome(
            outcome_state=state, verifier_rewards=rewards,
            score_status=score_status, reason=reason,
            envelope=None if envelope is None else envelope.document,
            envelope_path=None if envelope is None else envelope.path,
            envelope_sha256=None if envelope is None else envelope.sha256,
            requests=None if envelope is None else envelope.requests,
        )


def _read_mapping(path: Path, label: str) -> tuple[Mapping[str, object] | None, str | None]:
    document, reason, _ = _read_mapping_with_payload(path, label)
    return document, reason


def _read_mapping_with_payload(
    path: Path, label: str,
) -> tuple[Mapping[str, object] | None, str | None, bytes | None]:
    try:
        payload = path.read_bytes()
        document = json.loads(payload)
    except (OSError, ValueError) as error:
        return None, f"published no readable {label} {path}: {error}", None
    if not isinstance(document, Mapping):
        return None, f"published a non-mapping {label} {path}", payload
    return document, None, payload


def _envelope_reason(
    envelope: Mapping[str, object], trial_id: str, arm_name: str,
) -> str | None:
    if envelope.get("schema_version") != OUTER_ENVELOPE_SCHEMA_VERSION:
        return "outer envelope schema_version is unsupported"
    for validator in (
        _identity_reason, _admission_reason, _requests_reason, _publication_reason,
    ):
        reason = validator(envelope, trial_id, arm_name)
        if reason is not None:
            return reason
    return None


def _identity_reason(
    envelope: Mapping[str, object], trial_id: str, arm_name: str,
) -> str | None:
    identity = envelope.get("identity")
    identity = identity if isinstance(identity, Mapping) else {}
    declared = (identity.get("trial_id"), identity.get("arm_name"))
    if declared != (trial_id, arm_name):
        return f"outer envelope identifies trial {declared[0]!r} on arm {declared[1]!r}"
    return None


def _admission_reason(
    envelope: Mapping[str, object], _trial_id: str, _arm_name: str,
) -> str | None:
    admission = envelope.get("grader_admission")
    admitted = admission.get("admitted") if isinstance(admission, Mapping) else None
    if not isinstance(admitted, bool):
        return "outer envelope must state grader_admission.admitted"
    return None


def _requests_reason(
    envelope: Mapping[str, object], _trial_id: str, _arm_name: str,
) -> str | None:
    usage = envelope.get("proxy_usage")
    value = usage.get("requests") if isinstance(usage, Mapping) else None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return "outer envelope has no proxy_usage.requests count"
    return None


def _publication_reason(
    envelope: Mapping[str, object], _trial_id: str, _arm_name: str,
) -> str | None:
    publication = envelope.get("publication")
    expected = {
        "root": "artifacts", "relative_path": OUTER_ENVELOPE_FILENAME,
        "atomic": True, "post_publication_reread": True,
    }
    if not isinstance(publication, Mapping):
        return "outer envelope publication marker is unavailable"
    if any(publication.get(key) != value for key, value in expected.items()):
        return "outer envelope publication marker is incomplete"
    return None


def _request_count(envelope: Mapping[str, object]) -> int:
    usage = envelope["proxy_usage"]
    assert isinstance(usage, Mapping)
    value = usage["requests"]
    assert isinstance(value, int) and not isinstance(value, bool)
    return value


def _security_reason(envelope: Mapping[str, object], trial_id: str) -> str | None:
    for validator in (_roots_reason, _scan_reason):
        reason = validator(envelope)
        if reason is not None:
            return reason
    return _revocation_reason(envelope, trial_id)


def _roots_reason(envelope: Mapping[str, object]) -> str | None:
    evidence = envelope.get("evidence")
    roots = evidence.get("roots") if isinstance(evidence, Mapping) else None
    if not isinstance(roots, list):
        return "evidence roots are unavailable"
    collected = {
        item.get("root") for item in roots
        if isinstance(item, Mapping) and item.get("status") == "collected"
    }
    if not _REQUIRED_ROOTS <= collected:
        return "evidence roots were not all collected"
    return None


def _scan_reason(envelope: Mapping[str, object]) -> str | None:
    scan = envelope.get("leak_scan")
    if not isinstance(scan, Mapping):
        return "leak scan is unavailable"
    if scan.get("ok") is not True or scan.get("clean") is not True:
        return "leak scan is not clean"
    for field in ("matches", "missing_sources", "unclassified_files"):
        if scan.get(field) != []:
            return f"leak scan {field} is not empty"
    return None


def _revocation_reason(envelope: Mapping[str, object], trial_id: str) -> str | None:
    revocation = envelope.get("revocation")
    if not isinstance(revocation, Mapping):
        return "proxy revocation is unavailable"
    if (
        revocation.get("schema_version") != REVOCATION_SCHEMA_VERSION
        or revocation.get("trial_id") != trial_id
    ):
        return "proxy revocation is untrustworthy"
    boolean_fields = ("route_active", "listener_present", "serving_thread_alive")
    if any(revocation.get(field) is not False for field in boolean_fields):
        return "proxy revocation is untrustworthy"
    for field in ("active_handlers", "body_handlers"):
        value = revocation.get(field)
        if isinstance(value, bool) or not isinstance(value, int) or value != 0:
            return "proxy revocation is untrustworthy"
    return None


def _rewards(
    result: Mapping[str, object],
) -> tuple[Mapping[str, int | float] | None, str | None]:
    verifier = result.get("verifier_result")
    if not isinstance(verifier, Mapping):
        return None, "published no verifier result"
    rewards = verifier.get("rewards")
    if not isinstance(rewards, Mapping) or not rewards:
        return None, "published no verifier rewards"
    if any(not _finite_number(value) for value in rewards.values()):
        return None, "published a non-finite or non-numeric verifier reward"
    return cast(dict[str, int | float], dict(rewards)), None


def _finite_number(value: object) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def _agent_exception(exception: object) -> bool:
    if not isinstance(exception, Mapping):
        return False
    return exception.get("exception_type") in _AGENT_EXCEPTION_TYPES


def _exception_reason(exception: object) -> str:
    if not isinstance(exception, Mapping):
        return str(exception)
    kind = exception.get("exception_type", "unknown")
    message = exception.get("exception_message", "unknown")
    return f"{kind}: {message}"
