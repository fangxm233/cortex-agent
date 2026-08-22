# input:  ordered task ids, bounded slots, one task executor
# output: ordered one-attempt outcomes with bounded concurrency
# pos:    Full-suite task scheduler
# >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

from __future__ import annotations

from collections.abc import Callable, Sequence
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from queue import Queue


@dataclass(frozen=True)
class TaskOutcome:
    task_id: str
    slot: int
    state: str
    detail: str | None = None


def run_tasks(
    task_ids: Sequence[str], *, concurrency: int,
    execute: Callable[[str, int], TaskOutcome], on_cancel: Callable[[], None] | None = None,
) -> list[TaskOutcome]:
    if concurrency <= 0:
        raise ValueError("concurrency must be positive")
    slots = _slots(concurrency)
    pool = ThreadPoolExecutor(max_workers=concurrency)
    pending: dict[Future[TaskOutcome], int] = {}
    next_index = _fill(pool, pending, task_ids, 0, concurrency, slots, execute)
    outcomes: dict[int, TaskOutcome] = {}
    try:
        while pending:
            next_index = _complete_one(
                pool, pending, outcomes, task_ids, next_index, slots, execute)
    except BaseException:
        if on_cancel is not None:
            on_cancel()
        pool.shutdown(wait=True, cancel_futures=True)
        raise
    pool.shutdown(wait=True)
    return [outcomes[index] for index in range(len(task_ids))]


def _complete_one(
    pool: ThreadPoolExecutor, pending: dict[Future[TaskOutcome], int],
    outcomes: dict[int, TaskOutcome], task_ids: Sequence[str], next_index: int,
    slots: Queue[int], execute: Callable[[str, int], TaskOutcome],
) -> int:
    completed, _ = wait(tuple(pending), return_when=FIRST_COMPLETED)
    for future in completed:
        outcomes[pending.pop(future)] = future.result()
    return _fill(pool, pending, task_ids, next_index, len(completed), slots, execute)


def _fill(
    pool: ThreadPoolExecutor, pending: dict[Future[TaskOutcome], int],
    task_ids: Sequence[str], index: int, count: int, slots: Queue[int],
    execute: Callable[[str, int], TaskOutcome],
) -> int:
    for _ in range(count):
        if index >= len(task_ids):
            break
        future = pool.submit(_execute_in_slot, slots, execute, task_ids[index])
        pending[future] = index
        index += 1
    return index


def _slots(concurrency: int) -> Queue[int]:
    slots: Queue[int] = Queue()
    for slot in range(concurrency):
        slots.put(slot)
    return slots


def _execute_in_slot(
    slots: Queue[int], execute: Callable[[str, int], TaskOutcome], task_id: str,
) -> TaskOutcome:
    slot = slots.get()
    try:
        return execute(task_id, slot)
    finally:
        slots.put(slot)
