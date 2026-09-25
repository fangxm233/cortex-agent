// input:  thread DTOs, right-panel-vm, tRPC, modal providers
// output: RightThreadCard, StepRow, SubtaskCard, taskProjectForDetail
// pos:    Compact thread progress cards with readable metadata
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ThreadInfo, ThreadDetail, ThreadStepDetail } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { useTaskModal } from '@/features/tasks/useTaskModal';
import { useThreadGetLiveSync } from '@/features/thread/useThreadGetLiveSync';
import { useThreadDetailModal } from '@/features/thread/ThreadDetailModal';
import {
  threadPill,
  stepDotKind,
  stepMeta,
  threadMetaLine,
  depthInfo,
  formatCost,
  subtaskActivity,
  type ActivityTone,
} from './right-panel-vm';

type ThreadSubtaskInfo = ThreadDetail['subtasks'][number];
type TaskProjectDetail = Pick<ThreadDetail, 'projectId' | 'artifacts'>;

export function taskProjectForDetail(detail: TaskProjectDetail): string {
  return detail.artifacts.taskProject ?? detail.projectId;
}

const NODE_ICON = (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" strokeWidth="1.6">
    <circle cx="3.5" cy="3" r="1.9" />
    <circle cx="3.5" cy="11" r="1.9" />
    <circle cx="10.5" cy="7" r="1.9" />
    <path d="M3.5 5v4M5.4 3.7 8.7 6.1M5.4 10.3 8.7 7.9" />
  </svg>
);

function StepDot({ kind, hasTail }: { kind: 'done' | 'running' | 'pending'; hasTail: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      {kind === 'done' && (
        <span
          style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: 'var(--proto-success-bg)',
            color: 'var(--proto-success)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 8,
            fontWeight: 700,
            flex: 'none',
          }}
        >
          ✓
        </span>
      )}
      {kind === 'running' && (
        <span
          style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: 'var(--proto-accent)',
            flex: 'none',
            boxShadow: '0 0 0 3px var(--proto-accent-bg)',
            animation: 'cxpulse 1.6s ease-in-out infinite',
          }}
        />
      )}
      {kind === 'pending' && (
        <span
          style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            border: '1.5px solid var(--proto-line-3)',
            boxSizing: 'border-box',
            flex: 'none',
          }}
        />
      )}
      {hasTail && <span style={{ flex: 1, width: 1.5, background: 'var(--proto-line-2)', margin: '3px 0' }} />}
    </div>
  );
}

const ACTIVITY_COLORS: Record<ActivityTone, string> = {
  running: 'var(--proto-accent)',
  done: 'var(--proto-success)',
  failed: 'var(--proto-danger)',
  idle: 'var(--proto-muted)',
};

function ActivityDot({ tone }: { tone: ActivityTone }) {
  return (
    <span
      style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: ACTIVITY_COLORS[tone],
        flex: 'none',
        animation: tone === 'running' ? 'cxpulse 1.6s ease-in-out infinite' : undefined,
      }}
    />
  );
}

export function SubtaskCard({ task, onOpen }: {
  task: ThreadSubtaskInfo;
  onOpen: (taskId: string) => void;
}) {
  const state = subtaskActivity(task);
  return (
    <div
      data-subtask-id={task.id}
      onClick={() => onOpen(task.id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        border: '1px solid var(--proto-line-2)',
        background: 'var(--proto-rail)',
        borderRadius: 'var(--r-chip)',
        padding: '7px 10px',
        cursor: 'pointer',
      }}
    >
      <ActivityDot tone={state.tone} />
      <span style={{ flex: 'none', font: "600 11px 'IBM Plex Mono',monospace", color: 'var(--proto-ink-2)' }}>task {task.id}</span>
      <span style={{ minWidth: 0, fontSize: 11, color: 'var(--proto-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{task.text}</span>
      <span style={{ marginLeft: 'auto', flex: 'none', fontSize: 11, fontWeight: 600, color: ACTIVITY_COLORS[state.tone] }}>{state.label}</span>
    </div>
  );
}

function ThreadActivityRows({
  subtasks,
  onOpenTask,
}: {
  subtasks: ThreadSubtaskInfo[];
  onOpenTask: (taskId: string) => void;
}) {
  if (subtasks.length === 0) return null;
  return (
    <div style={{ marginTop: 7, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {subtasks.map((task) => <SubtaskCard key={task.id} task={task} onOpen={onOpenTask} />)}
    </div>
  );
}

interface StepRowProps {
  step: ThreadStepDetail;
  isLast: boolean;
  detail: ThreadDetail;
  onOpenTask: (taskId: string) => void;
}

function StepHeader({ label, meta, active }: { label: string; meta: string; active: boolean }) {
  const labelColor = active ? 'var(--proto-ink)' : 'var(--proto-muted)';
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 11.5, fontWeight: active ? 600 : 500, color: labelColor }}>{label}</span>
      <span
        style={{ marginLeft: 'auto', font: "400 11px 'IBM Plex Mono',monospace", color: active ? 'var(--proto-accent)' : 'var(--proto-muted)' }}
      >
        {meta}
      </span>
    </div>
  );
}

export function StepRow({ step, isLast, detail, onOpenTask }: StepRowProps) {
  const L = useVocab();
  const kind = stepDotKind(step);
  const active = kind === 'running';
  const subtasks = active ? (detail.subtasks ?? []) : [];
  const hasActivities = subtasks.length > 0;
  const label = step.stage ?? `${L.rpStep} ${step.stepIndex + 1}`;
  return (
    <>
      <StepDot kind={kind} hasTail={!isLast} />
      <div style={{ minWidth: 0, paddingBottom: isLast ? 4 : 9 }}>
        <StepHeader label={label} meta={stepMeta(step)} active={active} />
        {hasActivities && <ThreadActivityRows subtasks={subtasks} onOpenTask={onOpenTask} />}
      </div>
    </>
  );
}

function CardActions({ threadId, cost }: { threadId: string; cost: number }) {
  const L = useVocab();
  const trpc = useTRPC();
  const { openThread } = useThreadDetailModal();
  const queryClient = useQueryClient();
  const cancel = useMutation(trpc.threads.cancel.mutationOptions({
    onSettled: () => {
      queryClient.invalidateQueries(trpc.threads.list.queryFilter());
      queryClient.invalidateQueries(trpc.threads.get.queryFilter({ threadId }));
    },
  }));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '9px 14px', borderTop: '1px solid var(--proto-line-2)' }}>
      <span title="Pause has no backend mutate op yet" style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--proto-muted)', cursor: 'not-allowed', opacity: 0.6 }}>{L.pause}</span>
      <span data-cancel-thread-id={threadId} onClick={() => cancel.mutate({ threadId })} style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--proto-danger)', cursor: 'pointer' }}>{L.cancel}</span>
      <span onClick={() => openThread(threadId)} style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--proto-accent)', cursor: 'pointer' }}>{L.open}</span>
      <span style={{ marginLeft: 'auto', font: "500 11px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)' }}>Σ {formatCost(cost)}</span>
    </div>
  );
}

