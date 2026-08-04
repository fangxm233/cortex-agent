// input:  Complete task groups, lifecycle copy, and navigation callbacks
// output: Mobile task list with one-line blocker metadata
// pos:    Presentational mobile task-list screen
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
// @ds-adherence-ignore -- mobile v3 raw px/hex/font by design

import type { ComponentType, CSSProperties, MouseEvent } from 'react';
import type { TaskInfo } from '@cortex-agent/ui-contract';
import { displayClaimId } from '@/features/tasks/task-claim';
import { unresolvedDependencyIds } from '@/features/tasks/task-dependencies';
import { formatTaskTime } from '@/features/tasks/task-time';
import { MScreen, MTabHeader, MScrollBody, MCard, MGroupLabel, MC, MONO } from '@/mobile/ui/kit';
import type { MTaskGroupKey, MTaskGroupView } from './m-tasks-vm';

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
  openApprovals: string;
  done: string;
  empty: string;
}

const GROUP_COPY_KEYS: Record<MTaskGroupKey, keyof MTasksCopy> = {
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

function IdText({ task, textColor = MC.body }: { task: TaskInfo; textColor?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0, flex: 1 }}>
      <span style={{ font: `500 10px ${MONO}`, color: MC.muted, flex: 'none' }}>{task.id}</span>
      <span style={{ fontSize: 12.5, color: textColor, lineHeight: 1.45, ...TEXT_TRUNCATE }} title={task.text}>
        {task.text}
      </span>
    </div>
  );
}

function StatusLine({ text, color, dot, onClick, singleLine = false }: {
  text: string;
  color: string;
  dot?: string;
  onClick?: (event: MouseEvent<HTMLDivElement>) => void;
  singleLine?: boolean;
}) {
  return (
    <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 5, minWidth: 0, cursor: onClick ? 'pointer' : 'default' }}>
      {dot && <span style={{ width: 5, height: 5, borderRadius: '50%', background: dot, flex: 'none' }} />}
      <span
        data-task-blocker={singleLine ? 'true' : undefined}
        style={{ font: `400 9.5px ${MONO}`, color, ...(singleLine ? TEXT_TRUNCATE : {}) }}
      >
        {text}
      </span>
    </div>
  );
}

function InProgressCard({ task, copy, onOpenTask, onOpenThread }: CardProps) {
  const claimId = displayClaimId(task);
  const threadId = claimId;
  const openThread = (event: MouseEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    if (threadId) onOpenThread(threadId);
  };
  return (
    <MCard radius={11} padding="10px 13px" onClick={() => onOpenTask(task.id)}>
      <IdText task={task} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 5 }}>
        <span onClick={openThread} style={{ font: `500 9.5px ${MONO}`, color: MC.run, background: MC.runBg, padding: '2px 7px', borderRadius: 999, cursor: threadId ? 'pointer' : 'default' }}>
          {copy.claim}{claimId ? ` · ${claimId}` : ''}{threadId ? ' ›' : ''}
        </span>
      </div>
    </MCard>
  );
}

function ActionableCard({ task, copy, expanded, onToggle, onOpenTask }: CardProps) {
  return (
    <MCard radius={11} padding="10px 13px" onClick={() => onOpenTask(task.id)}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
        <IdText task={task} />
        <span role="button" aria-label="Toggle done-when" aria-expanded={expanded} onClick={(event) => { event.stopPropagation(); onToggle(task.id); }} style={{ marginLeft: 'auto', color: MC.faint, fontSize: 8.5, flex: 'none', cursor: 'pointer', padding: '2px 2px 2px 8px' }}>
          {expanded ? '▾' : '▸'}
        </span>
      </div>
      {expanded && <div style={{ marginTop: 7, padding: '8px 10px', background: 'var(--proto-alt)', borderRadius: 8, font: `400 10px/1.6 ${MONO}`, color: MC.sub }}>{copy.doneWhen}: {task.doneWhen ?? copy.doneWhenGap}</div>}
    </MCard>
  );
}

