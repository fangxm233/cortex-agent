import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ThreadInfo, ThreadDetail, ThreadStepDetail } from '@cortex-agent/ui-contract';
import { MThreadsHeader, MRunningCard, MWaitingCard, type MThreadsCopy } from './MThreadsView';
import { threadsBudgetBand } from './m-threads-vm';

const copy: MThreadsCopy = {
  title: '线程',
  active: '活跃',
  history: '历史',
  today: '今日',
  open: '打开',
  handle: '去处理',
  subthread: '子线程',
  empty: '暂无活跃线程',
  running: '运行中',
  waiting: '等待审批',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

function info(over: Partial<ThreadInfo>): ThreadInfo {
  return {
    id: 'thr_1a2b',
    templateName: 'experiment-pipeline',
    currentStep: { index: 2, name: 'review' },
    status: 'running',
    projectId: 'nimbus',
    createdAt: '2026-07-15T11:18:00Z',
    updatedAt: '2026-07-15T12:00:00Z',
    totalSteps: 4,
    artifactPath: null,
    ...over,
  };
}
function step(over: Partial<ThreadStepDetail>): ThreadStepDetail {
  return {
    stepIndex: 0, agentSlotId: 'a0', stage: null, status: 'pending', executionId: null,
    sessionId: null, sessionName: null, costUsd: null, numTurns: null, durationS: null,
    startedAt: null, endedAt: null, outputSummary: null, ...over,
  };
}
function detail(over: Partial<ThreadDetail>): ThreadDetail {
  return {
    id: 'thr_1a2b', templateName: 'experiment-pipeline', currentStep: { index: 2, name: 'review' },
    status: 'running', projectId: 'nimbus', createdAt: '2026-07-15T11:18:00Z',
    updatedAt: '2026-07-15T12:00:00Z', totalSteps: 4, artifactPath: null, endedAt: null, error: null,
    abortReason: null, activeAgent: null, activeStage: null, totalCostUsd: 2.31, steps: [],
    agentFlow: null, dispatches: [], children: [],
    artifacts: { artifactPath: null, workspacePath: null, taskId: null, taskProject: null }, ...over,
  };
}
const now = Date.parse('2026-07-15T12:00:00Z');

describe('MThreadsHeader', () => {
  it('renders title, qn scope tag, 活跃 count, 历史, and the 今日 budget band', () => {
    const html = renderToStaticMarkup(
      <MThreadsHeader
        copy={copy}
        qn="NI"
        segment="active"
        activeCount={3}
        band={threadsBudgetBand(4.21, 10)}
        onSegment={() => {}}
      />,
    );
    expect(html).toContain('线程');
    expect(html).toContain('NI');
    expect(html).toContain('活跃 3');
    expect(html).toContain('历史');
    expect(html).toContain('今日');
    expect(html).toContain('$4.21 / $10.00');
    expect(html).toContain('width:42.1%'); // real bar fill
  });
});

describe('MRunningCard', () => {
  it('renders template + 运行中 pill + real pipeline stages + meta with cost/children + 打开 ›', () => {
    const d = detail({
      totalCostUsd: 2.31,
      children: [
        { id: 'c1', templateName: 'verify-metrics', status: 'running', activeAgent: null, costUsd: 0, depth: 1, createdAt: now + '', taskId: null, children: [], truncated: false },
      ],
      steps: [
        step({ stepIndex: 0, stage: 'plan', status: 'completed' }),
        step({ stepIndex: 1, stage: 'execute', status: 'completed' }),
        step({ stepIndex: 2, stage: 'review', status: 'running' }),
        step({ stepIndex: 3, stage: 'submit', status: 'pending' }),
      ],
    });
    const html = renderToStaticMarkup(
      <MRunningCard info={info({})} detail={d} now={now} copy={copy} onOpen={() => {}} />,
    );
    expect(html).toContain('experiment-pipeline');
    expect(html).toContain('运行中');
    expect(html).toContain('plan');
    expect(html).toContain('review');
    expect(html).toContain('submit');
    expect(html).toContain('thr_1a2b · 42m · $2.31 · 1 子线程');
    expect(html).toContain('打开');
    expect(html).toContain('✓'); // completed step glyph
  });

  it('renders the pipeline from the list summary before detail loads (no fabricated cost)', () => {
    const html = renderToStaticMarkup(
      <MRunningCard info={info({})} detail={undefined} now={now} copy={copy} onOpen={() => {}} />,
    );
    expect(html).toContain('thr_1a2b · 42m');
    expect(html).not.toContain('$'); // no cost until detail loads
  });
});

describe('MRunningCard history status', () => {
  it('a terminal thread shows its real status pill, not 运行中', () => {
    const html = renderToStaticMarkup(
      <MRunningCard info={info({ status: 'completed' })} detail={undefined} now={now} copy={copy} onOpen={() => {}} />,
    );
    expect(html).toContain('已完成');
    expect(html).not.toContain('运行中');
  });
});

describe('MWaitingCard', () => {
  it('renders amber 等待审批 pill + honest meta + 去处理 › (amber ink)', () => {
    const html = renderToStaticMarkup(
      <MWaitingCard
        info={info({ id: 'thr_a41d', templateName: 'ablation-sweep', status: 'waiting' })}
        now={now}
        copy={copy}
        onHandle={() => {}}
      />,
    );
    expect(html).toContain('ablation-sweep');
    expect(html).toContain('等待审批');
    expect(html).toContain('thr_a41d · 42m');
    expect(html).toContain('去处理');
    expect(html).toContain('#8A5B06'); // amber ink affordance
    expect(html).not.toContain('超预算'); // mock, not rendered
  });
});
