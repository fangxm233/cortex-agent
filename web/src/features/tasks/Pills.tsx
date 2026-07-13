import type { TaskInfo } from '@cortex-agent/ui-contract';
import { StatusPill as DesignStatusPill, type Tone } from '@/design';
import { useVocab } from '@/i18n';

// Task-specific pills built on the design-system StatusPill primitive (design §5).
// Appearance preserved from the Stage-1 slice: priority high/med/low → failed/waiting/
// cancelled tone; status open/done → running/done tone.

const PRIORITY_TONE: Record<TaskInfo['priority'], Tone> = {
  high: 'failed',
  medium: 'waiting',
  low: 'cancelled',
};

export function PriorityPill({ priority }: { priority: TaskInfo['priority'] }) {
  const L = useVocab();
  const label: Record<TaskInfo['priority'], string> = {
    high: L.tkPriHigh,
    medium: L.tkPriMed,
    low: L.tkPriLow,
  };
  return <DesignStatusPill tone={PRIORITY_TONE[priority]} label={label[priority]} />;
}

export function StatusPill({ status }: { status: TaskInfo['status'] }) {
  const L = useVocab();
  const label: Record<TaskInfo['status'], string> = { open: L.open, done: L.tkDone };
  return <DesignStatusPill status={status} label={label[status]} />;
}
