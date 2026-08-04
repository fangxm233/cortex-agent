// input:  Task DTO, task claim helper, and task vocabulary
// output: Desktop task card with one-line blocker metadata
// pos:    Clickable desktop task lifecycle card presentation
// >>> If I am updated, update my header comment and CORTEX.md <<<

import type { CSSProperties } from 'react';
import type { TaskInfo } from '@cortex-agent/ui-contract';
import { useVocab, type Vocab } from '@/i18n';
import { displayClaimId } from './task-claim';
import { unresolvedDependencyIds } from './task-dependencies';
import { formatTaskTime } from './task-time';
import type { TaskGroupKind } from './group-tasks';

export interface TaskRowProps {
  task: TaskInfo;
  kind: TaskGroupKind;
  onOpen: (task: TaskInfo) => void;
}

type TaskMetaKind = 'claim' | 'approval' | 'blocked' | 'waiting' | 'done';

type TaskMeta = {
  kind: TaskMetaKind;
  text: string;
};

const DOT_COLORS: Record<TaskGroupKind, string> = {
  'in-progress': 'var(--proto-danger)',
  actionable: 'var(--proto-amber)',
  'approval-needed': 'var(--proto-amber)',
  'waiting-deps': 'var(--proto-faint)',
  blocked: 'var(--proto-amber)',
  done: 'var(--proto-success)',
};

const CARD_STYLE: CSSProperties = {
  background: 'var(--proto-card)',
  border: '1px solid var(--proto-line)',
  borderRadius: 9,
  padding: '9px 12px',
  boxShadow: '0 1px 2px rgba(16,24,40,.03)',
  cursor: 'pointer',
};

const META_STYLE: Record<TaskMetaKind, CSSProperties> = {
  claim: { color: 'var(--proto-accent)', background: 'var(--proto-accent-bg)' },
  approval: { color: 'var(--proto-amber-text)', background: 'var(--proto-amber-bg)' },
  blocked: { color: 'var(--proto-danger)', background: 'var(--proto-danger-bg)' },
  waiting: { color: 'var(--proto-muted-2)', background: 'var(--proto-gray)' },
  done: { color: 'var(--proto-success)', background: 'var(--proto-success-bg)' },
};

const BLOCKED_META_STYLE: CSSProperties = {
  boxSizing: 'border-box',
  maxWidth: '100%',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

function taskMeta(task: TaskInfo, kind: TaskGroupKind, vocab: Vocab): TaskMeta | null {
  const claimId = displayClaimId(task);
  const dependencies = unresolvedDependencyIds(task);
  const completedAt = formatTaskTime(task.completedAt);
  const candidates: Array<TaskMeta | null> = [
    kind === 'done' && completedAt
      ? { kind: 'done', text: `${vocab.tkCompletedAt} · ${completedAt}` }
      : null,
    kind === 'blocked' && task.blockedBy
      ? { kind: 'blocked', text: `${vocab.mBlockedPill} · ${task.blockedBy}` }
      : null,
    kind === 'in-progress'
      ? { kind: 'claim', text: claimId ? `claimed · ${claimId}` : 'claimed' }
      : null,
    kind === 'approval-needed' ? { kind: 'approval', text: vocab.tkApprovalNeeded } : null,
    kind === 'waiting-deps' && dependencies.length > 0
      ? { kind: 'waiting', text: `${vocab.mDependsOn} ${dependencies.join(', ')}` }
      : null,
  ];
  return candidates.find((candidate): candidate is TaskMeta => candidate != null) ?? null;
}

function TaskIdentity({ task }: { task: TaskInfo }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, minWidth: 0 }}>
      <span style={{ color: 'var(--proto-faint)', fontSize: 8.5, flex: 'none' }}>▸</span>
      <span style={{ font: "500 10px 'IBM Plex Mono',monospace", color: 'var(--proto-muted-3)' }}>
        {task.id}
      </span>
      <span
        style={{
          fontSize: 12,
          color: 'var(--proto-ink-2)',
          lineHeight: 1.45,
          flex: 1,
          minWidth: 0,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={task.text}
      >
        {task.text}
      </span>
    </div>
  );
}

function TaskMetadata({ meta }: { meta: TaskMeta }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginTop: 5 }}>
      <span
        data-task-blocker={meta.kind === 'blocked' ? 'true' : undefined}
        style={{
          font: "500 9.5px 'IBM Plex Mono',monospace",
          padding: '1.5px 7px',
          borderRadius: 999,
          ...META_STYLE[meta.kind],
          ...(meta.kind === 'blocked' ? BLOCKED_META_STYLE : {}),
        }}
      >
        {meta.text}
      </span>
    </div>
  );
}

export function TaskRow({ task, kind, onOpen }: TaskRowProps) {
  const vocab = useVocab();
  const meta = taskMeta(task, kind, vocab);
  return (
    <div data-task-id={task.id} data-status={task.status} onClick={() => onOpen(task)} style={CARD_STYLE}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: DOT_COLORS[kind], flex: 'none', marginTop: 5 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <TaskIdentity task={task} />
          {meta && <TaskMetadata meta={meta} />}
        </div>
      </div>
    </div>
  );
}
