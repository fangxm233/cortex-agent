// input:  chat sheet copy and formatted session-totals rows
// output: session-stats sheet content regressions behind a stubbed bottom sheet
// pos:    Mobile chat sheet presentation specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { SessionStatsRow } from '@/features/workbench/session-stats';
import type { MChatCopy } from './MChatView.types';

// MBottomSheet's entrance animation needs rAF and window.history; this suite is about what the
// sheet SAYS, so the chrome is stubbed exactly as MScheduleSheet's suite does.
vi.mock('@/mobile/ui/kit', async () => ({
  ...(await vi.importActual<typeof import('@/mobile/ui/kit')>('@/mobile/ui/kit')),
  MBottomSheet: ({ children }: any) => <div data-bottom-sheet>{children}</div>,
}));

const { SessionStatsSheet, MoreMenu } = await import('./MChatSheets');

const copy = {
  menuSessionId: 'Session ID',
  menuSessionStats: 'Session stats',
  sessionStatsTitle: 'Session stats',
  sessionStatsHint: 'Totals for the whole conversation.',
} as MChatCopy;

const ROWS: SessionStatsRow[] = [
  { key: 'runs', label: 'Runs', value: '13 runs' },
  { key: 'turns', label: 'Agent turns', value: '512 turns' },
  { key: 'active', label: 'Active time', value: '3h 12m' },
  { key: 'span', label: 'Open since first message', value: '2d 4h' },
  { key: 'cost', label: 'Total cost', value: '$48.20' },
  { key: 'subagent', label: 'Of which subagents', value: '$7.54' },
];

function render(node: JSX.Element): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(node); });
  return renderer;
}

describe('SessionStatsSheet', () => {
  it('lists every row it is given, label and value, plus the semantics hint', () => {
    const tree = render(<SessionStatsSheet copy={copy} rows={ROWS} onClose={() => {}} />);
    const keys = tree.root.findAll((node) => !!node.props['data-session-stats-row'])
      .map((node) => node.props['data-session-stats-row']);
    expect(keys).toEqual(['runs', 'turns', 'active', 'span', 'cost', 'subagent']);

    const markup = JSON.stringify(tree.toJSON());
    expect(markup).toContain('$48.20');
    expect(markup).toContain('$7.54');
    // The hint is what stops the asymmetry (cost includes children, time and turns do not) from
    // being a silent surprise.
    expect(markup).toContain('Totals for the whole conversation.');
    act(() => tree.unmount());
  });
});

describe('MoreMenu', () => {
  it('offers session stats only when there are totals, and always offers the session id', () => {
    const withoutStats = render(<MoreMenu copy={copy} onClose={() => {}} onSessionId={() => {}} />);
    const labels = (node: ReactTestRenderer): string[] =>
      node.root.find((n) => n.type === 'div' && n.props.style?.width === 148)
        .children.map((child: any) => child.children.join(''));
    expect(labels(withoutStats)).toEqual(['Session ID']);
    act(() => withoutStats.unmount());

    const onSessionStats = vi.fn();
    const withStats = render(
      <MoreMenu copy={copy} onClose={() => {}} onSessionId={() => {}} onSessionStats={onSessionStats} />,
    );
    expect(labels(withStats)).toEqual(['Session ID', 'Session stats']);
    act(() => withStats.unmount());
  });
});
