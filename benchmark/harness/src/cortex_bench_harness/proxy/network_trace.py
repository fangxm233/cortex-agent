# input:  trial identity, monotonic/wall clocks, content-free phase facts
# output: durable per-request network phase JSONL and completeness state
# pos:    Proxy network-stall observability
# >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

from __future__ import annotations

import json
import os
import threading
import time
from collections.abc import Callable, Mapping
from pathlib import Path

NETWORK_TRACE_SCHEMA_VERSION = "cortex-bench-network-trace/1"


def append_json_line(
    path: Path, record: Mapping[str, object], *, durable: bool,
) -> None:
    line = json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n"
    with path.open("a", encoding="utf-8") as handle:
        handle.write(line)
        handle.flush()
        if durable:
            os.fsync(handle.fileno())


class NetworkTrace:
    def __init__(
        self, path: Path, trial_id: str, *, progress_interval_seconds: float = 10,
        wall_ms: Callable[[], int] | None = None,
        monotonic_ns: Callable[[], int] | None = None,
    ) -> None:
        self.path = path
        self.trial_id = trial_id
        self._wall_ms = wall_ms or (lambda: time.time_ns() // 1_000_000)
        self._monotonic_ns = monotonic_ns or time.monotonic_ns
        self._started_ns = self._monotonic_ns()
        self._progress_ns = max(int(progress_interval_seconds * 1_000_000_000), 1)
        self._lock = threading.Lock()
        self._sequence = 0
        self._request_id = 0
        self._complete = True
        path.parent.mkdir(parents=True, exist_ok=True)
        self._write("proxy_started", None, {}, durable=True, required=True)

    @property
    def complete(self) -> bool:
        with self._lock:
            return self._complete

    def start_request(self) -> "RequestTrace":
        with self._lock:
            self._request_id += 1
            request_id = self._request_id
        trace = RequestTrace(self, request_id, self._progress_ns)
        trace.event("model_post_observed", durable=True)
        return trace

    def finalize(self) -> None:
        self._write("proxy_finalized", None, {}, durable=True)

    def emit(
        self, phase: str, request_id: int, metrics: Mapping[str, object],
        *, durable: bool = False,
    ) -> None:
        self._write(phase, request_id, metrics, durable=durable)

    def _write(
        self, phase: str, request_id: int | None, metrics: Mapping[str, object],
        *, durable: bool, required: bool = False,
    ) -> None:
        with self._lock:
            record = self._record(phase, request_id, metrics)
            try:
                append_json_line(self.path, record, durable=durable)
            except OSError:
                self._complete = False
                if required:
                    raise

    def _record(
        self, phase: str, request_id: int | None, metrics: Mapping[str, object],
    ) -> dict[str, object]:
        self._sequence += 1
        now_ns = self._monotonic_ns()
        record: dict[str, object] = {
            "schema_version": NETWORK_TRACE_SCHEMA_VERSION,
            "trial_id": self.trial_id,
            "sequence": self._sequence,
            "epoch_ms": self._wall_ms(),
            "elapsed_ms": (now_ns - self._started_ns) // 1_000_000,
            "phase": phase,
        }
        if request_id is not None:
            record["request_id"] = request_id
        record.update(metrics)
        return record


class RequestTrace:
    def __init__(self, trace: NetworkTrace, request_id: int, progress_ns: int) -> None:
        self._trace = trace
        self.request_id = request_id
        self._progress_ns = progress_ns
        self._last_chunk_ns: int | None = None
        self._last_progress_ns: int | None = None
        self._chunks = 0
        self._bytes = 0
        self._max_gap_ms = 0
        self._downstream_reported = False

    def event(
        self, phase: str, *, durable: bool = False, **metrics: object,
    ) -> None:
        self._trace.emit(phase, self.request_id, metrics, durable=durable)

    def stream_chunk(self, size: int) -> None:
        now_ns = time.monotonic_ns()
        self._update_stream_counters(size, now_ns)
        if self._chunks == 1:
            self.event("response_stream_first", bytes=self._bytes, chunks=self._chunks)
            self._last_progress_ns = now_ns
            return
        if now_ns - (self._last_progress_ns or now_ns) >= self._progress_ns:
            self.event("response_stream_progress", **self._stream_metrics())
            self._last_progress_ns = now_ns

    def stream_eof(self) -> None:
        self.event("response_stream_eof", durable=True, **self._stream_metrics())

    def downstream_returned(self) -> None:
        if self._downstream_reported:
            return
        self._downstream_reported = True
        self.event("downstream_socket_write_returned")

    def downstream_failed(self) -> None:
        if self._downstream_reported:
            return
        self._downstream_reported = True
        self.event("downstream_socket_write_failed", durable=True)

    def terminal(self, outcome: str) -> None:
        self.event("request_terminal", durable=True, outcome=outcome)

    def _update_stream_counters(self, size: int, now_ns: int) -> None:
        if self._last_chunk_ns is not None:
            gap_ms = (now_ns - self._last_chunk_ns) // 1_000_000
            self._max_gap_ms = max(self._max_gap_ms, gap_ms)
        self._last_chunk_ns = now_ns
        self._chunks += 1
        self._bytes += size

    def _stream_metrics(self) -> dict[str, int]:
        return {
            "bytes": self._bytes,
            "chunks": self._chunks,
            "max_inter_chunk_gap_ms": self._max_gap_ms,
        }
