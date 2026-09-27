import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import type { TabData } from '../hooks/useDashboardData.js';
import type { MutateResult, MutateError } from '../hooks/useMutate.js';
import { ConfirmModal } from './ConfirmModal.js';
import { computeFocusWindow } from '../logic.js';
import { DASHBOARD_MAX_VISIBLE_ROWS } from './dashboard-constants.js';
import { t } from '../../core/i18n.js';

interface DashboardSchedulesTabProps {
  data: TabData;
  mutate: (op: string, args: Record<string, unknown>) => Promise<MutateResult>;
  /** Whether the dashboard owns the keyboard. Defaults true for standalone tests. */
  active?: boolean;
}

export function DashboardSchedulesTab({ data, mutate, active = true }: DashboardSchedulesTabProps): React.JSX.Element {
  if (data.loading && data.data.length === 0) {
    return <Text dimColor>{t('tui.dash.schedules.loading')}</Text>;
  }
  if (data.error) {
    return <Text color="red">{t('tui.common.error', { message: data.error })}</Text>;
  }
  if (data.data.length === 0) {
    return <Text dimColor>{t('tui.dash.schedules.empty')}</Text>;
  }

  return <SchedulesList data={data} mutate={mutate} active={active} />;
}

function SchedulesList({ data, mutate, active = true }: DashboardSchedulesTabProps): React.JSX.Element {
  const schedules = data.data as any[];
  const [focusedRowIndex, setFocusedRowIndex] = useState(0);
  const [removingScheduleId, setRemovingScheduleId] = useState<string | null>(null);

  // Refs for stale-closure-safe access inside useInput / callbacks
  const removingScheduleIdRef = useRef<string | null>(null);
  const focusedRowIndexRef = useRef(0);
  focusedRowIndexRef.current = focusedRowIndex;
  const mutateRef = useRef(mutate);
  mutateRef.current = mutate;

  // Ensure focusedRowIndex is valid when data changes
  useEffect(() => {
    if (schedules.length > 0 && focusedRowIndex >= schedules.length) {
      setFocusedRowIndex(Math.max(0, schedules.length - 1));
    }
  }, [schedules.length, focusedRowIndex]);

  // ── Error state with 5s auto-clear ──

  const [errorState, setErrorState] = useState<{ scheduleId: string; code: string; message: string } | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showError = useCallback((scheduleId: string, code: string, message: string) => {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    setErrorState({ scheduleId, code, message });
    errorTimerRef.current = setTimeout(() => {
      setErrorState(null);
      errorTimerRef.current = null;
    }, 5000);
  }, []);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, []);

  // ── Mutate result handler ──

  const handleResult = useCallback((scheduleId: string) => (result: MutateResult) => {
    if (!result.ok) {
      const err = result as MutateError;
      showError(scheduleId, err.error.code, err.error.message);
    } else {
      setErrorState(prev => prev?.scheduleId === scheduleId ? null : prev);
    }
  }, [showError]);

  // ── Keyboard handler ──

  const isInputActive = active && removingScheduleId === null && schedules.length > 0;

  useInput((input, key) => {
    if (removingScheduleIdRef.current !== null) return;

    if (key.upArrow) {
      setFocusedRowIndex(prev => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow) {
      setFocusedRowIndex(prev => Math.min(schedules.length - 1, prev + 1));
      return;
    }

    const sched = schedules[focusedRowIndexRef.current];
    if (!sched) return;

    if (input === 'p') {
      mutateRef.current('schedules.pause', { scheduleId: sched.id }).then(handleResult(sched.id));
    } else if (input === 'r') {
      mutateRef.current('schedules.resume', { scheduleId: sched.id }).then(handleResult(sched.id));
    } else if (input === 'x') {
      setRemovingScheduleId(sched.id);
      removingScheduleIdRef.current = sched.id;
    }
  }, { isActive: isInputActive });

  // ── Build schedule rows (windowed so a long list can't overflow the terminal) ──

  const safeFocused = Math.min(focusedRowIndex, schedules.length - 1);
  const { start, end, hiddenAbove, hiddenBelow } = computeFocusWindow(
    schedules.length, safeFocused, DASHBOARD_MAX_VISIBLE_ROWS,
  );
  const rows = schedules.slice(start, end).map((sched: any, vi: number) => {
    const i = start + vi;
    const isFocused = i === focusedRowIndex;
    return (
      <Box key={sched.id ?? i} flexDirection="column" marginBottom={1}>
        <Box>
          {isFocused ? <Text bold>{'> '}</Text> : <Text>  </Text>}
          <ScheduleTypeBadge type={sched.type} paused={sched.paused} focused={isFocused} />
          <Text> </Text>
          <Text bold={isFocused} dimColor={!isFocused}>
            {String(sched.message ?? '').slice(0, 25)}{(sched.message ?? '').length > 25 ? '…' : ''}
          </Text>
        </Box>
        <Box marginLeft={2}>
          <Text dimColor>
            {sched.paused
              ? t('tui.dash.schedules.pausedBy', { who: sched.pausedBy ?? '?' })
              : nextRunLabel(sched.nextRun)}
          </Text>
        </Box>
        {isFocused ? (
          <Box marginLeft={2}>
            <Text>{t('tui.dash.schedules.keys')}</Text>
          </Box>
        ) : null}
        {errorState?.scheduleId === sched.id ? (
          <Box marginLeft={2}>
            <Text color="red">{errorState.code}: {errorState.message}</Text>
          </Box>
        ) : null}
      </Box>
    );
  });

  // ── Remove confirmation modal (inline, consistent with ExecutionsTab pattern) ──

  let confirmModal: React.JSX.Element | null = null;
  if (removingScheduleId !== null) {
    const sched = schedules.find(s => s.id === removingScheduleId);
    const body = sched
      ? `${sched.type}: ${sched.message ?? ''} | ${nextRunLabel(sched.nextRun)}`
      : '';

    confirmModal = (
      <ConfirmModal
        title={t('tui.dash.schedules.removeTitle')}
        body={body}
        onConfirm={() => {
          const id = removingScheduleIdRef.current;
          if (id) {
            mutateRef.current('schedules.remove', { scheduleId: id }).then(handleResult(id));
          }
          setRemovingScheduleId(null);
          removingScheduleIdRef.current = null;
        }}
        onCancel={() => {
          setRemovingScheduleId(null);
          removingScheduleIdRef.current = null;
        }}
      />
    );
  }

  return (
    <Box flexDirection="column">
      {hiddenAbove > 0 ? <Text dimColor>{t('tui.common.moreAbove', { n: hiddenAbove })}</Text> : null}
      {rows}
      {hiddenBelow > 0 ? <Text dimColor>{t('tui.common.moreBelow', { n: hiddenBelow })}</Text> : null}
      {confirmModal}
    </Box>
  );
}

/** "next: <local time>" (or "next: never") for a schedule's nextRun. */
function nextRunLabel(nextRun: string | number | null | undefined): string {
  const when = nextRun ? new Date(nextRun).toLocaleString() : t('tui.dash.schedules.never');
  return t('tui.dash.schedules.next', { when });
}

function ScheduleTypeBadge({ type, paused, focused }: { type: string; paused: boolean; focused: boolean }): React.JSX.Element {
  const color = paused ? 'yellow' : 'green';
  const label = paused ? `⏸ ${type}` : `▶ ${type}`;
  return <Text color={color} bold={focused}>{label}</Text>;
}
