// input:  thread artifact/pipeline presentation components and neutral VMs
// output: desktop detail copy and inline artifact regressions
// pos:    Guards modal-era thread detail presentation
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { LangProvider } from '@/i18n';
import type { ThreadDetail } from '@cortex-agent/ui-contract';
import { ThreadArtifactPanel } from './ThreadArtifactPanel';
import { ThreadDetailView } from './ThreadDetailView';
import { ThreadPipeline } from './ThreadPipeline';
import type { DetailArtifact, ThreadDetailVm } from './thread-detail-vm';

const artifact = {
  path: '/tmp/threads/thr_demo/artifact.md',
  live: true,
  updated: 'just now',
  taskId: 'ab12',
  taskProject: 'my-project',
  workspacePath: '/tmp/threads/thr_demo',
  writtenBy: [],
  content: '# Verified artifact\n\nBody marker.',
} as DetailArtifact;

const detail = {
  id: 'thr_demo', templateName: 'worker-review', currentStep: null,
  status: 'completed', projectId: 'my-project',
  createdAt: '2026-07-06T00:00:00.000Z', updatedAt: '2026-07-06T00:00:01.000Z',
  totalSteps: 0, artifactPath: artifact.path, endedAt: '2026-07-06T00:00:01.000Z',
  error: null, abortReason: null, activeAgent: null, activeStage: null, totalCostUsd: 0.01,
  steps: [], agentFlow: null, dispatches: [], subtasks: [], children: [],
  artifacts: {
    artifactPath: artifact.path, workspacePath: artifact.workspacePath,
    taskId: artifact.taskId, taskProject: artifact.taskProject, content: artifact.content,
  },
} as ThreadDetail;

const pipelineVm = {
  name: 'worker-review',
  tid: 'thr_demo',
  pill: { bg: '#fff', fg: '#000', text: 'Done' },
  template: 'worker-review',
  started: '12:00',
  elapsed: '00:01',
  cost: 'Σ $0.01',
  task: 'ab12',
  depthDots: [],
  depthText: '1/5',
  live: false,
  steps: [],
  artifact,
} as ThreadDetailVm;

it('renders artifact Markdown directly below references without an Open action or hint', () => {
  const html = renderToStaticMarkup(
    <LangProvider><ThreadArtifactPanel artifact={artifact} /></LangProvider>,
  );
  expect(html).toContain('REFERENCES');
  expect(html).toContain('Verified artifact');
  expect(html).toContain('Body marker.');
  expect(html).not.toContain('created with thread');
  expect(html).not.toContain('Open ↗');
});

it('shows the pipeline heading without the expansion hint', () => {
  const html = renderToStaticMarkup(
    <LangProvider>
      <ThreadPipeline vm={pipelineVm} onOpenSub={() => {}} renderStepChat={() => null} />
    </LangProvider>,
  );
  expect(html).toContain('PIPELINE');
  expect(html).not.toContain('click a step to expand');
});

it('renders a close-only detail header without route navigation', () => {
  const html = renderToStaticMarkup(
    <LangProvider>
      <ThreadDetailView detail={detail} now={Date.parse(detail.updatedAt)} onClose={() => {}}
        onOpenThread={() => {}} onCancel={() => {}} renderStepChat={() => null} />
    </LangProvider>,
  );
  expect(html).toContain('data-close-thread-detail="true"');
  expect(html).not.toContain('data-thread-navigation');
  expect(html).not.toContain('‹');
});
