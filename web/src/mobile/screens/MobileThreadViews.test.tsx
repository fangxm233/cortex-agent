// input:  legacy mobile thread views and DTO fixtures
// output: legacy mobile thread render tests
// pos:    Verifies legacy mobile thread presentation
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ThreadInfo, ThreadDetail, ThreadChildNode } from '@cortex-agent/ui-contract';
import { en as vocab } from '@/i18n';
import { MobileThreadsHeader, MobileThreadCardView } from './MobileThreadViews';
import { budgetBand } from './mobile-thread-vm';

// Presentational render checks for the 5b 线程 screen (design scheme.dc.html L3005–3108). The
// containers (MobileThreadsScreen / MobileThreadCard) bind real tRPC; these views are prop-driven so
// they render-test without a query client (desktop thread-detail-render precedent).

const info: ThreadInfo = {
  id: 'thr_8f2c',
  templateName: 'experiment-pipeline',
  currentStep: { index: 2, name: 'review' },
  status: 'running',
  projectId: 'p',
  createdAt: new Date(Date.now() - 42 * 60_000).toISOString(),
  updatedAt: new Date().toISOString(),
  totalSteps: 4,
  artifactPath: null,
};

const l3: ThreadChildNode = {
  id: 'thr_l3',
  templateName: 'stats-audit',
  status: 'running',
  activeAgent: null,
  costUsd: 0.4,
  depth: 1,
  createdAt: new Date().toISOString(),
  taskId: null,
  children: [],
  truncated: false,
};

const l2: ThreadChildNode = {
  id: 'thr_l2',
  templateName: 'verify-metrics',
  status: 'running',
  activeAgent: null,
  costUsd: 1.1,
  depth: 0,
  createdAt: new Date().toISOString(),
  taskId: null,
  children: [l3],
  truncated: false,
};

const detail: ThreadDetail = {
  id: 'thr_8f2c',
  templateName: 'experiment-pipeline',
  currentStep: { index: 2, name: 'review' },
  status: 'running',
  projectId: 'p',
  createdAt: info.createdAt,
  updatedAt: info.updatedAt,
  totalSteps: 4,
  artifactPath: null,
  endedAt: null,
  error: null,
  abortReason: null,
  activeAgent: null,
  activeStage: 'review',
  totalCostUsd: 2.52,
  steps: [
    { stepIndex: 0, agentSlotId: 'a0', stage: 'plan', status: 'completed', executionId: null, sessionId: null, sessionName: null, costUsd: 0.3, numTurns: null, durationS: 180, startedAt: null, endedAt: null, outputSummary: null },
    { stepIndex: 1, agentSlotId: 'a1', stage: 'implement', status: 'running', executionId: null, sessionId: null, sessionName: null, costUsd: null, numTurns: null, durationS: null, startedAt: new Date(Date.now() - 252_000).toISOString(), endedAt: null, outputSummary: null },
    { stepIndex: 2, agentSlotId: 'a2', stage: 'commit', status: 'pending', executionId: null, sessionId: null, sessionName: null, costUsd: null, numTurns: null, durationS: null, startedAt: null, endedAt: null, outputSummary: null },
  ],
  agentFlow: null,
  dispatches: [],
  subtasks: [],
  children: [l2],
  artifacts: { artifactPath: null, workspacePath: null, taskId: null, taskProject: null },
};

const noop = () => {};

describe('MobileThreadsHeader', () => {
  const html = renderToStaticMarkup(
    <MobileThreadsHeader vocab={vocab} segment="active" activeCount={3} band={budgetBand(4.21)} onSegment={noop} />,
  );
  it('renders the title + active segment count + inactive History', () => {
    expect(html).toContain(vocab.threads);
    expect(html).toContain(`${vocab.active} 3`);
    expect(html).toContain(vocab.history);
  });
  it('budget band: real numerator, honest "—" denominator, 0% fill', () => {
    expect(html).toContain(vocab.today);
    expect(html).toContain('$4.21');
    expect(html).toContain('/ —');
    expect(html).toContain('width:0%');
  });
});

describe('MobileThreadCardView — collapsed (Card B)', () => {
  const html = renderToStaticMarkup(
    <MobileThreadCardView thread={{ ...info, status: 'waiting', id: 'thr_a41d', templateName: 'nightly-digest' }} now={Date.now()} vocab={vocab} expanded={false} onToggle={noop} onCancel={noop} onDrill={noop} />,
  );
  it('shows the ▸ prefix, name, waiting pill, and sub-line', () => {
    expect(html).toContain('▸');
    expect(html).toContain('nightly-digest');
    expect(html).toContain(vocab.pillWaiting);
    expect(html).toContain('thr_a41d');
  });
});

describe('MobileThreadCardView — expanded (Card A) with real detail', () => {
  const html = renderToStaticMarkup(
    <MobileThreadCardView thread={info} detail={detail} now={Date.now()} vocab={vocab} expanded onToggle={noop} onCancel={noop} onDrill={noop} />,
  );
  it('header: name + running pill + meta with 步骤 and 深度', () => {
    expect(html).toContain('experiment-pipeline');
    expect(html).toContain(vocab.pillRunning);
    expect(html).toContain(`${vocab.step} 3/4`);
    expect(html).toContain(vocab.depth);
  });
  it('step dots: done ✓, running cxpulse, pending outline', () => {
    expect(html).toContain('✓');
    expect(html).toContain('cxpulse');
  });
  it('step labels are real stage names (data, not i18n)', () => {
    expect(html).toContain('plan');
    expect(html).toContain('implement');
    expect(html).toContain('commit');
  });
  it('L2 sub-card (verify-metrics, L2) with an L3 drill "打开 ›" row', () => {
    expect(html).toContain('verify-metrics');
    expect(html).toContain('L2');
    expect(html).toContain('stats-audit');
    expect(html).toContain('L3');
    expect(html).toContain(`${vocab.open} ›`);
  });
  it('footer: 暂停 / 取消 / Σ cost', () => {
    expect(html).toContain(vocab.pause);
    expect(html).toContain(vocab.cancel);
    expect(html).toContain('Σ $2.52');
  });
});
