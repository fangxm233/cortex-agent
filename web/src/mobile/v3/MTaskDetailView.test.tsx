import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TaskInfo, TaskVerificationInfo, TaskDispatchRecord } from '@cortex-agent/ui-contract';
import { MTaskDetailView, ZH_COPY } from './MTaskDetailView';
import { buildTaskDetailVm } from './m-task-detail-vm';

function task(over: Partial<TaskInfo>): TaskInfo {
  return {
    id: '001',
    text: 'run DR sweep — friction ∈ [0.6, 1.2]',
    project: 'atlas',
    status: 'open',
    priority: 'high',
    actionable: false,
    claimedBy: 'exec_dispatch_x',
    blockedBy: null,
    dependsOn: [],
    plan: null,
    template: 'experiment-pipeline',
    why: null,
    doneWhen: 'report has 8 seed curves; ci95 on agent success',
    ...over,
  };
}

function dispatch(over: Partial<TaskDispatchRecord>): TaskDispatchRecord {
  return {
    executionId: 'exec_1',
    type: 'dispatch',
    status: 'running',
    machine: 'app-lab2',
    threadId: 'thr_nimbus',
    startedAt: '2026-07-15T11:18:00Z',
    finishedAt: null,
    durationMs: 42 * 60 * 1000,
    cost: 2.31,
    ...over,
  };
}

function verification(over: Partial<TaskVerificationInfo>): TaskVerificationInfo {
  return {
    taskId: '001',
    project: 'atlas',
    evidence: { doneWhen: null, completed: false, completedAt: null, completedNote: null, completingExecutionId: null, completingOutput: null },
    dispatches: [],
    ...over,
  };
}

const NOW = Date.parse('2026-07-15T12:00:00Z');

function render(tasks: TaskInfo[], v: TaskVerificationInfo | null, id = '001') {
  const vm = buildTaskDetailVm(id, tasks, v, NOW);
  return renderToStaticMarkup(
    <MTaskDetailView vm={vm} copy={ZH_COPY} onBack={() => {}} onOpenThread={() => {}} />,
  );
}

describe('MTaskDetailView', () => {
  it('renders the header id, in-progress pill and the faint tasks.json tag', () => {
    const html = render([task({})], verification({ dispatches: [dispatch({})] }));
    expect(html).toContain('T-001');
    expect(html).toContain('进行中');
    expect(html).toContain('tasks.json');
  });

  it('renders the task text and the real done-when', () => {
    const html = render([task({})], null);
    expect(html).toContain('DR sweep');
    expect(html).toContain('DONE-WHEN');
    expect(html).toContain('8 seed curves');
  });

  it('renders an honest gap when done-when is null', () => {
    const html = render([task({ doneWhen: null })], null);
    expect(html).toContain(ZH_COPY.doneWhenGap);
  });

  it('renders the claim card with template, real thread id and elapsed·cost meta', () => {
    const html = render([task({})], verification({ dispatches: [dispatch({})] }));
    expect(html).toContain('experiment-pipeline');
    expect(html).toContain('thr_nimbus');
    expect(html).toContain('42m · $2.31');
    expect(html).toContain('打开');
  });

  it('omits the claim card when unclaimed', () => {
    const html = render([task({ claimedBy: null })], verification({ dispatches: [] }));
    expect(html).not.toContain('experiment-pipeline');
  });

  it('renders the priority row (real high) and a dependency row with joined status', () => {
    const dep = task({ id: '038', text: 'upstream', claimedBy: null, blockedBy: 'gate', dependsOn: [] });
    const html = render([task({ dependsOn: ['038'] }), dep], null);
    expect(html).toContain('优先级');
    expect(html).toContain('P高');
    expect(html).toContain('依赖');
    expect(html).toContain('T-038');
    expect(html).toContain('阻塞');
  });

  it('omits 来源 (source session) — no DTO field', () => {
    const html = render([task({})], null);
    expect(html).not.toContain('来源');
  });

  it('renders dispatch history rows newest-first; honest empty otherwise', () => {
    const withHist = render(
      [task({})],
      verification({ dispatches: [dispatch({ status: 'completed' }), dispatch({ executionId: 'e0', status: 'running', startedAt: '2026-07-14T09:00:00Z' })] }),
    );
    expect(withHist).toContain('历史');
    expect(withHist).toContain('完成');
    const empty = render([task({})], verification({ dispatches: [] }));
    expect(empty).toContain(ZH_COPY.historyEmpty);
  });

  it('renders the read-only footer line', () => {
    const html = render([task({})], null);
    expect(html).toContain('只读');
  });

  it('renders a not-found state when the task is absent', () => {
    const html = render([task({})], null, 'zzzz');
    expect(html).toContain(ZH_COPY.notFound);
  });
});