function CardBody({ detail, threadId }: { detail: ThreadDetail; threadId: string }) {
  const { openTask } = useTaskModal();
  useThreadGetLiveSync(threadId);
  return (
    <>
      {detail.steps.length > 0 && (
        <div style={{ padding: '8px 14px 4px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '16px 1fr', columnGap: 9 }}>
            {detail.steps.map((step) => <StepRow key={step.stepIndex} step={step}
              isLast={step.stepIndex === detail.steps.length - 1} detail={detail}
              onOpenTask={(taskId) => openTask(taskProjectForDetail(detail), taskId)} />)}
          </div>
        </div>
      )}
      <CardActions threadId={threadId} cost={detail.totalCostUsd} />
    </>
  );
}

export interface RightThreadCardProps {
  thread: ThreadInfo;
  now: number;
}

export function RightThreadCard({ thread, now }: RightThreadCardProps) {
  // Running threads default-open (matches the proto-shot's expanded experiment-pipeline); others
  // collapse to header-only and lazy-fetch threads.get on open.
  const L = useVocab();
  const running = thread.status === 'running';
  const [open, setOpen] = useState(running);
  const [hover, setHover] = useState(false);
  const trpc = useTRPC();
  const detailQuery = useQuery({
    ...trpc.threads.get.queryOptions({ threadId: thread.id }),
    enabled: open,
  });

  const pill = threadPill(thread.status);
  const iconColor = running ? 'var(--proto-accent)' : 'var(--proto-muted-2)';
  const detail = open ? detailQuery.data : undefined;
  const dots = detail ? depthInfo(detail) : null;
  const hasDots = !!dots && dots.filled > 1;

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        // Raised glass inside the drawer: the sheet under it is translucent, so an opaque card
        // would punch a white hole in it. No filter — the drawer already blurs, and this list scrolls.
        background: 'var(--material-card-bg)',
        // The outline is a shadow ring rather than a border so it costs no outer size: a 1px border
        // would make every card 2px wider than the stack it sits in. The running thread wears the
        // accent ring; the rest only brighten theirs on hover.
        border: 0,
        borderRadius: 'var(--r-card)',
        boxShadow: running
          ? 'var(--material-card-shadow), 0 0 0 1px var(--proto-accent-border)'
          : `var(--material-card-shadow), 0 0 0 1px ${hover ? 'var(--proto-line-3)' : 'var(--proto-line-2)'}`,
      }}
    >
      <div
        onClick={() => setOpen((o) => !o)}
        style={{
          padding: '10px 12px',
          cursor: 'pointer',
          borderBottom: '1px solid ' + (open ? 'var(--proto-line-soft)' : 'transparent'),
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ display: 'inline-flex', color: iconColor, stroke: iconColor }}>{NODE_ICON}</span>
          <span title={thread.templateName} style={{ font: "600 12.5px 'IBM Plex Mono',monospace", color: 'var(--proto-ink)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {thread.templateName}
          </span>
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 11,
              flex: 'none',
              fontWeight: 600,
              padding: '2px 8px',
              borderRadius: 'var(--r-pill)',
              background: pill.bg,
              color: pill.fg,
            }}
          >
            {pill.text}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 5 }}>
          <span style={{ font: "400 11px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)' }}>
            {threadMetaLine(thread, now)}
          </span>
          {hasDots && dots && (
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <span style={{ font: "500 11px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)', marginRight: 2 }}>
                {L.rpDepth}
              </span>
              {Array.from({ length: dots.total }).map((_, i) => (
                <span
                  key={i}
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: '50%',
                    background: i < dots.filled ? 'var(--proto-accent)' : 'var(--proto-line)',
                  }}
                />
              ))}
              <span style={{ font: "500 11px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)', marginLeft: 2 }}>
                {dots.text}
              </span>
            </span>
          )}
        </div>
      </div>
      {open && detailQuery.isPending && (
        <div style={{ padding: '10px 14px', fontSize: 11, color: 'var(--proto-muted)' }}>{L.rpLoadingThread}</div>
      )}
      {open && detailQuery.isError && (
        <div style={{ padding: '10px 14px', fontSize: 11, color: 'var(--proto-danger)' }}>
          {L.rpFailedLoadThread}
        </div>
      )}
      {open && detail && <CardBody detail={detail} threadId={thread.id} />}
    </div>
  );
}
