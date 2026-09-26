import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import type { TabData } from '../hooks/useDashboardData.js';
import type { MutateResult, MutateError } from '../hooks/useMutate.js';
import { ConfirmModal } from './ConfirmModal.js';
import { computeFocusWindow } from '../logic.js';
import { DASHBOARD_MAX_VISIBLE_ROWS } from './dashboard-constants.js';

// ── Types ──

interface DashboardTasksTabProps {
  data: TabData;
  mutate?: (op: string, args: Record<string, unknown>) => Promise<MutateResult>;
  projectId?: string;
  /** Whether the dashboard owns the keyboard. Defaults true for standalone tests. */
  active?: boolean;
}

type ConfirmMode = 'complete' | 'block' | null;

// ── Component ──

export function DashboardTasksTab({ data, mutate, projectId, active = true }: DashboardTasksTabProps): React.JSX.Element {
  if (data.loading && data.data.length === 0) {
    return <Text dimColor>Loading tasks...</Text>;
  }
  if (data.error) {
    return <Text color="red">Error: {data.error}</Text>;
  }
  if (data.data.length === 0) {
    return <Text dimColor>No tasks</Text>;
  }

  return <TasksList data={data} mutate={mutate} projectId={projectId} active={active} />;
}

// ── Tasks List ──