function ApprovalNeededCard({ task, copy, onOpenTask, onOpenApprovals }: CardProps) {
  const openApprovals = (event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    onOpenApprovals();
  };
  return (
    <MCard radius={11} padding="10px 13px" onClick={() => onOpenTask(task.id)}>
      <IdText task={task} />
      <StatusLine text={`${copy.approvalNeeded} · ${copy.openApprovals}`} color={MC.amberText} dot={MC.amber} onClick={openApprovals} />
    </MCard>
  );
}

function WaitingCard({ task, copy, onOpenTask }: CardProps) {
  const dependencies = unresolvedDependencyIds(task);
  const text = dependencies.length > 0 ? `${copy.needs} ${dependencies.join(', ')}` : copy.waiting;
  return (
    <MCard radius={11} padding="10px 13px" onClick={() => onOpenTask(task.id)} style={{ opacity: 0.8 }}>
      <IdText task={task} textColor={MC.sub} />
      <StatusLine text={text} color={MC.muted} />
    </MCard>
  );
}

function BlockedCard({ task, copy, onOpenTask }: CardProps) {
  const text = task.blockedBy ? `${copy.blocked} · ${task.blockedBy}` : copy.blocked;
  return (
    <MCard radius={11} padding="10px 13px" onClick={() => onOpenTask(task.id)} style={{ opacity: 0.75 }}>
      <IdText task={task} textColor={MC.sub} />
      <StatusLine text={text} color={MC.amberText} dot={MC.amber} singleLine />
    </MCard>
  );
}

function DoneCard({ task, onOpenTask }: CardProps) {
  // Real `completed-at` in local wall clock; the line is dropped when the task never recorded one.
  const completedAt = formatTaskTime(task.completedAt);
  return (
    <MCard radius={11} padding="10px 13px" onClick={() => onOpenTask(task.id)} style={{ opacity: 0.7 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: MC.done, flex: 'none' }} />
        <IdText task={task} textColor={MC.sub} />
        {completedAt && (
          <span style={{ font: `400 9.5px ${MONO}`, color: MC.muted, flex: 'none' }}>{completedAt}</span>
        )}
      </div>
    </MCard>
  );
}

const CARD_COMPONENTS: Record<MTaskGroupKey, ComponentType<CardProps>> = {
  'in-progress': InProgressCard,
  actionable: ActionableCard,
  'approval-needed': ApprovalNeededCard,
  'waiting-deps': WaitingCard,
  blocked: BlockedCard,
  done: DoneCard,
};

export function MTasksView({ groups, scope, copy, expandedIds, onToggleExpand, onOpenTask, onOpenThread, onOpenApprovals }: {
  groups: MTaskGroupView[];
  scope?: string;
  copy: MTasksCopy;
  expandedIds: ReadonlySet<string>;
  onToggleExpand: (id: string) => void;
  onOpenTask: (id: string) => void;
  onOpenThread: (threadId: string) => void;
  onOpenApprovals: () => void;
}) {
  return (
    <MScreen label="1d 任务" header={<MTabHeader title={copy.title} qn={scope} />}>
      <MScrollBody gap={6}>
        {groups.length === 0 && <div style={{ padding: '40px 0', textAlign: 'center', color: MC.faint, fontSize: 13 }}>{copy.empty}</div>}
        {groups.map((group, index) => {
          const Card = CARD_COMPONENTS[group.key];
          return <div key={group.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <MGroupLabel style={{ padding: index === 0 ? '0 2px 2px' : '6px 2px 2px' }}>{copy[GROUP_COPY_KEYS[group.key]]} · {group.tasks.length}</MGroupLabel>
            {group.tasks.map((task) => <Card key={task.id} task={task} copy={copy} expanded={expandedIds.has(task.id)} onToggle={onToggleExpand} onOpenTask={onOpenTask} onOpenThread={onOpenThread} onOpenApprovals={onOpenApprovals} />)}
          </div>;
        })}
      </MScrollBody>
    </MScreen>
  );
}
