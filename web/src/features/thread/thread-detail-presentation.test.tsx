// input:  thread detail views, neutral VMs, and Chrome layout probe
// output: desktop detail copy, rendering, and overflow regressions
// pos:    Guards modal-era thread detail presentation
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { LangProvider } from '@/i18n';
import type { ThreadDetail } from '@cortex-agent/ui-contract';
import { ThreadArtifactPanel } from './ThreadArtifactPanel';
import { ThreadDetailView } from './ThreadDetailView';
import { ThreadPipeline } from './ThreadPipeline';
import type { DetailArtifact, ThreadDetailVm } from './thread-detail-vm';

const chrome = [
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((candidate): candidate is string => !!candidate && existsSync(candidate)) ?? null;

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

function probeArtifactOverflow(markup: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cortex-artifact-layout-'));
  const file = path.join(dir, 'fixture.html');
  const script = `<script>const content=document.querySelector('[data-artifact-content="true"]');const scroller=content.parentElement;document.body.dataset.overflow=String(scroller.scrollWidth>scroller.clientWidth)</script>`;
  writeFileSync(file, `<!doctype html><style>*{box-sizing:border-box}body{margin:0}</style>${markup}${script}`);
  try {
    return execFileSync(chrome!, ['--headless=new', '--no-sandbox', '--disable-gpu', '--dump-dom', pathToFileURL(file).href], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it.skipIf(chrome === null)('keeps long inline-code paths within the artifact body', () => {
  const longPathArtifact = {
    ...artifact,
    content: '- `/srv/atlas/runtime/thread-workspaces/thread_with_a_very_long_identifier/artifact.md` — retained.',
  };
  const markup = renderToStaticMarkup(
    <LangProvider>
      <div style={{ display: 'flex', width: 440, height: 600 }}>
        <ThreadArtifactPanel artifact={longPathArtifact} />
      </div>
    </LangProvider>,
  );
  expect(probeArtifactOverflow(markup)).toContain('data-overflow="false"');
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
