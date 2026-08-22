# input:  one suite-wide admitted request ceiling
# output: thread-safe reservation and release decisions
# pos:    Cross-route request-count limiter
# >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import threading


class SharedRequestLimit:
    """Shares only a request ceiling; route lifecycle and locks remain per trial."""

    def __init__(self, maximum: int) -> None:
        if isinstance(maximum, bool) or not isinstance(maximum, int) or maximum <= 0:
            raise ValueError("shared request maximum must be a positive integer")
        self.maximum = maximum
        self._used = 0
        self._lock = threading.Lock()

    @property
    def used(self) -> int:
        with self._lock:
            return self._used

    def reserve(self) -> bool:
        with self._lock:
            if self._used >= self.maximum:
                return False
            self._used += 1
            return True

    def release(self) -> None:
        with self._lock:
            if self._used <= 0:
                raise RuntimeError("shared request reservation underflow")
            self._used -= 1
