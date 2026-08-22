# input:  Harbor commands, allowlisted env and cancellation requests
# output: tracked process groups with bounded TERM-to-KILL cleanup
# pos:    Full-suite Harbor process registry
# >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import BinaryIO


class ProcessRegistry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._processes: set[subprocess.Popen[bytes]] = set()
        self._cancelled = False

    def run(
        self, command: list[str], *, cwd: Path, env: dict[str, str],
        stdout: BinaryIO, stderr: BinaryIO,
    ) -> int:
        with self._lock:
            if self._cancelled:
                raise RuntimeError("full-suite process launch is cancelled")
            process = subprocess.Popen(
                command, cwd=cwd, env=env, stdout=stdout, stderr=stderr,
                start_new_session=True,
            )
            self._processes.add(process)
        try:
            return process.wait()
        finally:
            with self._lock:
                self._processes.discard(process)

    def cancel_all(self, grace_seconds: float = 5) -> None:
        with self._lock:
            self._cancelled = True
            processes = tuple(self._processes)
        for process in processes:
            _signal_group(process, signal.SIGTERM)
        deadline = time.monotonic() + grace_seconds
        while time.monotonic() < deadline and any(p.poll() is None for p in processes):
            time.sleep(0.05)
        for process in processes:
            _signal_group(process, signal.SIGKILL)


def _signal_group(process: subprocess.Popen[bytes], signal_number: signal.Signals) -> None:
    try:
        os.killpg(process.pid, signal_number)
    except ProcessLookupError:
        return
