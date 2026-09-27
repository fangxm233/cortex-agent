import type { ComponentType, CSSProperties, MouseEvent, ReactNode } from 'react';
import type { TaskInfo } from '@cortex-agent/ui-contract';
import { displayClaimId } from '@/features/tasks/task-claim';
import { unresolvedDependencyIds } from '@/features/tasks/task-dependencies';
import type { TaskGroup, TaskGroupKind } from '@/features/tasks/group-tasks';
import { formatTaskTime } from '@/features/tasks/task-time';
import { MScreen, MTabHeader, MScrollBody, MGroup, MGroupLabel, MEmpty, MC, MONO, M_NUM, M_TAB_BODY_PADDING } from '@/mobile/ui/kit';

export interface MTasksCopy {
  title: string;
  inProgress: string;
  actionable: string;
  approvalNeeded: string;
  waiting: string;
  blocked: string;
  claim: string;
  needs: string;
  doneWhen: string;
  doneWhenGap: string;
  toggleDoneWhen: string;
  openApprovals: string;
  done: string;
  empty: string;
}

const GROUP_COPY_KEYS: Record<TaskGroupKind, keyof MTasksCopy> = {
  'in-progress': 'inProgress',
  actionable: 'actionable',
  'approval-needed': 'approvalNeeded',
  'waiting-deps': 'waiting',
  blocked: 'blocked',
  done: 'done',
};

const TEXT_TRUNCATE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

interface CardProps {
  task: TaskInfo;
  copy: MTasksCopy;
  expanded: boolean;
  onToggle: (id: string) => void;
  onOpenTask: (id: string) => void;
  onOpenThread: (threadId: string) => void;
  onOpenApprovals: () => void;
}

// One task row: title line (+ optional right accessory), then a meta line led by the mono task id.
// `after` renders below the meta (the expanded done-when block).
function TaskRow({ task, onOpenTask, textColor = MC.ink, accessory, meta, after }: {
  task: TaskInfo;
  onOpenTask: (id: string) => void;
  textColor?: string;
  accessory?: ReactNode;
  meta?: ReactNode;
  after?: ReactNode;
}) {
  return (
    <div className="m-press" onClick={() => onOpenTask(task.id)} style={{ padding: '10px 14px', borderRadius: 10, cursor: 'pointer', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span style={{ fontSize: 14, color: textColor, ...TEXT_TRUNCATE }} title={task.text}>{task.text}</span>
        {accessory}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 3, minWidth: 0 }}>
        <span style={{ font: `500 11px ${MONO}`, color: MC.muted, flex: 'none' }}>{task.id}</span>
        {meta}
      </div>
      {after}
    </div>
  );
}

function StatusLine({ text, color, dot, onClick }: {
  text: string;
  color: string;
  dot?: string;
  onClick?: (event: MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, flex: 1, cursor: onClick ? 'pointer' : 'inherit' }}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot, flex: 'none' }} />}
      <span style={{ fontSize: 12, color, ...M_NUM, ...TEXT_TRUNCATE }}>{text}</span>
    </div>
  );
}

function InProgressCard({ task, copy, onOpenTask, onOpenThread }: CardProps) {
  const claimId = displayClaimId(task);
  const openThread = (event: MouseEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    if (claimId) onOpenThread(claimId);
  };
  const chip = (
    <span onClick={openThread} style={{ fontSize: 11.5, fontWeight: 600, color: MC.run, background: MC.runBg, padding: '1px 8px', borderRadius: 'var(--r-pill)', cursor: claimId ? 'pointer' : 'default', ...M_NUM, ...TEXT_TRUNCATE, flex: '0 1 auto' }}>
      {copy.claim}{claimId ? ` · ${claimId} ›` : ''}
    </span>
  );
  return <TaskRow task={task} onOpenTask={onOpenTask} meta={chip} />;
}

