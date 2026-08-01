// input:  mobile thread groups, header copy, budget state, Chrome
// output: section rendering and pipeline containment regressions
// pos:    Verifies the mobile Threads grouped list and card layout
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ThreadInfo } from '@cortex-agent/ui-contract';
import type { ThreadGroup } from '@/features/workbench/scope';
import {
  MRunningCard,
  MThreadSections,
  MThreadsHeader,
  type MThreadsCopy,
} from './MThreadsView';

const chrome = [
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((candidate): candidate is string => !!candidate && existsSync(candidate)) ?? null;

const copy: MThreadsCopy = {
  title: 'Threads',
  active: 'Active',
  history: 'History',
  today: 'Today',
  open: 'Open',
  subthread: 'subthreads',
  empty: 'No threads',
  running: 'Running',
  waiting: 'Waiting',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function thread(id: string, status: ThreadInfo['status']): ThreadInfo {
  return {
    id,
    templateName: 'coder-review',
    currentStep: null,
    status,
    projectId: 'nimbus',
    createdAt: '2026-07-30T15:00:00.000Z',
    updatedAt: '2026-07-30T16:00:00.000Z',
    totalSteps: 2,
    artifactPath: null,
  };
}

describe('MThreadsHeader', () => {
  it('renders the budget header without segmented scope controls', () => {
    const html = renderToStaticMarkup(
      <MThreadsHeader copy={copy} band={{ numerator: '$0.00', denominator: '—', pct: 0 }} />,
    );

    expect(html).toContain('Threads');
    expect(html).not.toContain('Last 1 day');
    expect(html).not.toContain('aria-pressed');
  });
});

describe('MThreadSections', () => {
  it('renders active and history headings with counts', () => {
    const groups: ThreadGroup[] = [
      { kind: 'active', threads: [thread('run', 'running'), thread('wait', 'waiting')] },
      { kind: 'history', threads: [thread('done', 'completed')] },
    ];
    const html = renderToStaticMarkup(
      <MThreadSections
        groups={groups}
        copy={copy}
        renderThread={(item) => <div key={item.id}>{item.id}</div>}
      />,
    );

    expect(html).toContain('Active · 2');
    expect(html).toContain('History · 1');
    expect(html).toContain('run');
    expect(html).toContain('done');
  });
});

function renderPipelineFixture(): string {
  const info = {
    ...thread('thr_layout', 'running'),
    templateName: 'manager',
    currentStep: { index: 7, name: '#8' },
    totalSteps: 8,
  } satisfies ThreadInfo;
  return renderToStaticMarkup(
    <div id="fixture" style={{ width: 320 }}>
      <MRunningCard info={info} now={Date.parse(info.updatedAt)} copy={copy} onOpen={() => {}} />
    </div>,
  );
}

function probePipelineLayout(markup: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cortex-mobile-thread-layout-'));
  const file = path.join(dir, 'fixture.html');
  const script = `<script>const card=document.querySelector('#fixture>div');const pipeline=card.children[1];document.body.dataset.overflow=String(pipeline.scrollWidth>pipeline.clientWidth+1)</script>`;
  writeFileSync(file, `<!doctype html><style>*{box-sizing:border-box}body{margin:0}</style>${markup}${script}`);
  try {
    return execFileSync(
      chrome!,
      ['--headless=new', '--no-sandbox', '--disable-gpu', '--dump-dom', pathToFileURL(file).href],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('MRunningCard pipeline layout', () => {
  it.skipIf(chrome === null)('keeps an eight-step pipeline inside a narrow mobile card', () => {
    const dumpedHtml = probePipelineLayout(renderPipelineFixture());
    expect(dumpedHtml).toContain('data-overflow="false"');
  });
});
