import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import type { TabData } from '../hooks/useDashboardData.js';
import type { MutateResult } from '../hooks/useMutate.js';
import { ConfirmModal } from './ConfirmModal.js';
import { computeFocusWindow } from '../logic.js';
import { DASHBOARD_MAX_VISIBLE_ROWS } from './dashboard-constants.js';
import { t } from '../../core/i18n.js';

interface ThreadRow {
  id: string;
  templateName?: string;
  status: string;
  currentStep?: { name?: string; index: number; totalSteps: number } | null;
  totalSteps?: number;
}

interface DashboardThreadsTabProps {
  data: TabData;
  mutate?: (op: string, args: Record<string, unknown>) => Promise<MutateResult>;
  /** Whether the dashboard owns the keyboard. Defaults true for standalone tests. */
  active?: boolean;
}

export function DashboardThreadsTab({ data, mutate, active = true }: DashboardThreadsTabProps): React.JSX.Element {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [confirmingIndex, setConfirmingIndex] = useState<number | null>(null);
  const [alreadyTerminalRows, setAlreadyTerminalRows] = useState<Set<number>>(new Set());
  const feedbackTimeoutRef = useRef<(() => void) | null>(null);

  // Cleanup feedback timeout on unmount
  useEffect(() => {
    return () => {
      feedbackTimeoutRef.current?.();
    };
  }, []);

  // Clamp focused index when data shrinks
  useEffect(() => {
    if (data.data.length > 0 && focusedIndex >= data.data.length) {
      setFocusedIndex(data.data.length - 1);
    }
  }, [data.data.length, focusedIndex]);

  useInput((input, key) => {
    if (confirmingIndex !== null) return;
    if (data.data.length === 0) return;

    if (key.upArrow) {
      setFocusedIndex(prev => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setFocusedIndex(prev => Math.min(data.data.length - 1, prev + 1));
    } else if (input === 'c' && !key.ctrl && mutate) {
      setConfirmingIndex(focusedIndex);
    }
  }, { isActive: active });

  if (data.loading && data.data.length === 0) {
    return <Text dimColor>{t('tui.dash.threads.loading')}</Text>;
  }
  if (data.error) {
    return <Text color="red">{t('tui.common.error', { message: data.error })}</Text>;
  }
  if (data.data.length === 0) {
    return <Text dimColor>{t('tui.dash.threads.empty')}</Text>;
  }

  const thread: ThreadRow | null = confirmingIndex !== null ? (data.data[confirmingIndex] as ThreadRow) : null;

  return (
    <Box flexDirection="column">
      {confirmingIndex !== null && thread ? (
        <ConfirmModal
          title={t('tui.dash.threads.cancelTitle')}
          body={`${thread.templateName ?? t('tui.dash.threads.unnamed')} — ${thread.currentStep?.name ?? ''} (${thread.status})`}
          onConfirm={async () => {
            if (!mutate) return;
            const result = await mutate('threads.cancel', { threadId: thread.id });
            if (result.ok === false && result.error.code === 'already-terminal') {
              const idx = confirmingIndex;
              setAlreadyTerminalRows(prev => new Set([...prev, idx]));
              const timer = setTimeout(() => {
                setAlreadyTerminalRows(prev => {
                  const next = new Set(prev);
                  next.delete(idx);
                  return next;
                });
              }, 5000);
              feedbackTimeoutRef.current?.();
              feedbackTimeoutRef.current = () => clearTimeout(timer);
            }
            setConfirmingIndex(null);
          }}
          onCancel={() => setConfirmingIndex(null)}
        />
      ) : (
        (() => {
          const safeFocused = Math.min(focusedIndex, data.data.length - 1);
          const { start, end, hiddenAbove, hiddenBelow } = computeFocusWindow(
            data.data.length, safeFocused, DASHBOARD_MAX_VISIBLE_ROWS,
          );
          return (
            <>
              {hiddenAbove > 0 ? <Text dimColor>{t('tui.common.moreAbove', { n: hiddenAbove })}</Text> : null}
              {data.data.slice(start, end).map((row: any, vi: number) => {
                const i = start + vi;
                return (
                  <Box key={row.id ?? i} flexDirection="column" marginBottom={1}>
                    <Box>
                      {i === focusedIndex ? <Text color="cyan">▸ </Text> : <Text>  </Text>}
                      <StatusIcon status={row.status} />
                      <Text> </Text>
                      <Text bold={i === focusedIndex}>{row.templateName ?? t('tui.dash.threads.unnamed')}</Text>
                    </Box>
                    <Box marginLeft={2}>
                      <Text dimColor>
                        {row.status}
                        {row.currentStep ? t('tui.dash.threads.step', { step: stepLabel(row.currentStep.index, row.totalSteps) }) : ''}
                      </Text>
                    </Box>
                    {alreadyTerminalRows.has(i) ? (
                      <Box marginLeft={2}>
                        <Text dimColor>{t('tui.dash.threads.alreadyFinished')}</Text>
                      </Box>
                    ) : null}
                  </Box>
                );
              })}
              {hiddenBelow > 0 ? <Text dimColor>{t('tui.common.moreBelow', { n: hiddenBelow })}</Text> : null}
            </>
          );
        })()
      )}
    </Box>
  );
}

/** "<current>/<total>" step label. A completed thread can report a final step index at or
 *  past totalSteps (e.g. index 2 with 2 steps → "3/2"); clamp the numerator so the display
 *  never exceeds the total. */
function stepLabel(index: number, totalSteps?: number): string {
  const current = index + 1;
  if (totalSteps == null) return String(current);
  return `${Math.min(current, totalSteps)}/${totalSteps}`;
}

function StatusIcon({ status }: { status: string }): React.JSX.Element {
  switch (status) {
    case 'running': return <Text color="green">▶</Text>;
    case 'waiting': return <Text color="yellow">⏳</Text>;
    case 'completed': return <Text color="blue">✓</Text>;
    case 'failed': return <Text color="red">✗</Text>;
    case 'cancelled': return <Text dimColor>⊘</Text>;
    case 'aborted': return <Text color="red">⛔</Text>;
    default: return <Text dimColor>?</Text>;
  }
}
