// input:  ThreadDetail DTO, tRPC hooks, task/thread modal APIs
// output: RightThreadCard with clickable run and waiting-task rows
// pos:    Expanded thread card and browser-probed step row renderer
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ThreadInfo, ThreadDetail, ThreadStepDetail, ThreadDispatchInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { useExecutionLogDrawer } from '@/features/execution/ExecutionLogDrawerProvider';
import { useTaskModal } from '@/features/tasks/TaskModalProvider';
import { dispatchesForStep } from '@/features/thread/thread-steps';
import { useThreadGetLiveSync } from '@/features/thread/useThreadGetLiveSync';
import { useThreadDetailModal } from '@/features/thread/ThreadDetailModal';
import {
  threadPill,
  stepDotKind,
  stepMeta,
  threadMetaLine,
  depthInfo,
  formatCost,
  cortexRunLabel,
  runActivity,
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
  idle: 'var(--proto-faint)',
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

function CortexRunCard({ run, onOpen }: { run: ThreadDispatchInfo; onOpen: (executionId: string) => void }) {
  const state = runActivity(run.status);
  const meta = [run.machine, run.taskId ? `task ${run.taskId}` : null].filter(Boolean).join(' · ');
  return (
    <div
      data-cortex-run={run.runName ?? ''}
      onClick={() => onOpen(run.executionId)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        border: `1px solid ${state.tone === 'running' ? 'var(--proto-accent-bg)' : 'var(--proto-line-2)'}`,
        background: 'var(--proto-rail)',
        borderRadius: 8,
        padding: '7px 10px',
        cursor: 'pointer',
      }}
    >
      <ActivityDot tone={state.tone} />
      <span style={{ minWidth: 0, font: "600 10.5px 'IBM Plex Mono',monospace", color: 'var(--proto-ink-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {cortexRunLabel(run)}
      </span>
      {meta && <span style={{ flex: 'none', font: "400 9.5px 'IBM Plex Mono',monospace", color: 'var(--proto-muted-3)' }}>{meta}</span>}
      <span style={{ marginLeft: 'auto', flex: 'none', font: "500 9.5px 'IBM Plex Mono',monospace", color: ACTIVITY_COLORS[state.tone] }}>
        {run.cost != null ? formatCost(run.cost) : state.label}
      </span>
    </div>
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
        borderRadius: 8,
        padding: '7px 10px',
        cursor: 'pointer',
      }}
    >
      <ActivityDot tone={state.tone} />
      <span style={{ flex: 'none', font: "600 10.5px 'IBM Plex Mono',monospace", color: 'var(--proto-ink-2)' }}>task {task.id}</span>
      <span style={{ minWidth: 0, fontSize: 9.5, color: 'var(--proto-muted-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{task.text}</span>
      <span style={{ marginLeft: 'auto', flex: 'none', fontSize: 9.5, fontWeight: 600, color: ACTIVITY_COLORS[state.tone] }}>{state.label}</span>
    </div>
  );
}

function ThreadActivityRows({
  runs,
  subtasks,
  onOpenRun,
  onOpenTask,
}: {
  runs: ThreadDispatchInfo[];
  subtasks: ThreadSubtaskInfo[];
  onOpenRun: (executionId: string) => void;
  onOpenTask: (taskId: string) => void;
}) {
  if (runs.length === 0 && subtasks.length === 0) return null;
  return (
    <div style={{ marginTop: 7, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {runs.map((run) => <CortexRunCard key={run.executionId} run={run} onOpen={onOpenRun} />)}
      {subtasks.map((task) => <SubtaskCard key={task.id} task={task} onOpen={onOpenTask} />)}
    </div>
  );
}

interface StepRowProps {
  step: ThreadStepDetail;
  isLast: boolean;
  detail: ThreadDetail;
  onOpenRun: (executionId: string) => void;
  onOpenTask: (taskId: string) => void;
}

function StepHeader({ label, meta, active, done }: { label: string; meta: string; active: boolean; done: boolean }) {
  const labelColor = active ? 'var(--proto-ink)' : done ? 'var(--proto-muted)' : 'var(--proto-faint)';
  return (
    <div style={{ display: 'flex', alignItems: 'baseline' }}>
      <span style={{ fontSize: 11.5, fontWeight: active ? 600 : 500, color: labelColor }}>{label}</span>
      <span
        style={{ marginLeft: 'auto', font: "400 9.5px 'IBM Plex Mono',monospace", color: active ? 'var(--proto-accent)' : 'var(--proto-faint)' }}
      >
        {meta}
      </span>
    </div>
  );
}

export function StepRow({ step, isLast, detail, onOpenRun, onOpenTask }: StepRowProps) {
  const L = useVocab();
  const kind = stepDotKind(step);
  const active = kind === 'running';
  const runs = active ? dispatchesForStep(detail, step) : [];
  const subtasks = active ? (detail.subtasks ?? []) : [];
  const hasActivities = runs.length > 0 || subtasks.length > 0;
  const label = step.stage ?? `${L.rpStep} ${step.stepIndex + 1}`;
  return (
    <>
      <StepDot kind={kind} hasTail={!isLast} />
      <div style={{ minWidth: 0, paddingBottom: isLast ? 4 : 9 }}>
        <StepHeader label={label} meta={stepMeta(step)} active={active} done={kind === 'done'} />
        {hasActivities && <ThreadActivityRows runs={runs} subtasks={subtasks}
          onOpenRun={onOpenRun} onOpenTask={onOpenTask} />}
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
    <div style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '8px 14px', borderTop: '1px solid var(--proto-line-2)' }}>
      <span title="Pause has no backend mutate op yet" style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--proto-muted)', cursor: 'not-allowed', opacity: 0.6 }}>{L.pause}</span>
      <span data-cancel-thread-id={threadId} onClick={() => cancel.mutate({ threadId })} style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--proto-danger)', cursor: 'pointer' }}>{L.cancel}</span>
      <span onClick={() => openThread(threadId)} style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--proto-accent)', cursor: 'pointer' }}>{L.open}</span>
      <span style={{ marginLeft: 'auto', font: "500 10px 'IBM Plex Mono',monospace", color: 'var(--proto-muted-3)' }}>Σ {formatCost(cost)}</span>
    </div>
  );
}

