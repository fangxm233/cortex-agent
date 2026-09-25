// input:  react, feature data, theme tokens
// output: TaskRow presentation
// pos:    Dense task material cards and state chips
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { useState, type CSSProperties } from 'react';
import '@/design/content-surfaces.css';
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
  'waiting-deps': 'var(--proto-muted)',
  blocked: 'var(--proto-amber)',
  done: 'var(--proto-success)',
};

// One quiet boundary and a blur-free material keep dense task metadata readable.
const CARD_STYLE: CSSProperties = {
  background: 'var(--material-card-bg)',
  border: 0,
  borderRadius: 'var(--r-card)',
  padding: '9px 12px',
  boxShadow: '0 0 0 1px var(--proto-line-2), var(--material-card-shadow)',
  cursor: 'pointer',
};

const CARD_HOVER_STYLE: CSSProperties = {
  boxShadow: '0 0 0 1px var(--proto-accent-border), var(--material-card-shadow)',
};

const META_STYLE: Record<TaskMetaKind, CSSProperties> = {
  claim: { color: 'var(--proto-accent)', background: 'var(--proto-accent-bg)' },
  approval: { color: 'var(--proto-amber-text)', background: 'var(--proto-amber-bg)' },
  blocked: { color: 'var(--proto-danger)', background: 'var(--proto-danger-bg)' },
  waiting: { color: 'var(--proto-muted)', background: 'var(--proto-gray)' },
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
      <span style={{ font: "500 11px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)' }}>
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
          font: "500 11px 'IBM Plex Mono',monospace",
          padding: '1.5px 7px',
          borderRadius: 'var(--r-pill)',
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
  const [hover, setHover] = useState(false);
  return (
    <div
      className="content-surface"
      role="button"
      tabIndex={0}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(task); } }}
      data-task-id={task.id}
      data-status={task.status}
      onClick={() => onOpen(task)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={hover ? { ...CARD_STYLE, ...CARD_HOVER_STYLE } : CARD_STYLE}
    >
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
