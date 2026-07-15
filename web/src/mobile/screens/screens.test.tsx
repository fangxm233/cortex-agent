import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { en } from '@/i18n';
import { MobileMachinesView } from './MobileMachinesScreen';
// All 6 mobile screen slots are now real tRPC-bound screens — there are no more STUB slots.
// 5a (MobileSessionsScreen), 5b (MobileThreadsScreen), 5c (MobileTasksScreen),
// 10e (MobileApprovalsScreen), 10f (MobileOverviewScreen), and 机器 (MobileMachinesScreen, 12c)
// all need query providers — they are covered by their own render tests + live harnesses.
// This file retains the structural screen contract for the machines screen via its exported
// pure presentational MobileMachinesView (no providers needed), as the slot-continuity guard.

describe('mobile screens structural contract', () => {
  it('machines: renders slot marker and reserves the status-bar gutter', () => {
    const html = renderToStaticMarkup(
      <MobileMachinesView cards={[]} vocab={en} now={0} />,
    );
    expect(html).toContain('data-screen-label="machines"');
    expect(html).toContain('padding-top:env(safe-area-inset-top)');
  });

  it('machines: renders the title from vocab (en)', () => {
    const html = renderToStaticMarkup(
      <MobileMachinesView cards={[]} vocab={en} now={0} />,
    );
    expect(html).toContain('Machines');
  });
});
