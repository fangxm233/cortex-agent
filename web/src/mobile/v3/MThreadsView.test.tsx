// input:  mobile thread header copy and segment state
// output: recent segment rendering regression
// pos:    Verifies the mobile Threads recent filter
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MThreadsHeader, type MThreadsCopy } from './MThreadsView';

const copy: MThreadsCopy = {
  title: 'Threads',
  active: 'Active',
  recent: 'Last 1 day',
  history: 'History',
  today: 'Today',
  open: 'Open',
  subthread: 'subthreads',
  empty: 'No threads',
  running: 'Running',
  waiting: 'Suspended',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

describe('MThreadsHeader', () => {
  it('renders and selects the recent segment', () => {
    const html = renderToStaticMarkup(
      <MThreadsHeader
        copy={copy}
        segment="recent"
        activeCount={2}
        band={{ numerator: '$0.00', denominator: '—', pct: 0 }}
        onSegment={() => {}}
      />,
    );
    expect(html).toContain('Last 1 day');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Last 1 day/);
  });
});