function ActionableCard({ task, copy, expanded, onToggle, onOpenTask }: CardProps) {
  const toggle = (
    <span role="button" aria-label={copy.toggleDoneWhen} aria-expanded={expanded} onClick={(event) => { event.stopPropagation(); onToggle(task.id); }} style={{ color: MC.muted, fontSize: 9, flex: 'none', cursor: 'pointer', minWidth: 44, minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', margin: '-14px -14px -14px 0' }}>
      {expanded ? '▾' : '▸'}
    </span>
  );
  const doneWhen = expanded && (
    <div style={{ marginTop: 8, padding: '8px 10px', background: 'var(--proto-alt)', borderRadius: 'var(--r-chip)', fontSize: 12, lineHeight: 1.55, color: MC.sub }}>
      {copy.doneWhen}: {task.doneWhen ?? copy.doneWhenGap}
    </div>
  );
  return <TaskRow task={task} onOpenTask={onOpenTask} accessory={toggle} after={doneWhen || undefined} />;
}

function ApprovalNeededCard({ task, copy, onOpenTask, onOpenApprovals }: CardProps) {
  const openApprovals = (event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    onOpenApprovals();
  };
  const status = <StatusLine text={`${copy.approvalNeeded} · ${copy.openApprovals} ›`} color={MC.amberText} dot={MC.amber} onClick={openApprovals} />;
  return <TaskRow task={task} onOpenTask={onOpenTask} meta={status} />;
}

function WaitingCard({ task, copy, onOpenTask }: CardProps) {
  const dependencies = unresolvedDependencyIds(task);
  const text = dependencies.length > 0 ? `${copy.needs} ${dependencies.join(', ')}` : copy.waiting;
  return <TaskRow task={task} onOpenTask={onOpenTask} textColor={MC.body} meta={<StatusLine text={text} color={MC.muted} />} />;
}

function BlockedCard({ task, copy, onOpenTask }: CardProps) {
  const text = task.blockedBy ? `${copy.blocked} · ${task.blockedBy}` : copy.blocked;
  return <TaskRow task={task} onOpenTask={onOpenTask} textColor={MC.body} meta={<StatusLine text={text} color={MC.amberText} dot={MC.amber} />} />;
}

function DoneCard({ task, onOpenTask }: CardProps) {
  // Real `completed-at` in local wall clock; dropped when the task never recorded one.
  const completedAt = formatTaskTime(task.completedAt);
  const meta = completedAt ? <span style={{ fontSize: 12, color: MC.muted, ...M_NUM }}>{completedAt}</span> : undefined;
  return <TaskRow task={task} onOpenTask={onOpenTask} textColor={MC.sub} meta={meta} />;
}

const CARD_COMPONENTS: Record<TaskGroupKind, ComponentType<CardProps>> = {
  'in-progress': InProgressCard,
  actionable: ActionableCard,
  'approval-needed': ApprovalNeededCard,
  'waiting-deps': WaitingCard,
  blocked: BlockedCard,
  done: DoneCard,
};

export function MTasksView({ groups, scope, copy, expandedIds, onToggleExpand, onOpenTask, onOpenThread, onOpenApprovals }: {
  groups: TaskGroup[];
  scope?: string;
  copy: MTasksCopy;
  expandedIds: ReadonlySet<string>;
  onToggleExpand: (id: string) => void;
  onOpenTask: (id: string) => void;
  onOpenThread: (threadId: string) => void;
  onOpenApprovals: () => void;
}) {
  const handlers = { copy, onToggle: onToggleExpand, onOpenTask, onOpenThread, onOpenApprovals };
  return (
    <MScreen label="1d 任务" floatingHeader header={<MTabHeader title={copy.title} qn={scope} />}>
      <MScrollBody gap={0} padding={M_TAB_BODY_PADDING}>
        {groups.length === 0 && <MEmpty>{copy.empty}</MEmpty>}
        {groups.map((group, index) => {
          const Card = CARD_COMPONENTS[group.kind];
          return (
            <section key={group.kind} style={{ marginTop: index === 0 ? 0 : 18 }}>
              <MGroupLabel>
                {copy[GROUP_COPY_KEYS[group.kind]]} <span style={{ color: MC.faint, fontWeight: 500, ...M_NUM }}>{group.tasks.length}</span>
              </MGroupLabel>
              <MGroup>{group.tasks.map((task) => <Card key={task.id} task={task} expanded={expandedIds.has(task.id)} {...handlers} />)}</MGroup>
            </section>
          );
        })}
      </MScrollBody>
    </MScreen>
  );
}