function TasksList({ data, mutate, projectId, active = true }: DashboardTasksTabProps): React.JSX.Element {
  const tasks = data.data as any[];
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [confirmingIndex, setConfirmingIndex] = useState<number | null>(null);
  const [confirmMode, setConfirmMode] = useState<ConfirmMode>(null);

  // Refs for stale-closure-safe access inside useInput / callbacks
  const confirmingIndexRef = useRef<number | null>(null);
  const confirmModeRef = useRef<ConfirmMode>(null);
  const focusedIndexRef = useRef(0);
  focusedIndexRef.current = focusedIndex;
  const mutateRef = useRef(mutate);
  mutateRef.current = mutate;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  // ── Error state with 5s auto-clear ──

  const [errorState, setErrorState] = useState<{ index: number; code: string; message: string } | null>(null);
  const [lockBusyRows, setLockBusyRows] = useState<Set<number>>(new Set());
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lockBusyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showError = useCallback((index: number, code: string, message: string) => {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    setErrorState({ index, code, message });
    errorTimerRef.current = setTimeout(() => {
      setErrorState(null);
      errorTimerRef.current = null;
    }, 5000);
  }, []);

  const showLockBusy = useCallback((index: number) => {
    if (lockBusyTimerRef.current) clearTimeout(lockBusyTimerRef.current);
    setLockBusyRows(new Set([index]));
    lockBusyTimerRef.current = setTimeout(() => {
      setLockBusyRows(new Set());
      lockBusyTimerRef.current = null;
    }, 5000);
  }, []);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      if (lockBusyTimerRef.current) clearTimeout(lockBusyTimerRef.current);
    };
  }, []);

  // Clamp focused index when data shrinks
  useEffect(() => {
    if (tasks.length > 0 && focusedIndex >= tasks.length) {
      setFocusedIndex(tasks.length - 1);
    }
  }, [tasks.length, focusedIndex]);

  // ── Mutate result handler ──

  const handleResult = useCallback((index: number) => (result: MutateResult) => {
    if (!result.ok) {
      const err = result as MutateError;
      if (err.error.code === 'task-lock-busy') {
        showLockBusy(index);
      } else {
        showError(index, err.error.code, err.error.message);
      }
    }
    // Success: subscribe will refresh data — no explicit action needed
  }, [showError, showLockBusy]);

  // ── Mutate helpers ──

  const doMutate = useCallback((op: string, taskId: string, extra?: Record<string, unknown>) => {
    const fn = mutateRef.current;
    if (!fn) return;
    const args: Record<string, unknown> = { projectId: projectIdRef.current, taskId, ...extra };
    fn(op, args).then(handleResult(focusedIndexRef.current));
  }, [handleResult]);

  // ── Keyboard handler ──

  const isInputActive = active && confirmingIndex === null && tasks.length > 0;

  useInput((input, key) => {
    if (confirmingIndexRef.current !== null) return;

    if (key.upArrow) {
      setFocusedIndex(prev => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow) {
      setFocusedIndex(prev => Math.min(tasks.length - 1, prev + 1));
      return;
    }

    const task = tasks[focusedIndexRef.current];
    if (!task) return;

    if (input === 'c' && !key.ctrl) {
      doMutate('tasks.claim', task.id);
    } else if (input === 'u') {
      doMutate('tasks.unclaim', task.id);
    } else if (input === 'd' && !key.ctrl) {
      confirmingIndexRef.current = focusedIndexRef.current;
      confirmModeRef.current = 'complete';
      setConfirmingIndex(focusedIndexRef.current);
      setConfirmMode('complete');
    } else if (input === 'b' && !key.shift) {
      confirmingIndexRef.current = focusedIndexRef.current;
      confirmModeRef.current = 'block';
      setConfirmingIndex(focusedIndexRef.current);
      setConfirmMode('block');
    } else if (input === 'B' || (input === 'b' && key.shift)) {
      doMutate('tasks.unblock', task.id);
    }
  }, { isActive: isInputActive });

  // ── ConfirmModal rendering ──

  if (confirmingIndex !== null && confirmMode) {
    const task = tasks[confirmingIndex] as any;
    if (!task) {
      // Safety: clear invalid state
      setConfirmingIndex(null);
      setConfirmMode(null);
    } else if (confirmMode === 'complete') {
      return (
        <ConfirmModal
          title="Mark task done?"
          body={String(task.text ?? '')}
          onConfirm={() => {
            const idx = confirmingIndexRef.current;
            if (idx !== null) {
              doMutate('tasks.complete', tasks[idx].id);
            }
            confirmingIndexRef.current = null;
            confirmModeRef.current = null;
            setConfirmingIndex(null);
            setConfirmMode(null);
          }}
          onCancel={() => {
            confirmingIndexRef.current = null;
            confirmModeRef.current = null;
            setConfirmingIndex(null);
            setConfirmMode(null);
          }}
        />
      );
    } else if (confirmMode === 'block') {
      return (
        <ConfirmModal
          title="Block task"
          body={String(task.text ?? '')}
          reasonInput={{ label: 'Block reason' }}
          onConfirm={(reason) => {
            const idx = confirmingIndexRef.current;
            if (idx !== null) {
              doMutate('tasks.block', tasks[idx].id, { reason });
            }
            confirmingIndexRef.current = null;
            confirmModeRef.current = null;
            setConfirmingIndex(null);
            setConfirmMode(null);
          }}
          onCancel={() => {
            confirmingIndexRef.current = null;
            confirmModeRef.current = null;
            setConfirmingIndex(null);
            setConfirmMode(null);
          }}
        />
      );
    }
  }

  // ── Task list ──

  const safeFocused = Math.min(focusedIndex, tasks.length - 1);
  const { start, end, hiddenAbove, hiddenBelow } = computeFocusWindow(
    tasks.length, safeFocused, DASHBOARD_MAX_VISIBLE_ROWS,
  );

  return (
    <Box flexDirection="column">
      {hiddenAbove > 0 ? <Text dimColor>↑ {hiddenAbove} more above</Text> : null}
      {tasks.slice(start, end).map((task: any, vi: number) => {
        const i = start + vi;
        const isFocused = i === focusedIndex;
        const isLockBusy = lockBusyRows.has(i);
        const hasError = errorState?.index === i;

        return (
          <Box key={task.id ?? i} flexDirection="column" marginBottom={1}>
            <Box>
              {isFocused ? <Text color="cyan">▸ </Text> : <Text>  </Text>}
              <TaskStatusIcon status={task.status} />
              <Text> </Text>
              <PriorityBadge priority={task.priority} />
              <Text> </Text>
              <Text bold={isFocused}>{String(task.text ?? '').slice(0, 30)}{(task.text ?? '').length > 30 ? '…' : ''}</Text>
            </Box>
            <Box marginLeft={2}>
              <Text dimColor>
                {task.claimedBy ? `👤 ${task.claimedBy}` : 'unclaimed'}
                {task.blockedBy ? ` | blocked: ${task.blockedBy}` : ''}
              </Text>
            </Box>
            {isFocused && mutate ? (
              <Box marginLeft={2}>
                <Text dimColor>[c] Claim [u] Unclaim [d] Done [b] Block [B] Unblock</Text>
              </Box>
            ) : null}
            {isLockBusy ? (
              <Box marginLeft={2}>
                <Text color="yellow">busy — another agent holds the lock (auto-expires in 20m)</Text>
              </Box>
            ) : null}
            {hasError ? (
              <Box marginLeft={2}>
                <Text color="red">{errorState!.code}: {errorState!.message}</Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
      {hiddenBelow > 0 ? <Text dimColor>↓ {hiddenBelow} more below</Text> : null}
    </Box>
  );
}

// ── Sub-components ──

function TaskStatusIcon({ status }: { status: string }): React.JSX.Element {
  switch (status) {
    case 'done': return <Text color="green">✓</Text>;
    case 'blocked': return <Text color="red">⊘</Text>;
    case 'in-progress': return <Text color="yellow">◷</Text>;
    default: return <Text color="white">○</Text>;
  }
}

function PriorityBadge({ priority }: { priority: string }): React.JSX.Element {
  switch (priority) {
    case 'high': return <Text color="red">high</Text>;
    case 'medium': return <Text color="yellow">med</Text>;
    case 'low': return <Text color="green">low</Text>;
    default: return <Text dimColor>{priority}</Text>;
  }
}
