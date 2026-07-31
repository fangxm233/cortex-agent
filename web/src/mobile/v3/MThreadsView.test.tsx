// input:  mobile thread groups, header copy and budget state
// output: fixed active/history section rendering regressions
// pos:    Verifies the mobile Threads grouped list
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ThreadInfo } from '@cortex-agent/ui-contract';
import type { ThreadGroup } from '@/features/workbench/scope';
import { MThreadSections, MThreadsHeader, type MThreadsCopy } from './MThreadsView';

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
