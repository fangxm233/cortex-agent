// input:  mobile task view copy and segment state
// output: recent segment rendering regression
// pos:    Verifies the mobile Tasks recent filter
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MTasksView, type MTasksCopy } from './MTasksView';

const copy: MTasksCopy = {
  title: 'Tasks',
  executable: 'Executable',
  recent: 'Last 1 day',
  all: 'All',
  inProgress: 'In progress',
  claimable: 'Executable',
  blocked: 'Blocked',
  claim: 'claim',
  doneWhen: 'done-when',
  doneWhenGap: 'no done-when recorded',
  waitApproval: 'awaiting approval',
  seeApprovals: 'see project approvals',
  done: 'Done',
  empty: 'No tasks',
};

describe('MTasksView', () => {
  it('renders and selects the recent segment', () => {
    const html = renderToStaticMarkup(
      <MTasksView
        groups={[]}
        segment="recent"
        executableCount={1}
        recentCount={2}
        allCount={3}
        copy={copy}
        expandedIds={new Set()}
        onToggleExpand={() => {}}
        onSegment={() => {}}
        onOpenTask={() => {}}
        onOpenThread={() => {}}
        onOpenApprovals={() => {}}
      />,
    );
    expect(html).toContain('Last 1 day 2');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Last 1 day 2/);
  });
});
