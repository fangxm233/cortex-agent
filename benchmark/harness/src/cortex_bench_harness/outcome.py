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
from .launcher.production_session import (
    DEADLINE_EXHAUSTED,
    DEADLINE_REASON,
    SESSION_OUTCOME_SCHEMA_VERSION,
)

TERMINAL_SUCCESS = "terminal-success"
TERMINAL_AGENT_FAILURE = "terminal-agent-failure"
TERMINAL_VERIFIER_FAILURE = "terminal-verifier-failure"
HARNESS_INCOMPLETE = "harness-incomplete"
SECURITY_FAILED = "security-failed"
SCORE_AVAILABLE = "available"
SCORE_FAILED = "failed"
SCORE_UNAVAILABLE = "unavailable"
REVOCATION_SCHEMA_VERSION = "cortex-bench-proxy-revocation/1"
# The report a Terminal-Bench `tests/test.sh` asks pytest for, on the verifier's own log root.
# Harbor knows nothing about it -- it reads reward.json, then reward.txt, and nothing else -- so
# this is the only place the DISTINCTION below is available at all.
VERIFIER_ROOT = "verifier"
VERIFIER_CTRF = "ctrf.json"
_REQUIRED_ROOTS = frozenset({"agent", "verifier", "artifacts"})
_THREAD_FAILURE_STATUSES = frozenset({"failed", "cancelled", "aborted"})
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
    requests: int | None


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
        if rewards is not None:
            unmeasured = _unmeasured_reason(self._trial_root)
            if unmeasured is not None:
                return self._outcome(
                    TERMINAL_VERIFIER_FAILURE, SCORE_UNAVAILABLE, unmeasured, envelope=envelope)
        exception = result.get("exception_info")
        if exception is not None:
            return self._exception_outcome(exception, rewards, envelope)
        agent_failure = _agent_failure_reason(envelope.document)
        if agent_failure is not None:
            return self._outcome(
                TERMINAL_AGENT_FAILURE,
                SCORE_AVAILABLE if rewards is not None else SCORE_FAILED,
                agent_failure, rewards=rewards, envelope=envelope,
            )
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


def _unmeasured_reason(trial_root: Path) -> str | None:
    """Why this trial's reward is not a measurement of the agent, or None if it is one.

    A reward of 0 has meant two unrelated things and the difference was invisible. An upstream
    `tests/test.sh` ends `if [ $? -eq 0 ]; then echo 1 > reward.txt; else echo 0 > reward.txt; fi`,
    so pytest exiting 2 because it could not IMPORT numpy writes the same 0 as pytest exiting 1
    because the agent's answer was wrong. Harbor reads that file and nothing else, so both arrive
    here as `terminal-success, reward 0` -- and 241 of them did on 2026-08-27, which is how a
    verifier that never started got counted as a fleet of agents that failed.

    The CTRF report separates them, measured on this host: an import failure at collection time
    exits 2 and writes a report of 0 tests, a failed assertion exits 1 and writes a report of 1
    test with 1 failure, and a pass exits 0 and writes 1 test with 1 pass. So a report that names
    zero tests is a verifier that never ran one, whatever the reward file says.

    Read only, never inferred. No report at all leaves the reward alone: a task whose test script
    does not ask for `--ctrf` would otherwise be condemned for a file it never promised, and this
    reader has no way to tell that task from one whose verifier died before pytest. That case is
    what the pre-agent gate exists to catch instead.
    """
    document, _ = _read_mapping(trial_root / VERIFIER_ROOT / VERIFIER_CTRF, "verifier CTRF report")
    if document is None:
        return None
    results = document.get("results")
    summary = results.get("summary") if isinstance(results, Mapping) else None
    tests = summary.get("tests") if isinstance(summary, Mapping) else None
    if not isinstance(tests, int) or isinstance(tests, bool) or tests > 0:
        return None
    return (
        f"verifier published {VERIFIER_ROOT}/{VERIFIER_CTRF} reporting 0 tests, so it never ran "
        "one and its reward measures the verifier rather than the agent")


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
        _agent_outcome_reason,
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
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return None
    if _deadline_outcome(envelope) and _unavailable_evidence(value):
        return None
    return "outer envelope has no valid proxy_usage.requests evidence"


def _unavailable_evidence(value: object) -> bool:
    return (
        isinstance(value, Mapping) and value.get("status") == "unavailable"
        and isinstance(value.get("reason"), str) and bool(value["reason"])
    )


def _agent_outcome_reason(
    envelope: Mapping[str, object], trial_id: str, _arm_name: str,
) -> str | None:
    outcome = envelope.get("agent_outcome")
    if outcome is None:
        return None
    if not isinstance(outcome, Mapping):
        return "outer envelope agent_outcome must be an object"
    expected = {
        "schema_version": SESSION_OUTCOME_SCHEMA_VERSION,
        "trial_id": trial_id, "terminal": True,
    }
    status = outcome.get("status")
    reason = outcome.get("terminal_reason")
    valid_terminal = (
        status == DEADLINE_EXHAUSTED and reason == DEADLINE_REASON
        or isinstance(status, str) and status in _THREAD_FAILURE_STATUSES
        and reason == f"thread_{status}"
    )
    if any(outcome.get(key) != value for key, value in expected.items()) or not valid_terminal:
        return "outer envelope agent_outcome is invalid"
    thread_id = outcome.get("thread_id")
    if not isinstance(thread_id, str) or not thread_id:
        return "outer envelope agent_outcome has no thread_id"
    return None


def _agent_failure_reason(envelope: Mapping[str, object]) -> str | None:
    outcome = envelope.get("agent_outcome")
    if not isinstance(outcome, Mapping):
        return None
    reason = outcome.get("terminal_reason")
    return reason if isinstance(reason, str) else None


def _deadline_outcome(envelope: Mapping[str, object]) -> bool:
    outcome = envelope.get("agent_outcome")
    return isinstance(outcome, Mapping) and outcome.get("status") == DEADLINE_EXHAUSTED


def _publication_reason(
    envelope: Mapping[str, object], _trial_id: str, _arm_name: str,
) -> str | None:
    publication = envelope.get("publication")
    if not isinstance(publication, Mapping):
        return "outer envelope publication marker is unavailable"
    if (
        publication.get("root") != "artifacts"
        or publication.get("relative_path") != OUTER_ENVELOPE_FILENAME
        or publication.get("atomic") is not True
        or publication.get("post_publication_reread") is not True
    ):
        return "outer envelope publication marker is incomplete"
    return None


def _request_count(envelope: Mapping[str, object]) -> int | None:
    usage = envelope["proxy_usage"]
    assert isinstance(usage, Mapping)
    value = usage["requests"]
    return value if isinstance(value, int) and not isinstance(value, bool) else None


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
    entries = [
        (item.get("root"), item.get("status")) if isinstance(item, Mapping)
        else (None, None)
        for item in roots
    ]
    if any(
        not isinstance(root, str) or not isinstance(status, str)
        for root, status in entries
    ):
        return "evidence root records are malformed"
    if (
        len(entries) != len(_REQUIRED_ROOTS)
        or {root for root, _ in entries} != _REQUIRED_ROOTS
    ):
        return "evidence root records are malformed"
    if any(status not in {"collected", "unavailable"} for _, status in entries):
        return "evidence root records are malformed"
    return None


def _scan_reason(envelope: Mapping[str, object]) -> str | None:
    scan = envelope.get("leak_scan")
    if not isinstance(scan, Mapping):
        return "leak scan is unavailable"
    if scan.get("matches") != []:
        return "leak scan has matches or is malformed"
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