function CardBody({ detail, threadId }: { detail: ThreadDetail; threadId: string }) {
  const { open: openRun } = useExecutionLogDrawer();
  const { openTask } = useTaskModal();
  useThreadGetLiveSync(threadId);
  return (
    <>
      {detail.steps.length > 0 && (
        <div style={{ padding: '10px 14px 4px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '16px 1fr', columnGap: 9 }}>
            {detail.steps.map((step) => <StepRow key={step.stepIndex} step={step}
              isLast={step.stepIndex === detail.steps.length - 1} detail={detail} onOpenRun={openRun}
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
  const [open, setOpen] = useState(thread.status === 'running');
  const trpc = useTRPC();
  const detailQuery = useQuery({
    ...trpc.threads.get.queryOptions({ threadId: thread.id }),
    enabled: open,
  });

  const pill = threadPill(thread.status);
  const iconColor = thread.status === 'running' ? 'var(--proto-accent)' : 'var(--proto-muted-2)';
  const detail = open ? detailQuery.data : undefined;
  const dots = detail ? depthInfo(detail) : null;
  const hasDots = !!dots && dots.filled > 1;

  return (
    <div
      style={{
        background: 'var(--proto-card)',
        border: '1px solid var(--proto-line)',
        borderRadius: 10,
        boxShadow: '0 1px 2px rgba(16,24,40,.03)',
      }}
    >
      <div
        onClick={() => setOpen((o) => !o)}
        style={{
          padding: '11px 14px 9px',
          cursor: 'pointer',
          borderBottom: '1px solid ' + (open ? 'var(--proto-line-soft)' : 'transparent'),
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ display: 'inline-flex', color: iconColor, stroke: iconColor }}>{NODE_ICON}</span>
          <span style={{ font: "600 12.5px 'IBM Plex Mono',monospace", color: 'var(--proto-ink)' }}>
            {thread.templateName}
          </span>
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 10.5,
              fontWeight: 600,
              padding: '2px 8px',
              borderRadius: 999,
              background: pill.bg,
              color: pill.fg,
            }}
          >
            {pill.text}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5 }}>
          <span style={{ font: "400 10.5px 'IBM Plex Mono',monospace", color: 'var(--proto-muted-3)' }}>
            {threadMetaLine(thread, now)}
          </span>
          {hasDots && dots && (
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <span style={{ font: "500 9px 'IBM Plex Mono',monospace", color: 'var(--proto-muted-3)', marginRight: 2 }}>
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
              <span style={{ font: "500 9px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)', marginLeft: 2 }}>
                {dots.text}
              </span>
            </span>
          )}
        </div>
      </div>
      {open && detailQuery.isPending && (
        <div style={{ padding: '10px 14px', fontSize: 11, color: 'var(--proto-muted-3)' }}>{L.rpLoadingThread}</div>
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
