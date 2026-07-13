import type { TaskInfo } from '@cortex-agent/ui-contract';

export interface TaskRowProps {
  task: TaskInfo;
  pending: boolean;
  onUnblock: (task: TaskInfo) => void;
  onOpen: (task: TaskInfo) => void;
}

const ACTION_BTN =
  'shrink-0 rounded-card border border-card px-1g py-0.5g text-ui text-state-ink/80 ' +
  'hover:bg-surface-canvas-alt disabled:opacity-40 disabled:cursor-not-allowed';

// One task line, two rows (prototype task list):
//   row 1 — the task text, with an Unblock action on the same line WHEN blocked;
//   row 2 — the metadata labels (id · template · @claimant · blocked).
// Deliberately NOT shown: priority, the "open" status, Claim, Complete (those live in the modal).
// The row opens the task detail modal (10a); the Unblock button stopPropagation so it doesn't also open it.
export function TaskRow({ task, pending, onUnblock, onOpen }: TaskRowProps) {
  const blocked = !!task.blockedBy;
  const stop =
    (fn: (t: TaskInfo) => void) => (e: React.MouseEvent) => {
      e.stopPropagation();
      fn(task);
    };
  return (
    <div
      data-task-id={task.id}
      data-status={task.status}
      onClick={() => onOpen(task)}
      className="flex cursor-pointer flex-col gap-0.5g rounded-card border border-card bg-surface-card px-1.5g py-1g shadow-card hover:bg-surface-canvas-alt"
    >
      {/* row 1: text + (Unblock when blocked) */}
      <div className="flex items-start gap-1.5g">
        <span className="min-w-0 flex-1 text-ui text-state-ink" title={task.text}>
          {task.text}
        </span>
        {blocked && (
          <button className={ACTION_BTN} disabled={pending} onClick={stop(onUnblock)}>
            Unblock
          </button>
        )}
      </div>
      {/* row 2: metadata labels */}
      <div className="flex flex-wrap items-center gap-1.5g font-mono text-ui text-state-ink/45">
        <span>{task.id}</span>
        {task.template && <span>{task.template}</span>}
        {task.claimedBy && <span>@{task.claimedBy}</span>}
        {blocked && <span className="text-pill-failed-fg">blocked</span>}
      </div>
    </div>
  );
}
