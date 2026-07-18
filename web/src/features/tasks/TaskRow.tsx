import type { TaskInfo } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';

export interface TaskRowProps {
  task: TaskInfo;
  onOpen: (task: TaskInfo) => void;
}

// One task card — design 4a (scheme.dc.html L640-693): single-line task text with ellipsis,
// mono ID, expand toggle, metadata row below. No done-when, no priority, no "Add Task" button.
// Red dot colour encodes lifecycle (in-progress/actionable/waiting/blocked).
const DOT_COLORS: Record<string, string> = {
  'in-progress': 'var(--proto-danger)',
  actionable: 'var(--proto-amber)',
  'waiting-deps': 'var(--proto-faint)',
  blocked: 'var(--proto-amber)',
  done: 'var(--proto-success)',
};

function dotColor(task: TaskInfo): string {
  if (task.status === 'done') return DOT_COLORS.done;
  if (task.blockedBy) return DOT_COLORS.blocked;
  if (task.claimedBy) return DOT_COLORS['in-progress'];
  if (task.actionable) return DOT_COLORS.actionable;
  return DOT_COLORS['waiting-deps'];
}

export function TaskRow({ task, onOpen }: TaskRowProps) {
  const L = useVocab();
  const blocked = !!task.blockedBy;

  const metaParts: string[] = [];
  if (task.claimedBy) {
    metaParts.push('claimed · ' + task.claimedBy);
  } else if (task.actionable) {
    metaParts.push('P' + task.priority.charAt(0).toUpperCase() + ' · est $0.15'); // placeholder
  } else if (blocked) {
    metaParts.push(L.mBlockedPill);
  } else if (task.dependsOn.length > 0) {
    metaParts.push(L.mDependsOn + ' ' + task.dependsOn.join(', ') + ' · ' + L.mAutoUnlock);
  }
  if (task.template) metaParts.push(task.template);

  return (
    <div
      data-task-id={task.id}
      data-status={task.status}
      onClick={() => onOpen(task)}
      style={{
        background: 'var(--proto-card)',
        border: '1px solid var(--proto-line)',
        borderRadius: 9,
        padding: '9px 12px',
        boxShadow: '0 1px 2px rgba(16,24,40,.03)',
        cursor: 'pointer',
      }}
    >
      {/* row 1: dot + expand arrow + ID + text (truncated) + "⋯" */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: dotColor(task),
            flex: 'none',
            marginTop: 5,
          }}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
            <span style={{ color: 'var(--proto-faint)', fontSize: 8.5, flex: 'none' }}>▸</span>
            <span style={{ font: "500 10px 'IBM Plex Mono',monospace", color: 'var(--proto-muted-3)' }}>
              {task.id}
            </span>
            <span
              style={{
                fontSize: 12,
                color: 'var(--proto-ink-2)',
                lineHeight: 1.45,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              title={task.text}
            >
              {task.text}
            </span>
          </div>
          {metaParts.length > 0 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                marginTop: 5,
                font: "400 9.5px 'IBM Plex Mono',monospace",
                color: 'var(--proto-muted-3)',
              }}
            >
              {task.claimedBy && (
                <span
                  style={{
                    font: "500 9.5px 'IBM Plex Mono',monospace",
                    color: 'var(--proto-accent)',
                    background: 'var(--proto-accent-bg)',
                    padding: '1.5px 7px',
                    borderRadius: 999,
                  }}
                >
                  claimed · {task.claimedBy}
                </span>
              )}
              {!task.claimedBy && !blocked && task.actionable && (
                <span>
                  {L.tkPriMed}
                </span>
              )}
              {!task.claimedBy && blocked && (
                <span
                  style={{
                    font: "500 9.5px 'IBM Plex Mono',monospace",
                    color: 'var(--proto-danger)',
                    background: 'var(--proto-danger-bg)',
                    padding: '1.5px 7px',
                    borderRadius: 999,
                  }}
                >
                  {L.mBlockedPill}
                </span>
              )}
              {!task.claimedBy && !blocked && !task.actionable && task.dependsOn.length > 0 && (
                <span
                  style={{
                    font: "500 9.5px 'IBM Plex Mono',monospace",
                    color: 'var(--proto-muted-2)',
                    background: 'var(--proto-gray)',
                    padding: '1.5px 7px',
                    borderRadius: 999,
                  }}
                >
                  {L.mDependsOn} {task.dependsOn.join(', ')} ✓
                </span>
              )}
            </div>
          )}
        </div>
        <span style={{ color: 'var(--proto-faint)', fontSize: 12, flex: 'none' }}>⋯</span>
      </div>
    </div>
  );
}
