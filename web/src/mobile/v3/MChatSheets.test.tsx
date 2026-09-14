import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { SessionStatsRow } from '@/features/workbench/session-stats';
import type { MChatCopy } from './MChatView.types';
import type { SelectionSheetSection } from './m-chat-vm';

// MBottomSheet's entrance animation needs rAF and window.history; this suite is about what the
// sheet SAYS, so the chrome is stubbed exactly as MScheduleSheet's suite does.
vi.mock('@/mobile/ui/kit', async () => ({
  ...(await vi.importActual<typeof import('@/mobile/ui/kit')>('@/mobile/ui/kit')),
  MBottomSheet: ({ children }: any) => <div data-bottom-sheet>{children}</div>,
}));

const { SessionStatsSheet, MoreMenu, SelectionSheet } = await import('./MChatSheets');

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

// `buildSelectionSheet` decides what the rows SAY (m-chat-vm.test); this is only about drawing them:
// three sections in the product's order, and a disabled row that neither fires nor hides its reason.

const selectionCopy = {
  profileTitle: 'Engine', profileSubtitle: 'this session', profileCurrent: 'current',
  profileFooter: 'next turns only', selectionPending: 'loading models…',
} as unknown as MChatCopy;

const sections: SelectionSheetSection[] = [
  { key: 'profile', title: 'PROFILE', rows: [
    { id: 'profile:plan', label: 'plan', sub: 'opus · claude', current: true, disabled: false, hint: null, change: null },
    { id: 'profile:ds', label: 'ds', sub: 'glm-5 · pi', current: false, disabled: true, hint: 'needs a new session', change: null },
  ] },
  { key: 'model', title: 'MODEL', rows: [
    { id: 'model:follow', label: 'follow profile', sub: 'opus', current: true, disabled: false, hint: null, change: null },
    { id: 'model:claude::sonnet', label: 'sonnet', sub: 'claude', current: false, disabled: false, hint: null, change: { selection: { model: 'sonnet' } } },
  ] },
  { key: 'thinking', title: 'THINKING', rows: [
    { id: 'thinking:high', label: 'high', sub: null, current: false, disabled: false, hint: null, change: { selection: { thinking: 'high' } } },
  ] },
];

function renderSheet(pending = true) {
  const onPick = vi.fn();
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <SelectionSheet sections={sections} pending={pending} copy={selectionCopy} onClose={() => {}} onPick={onPick} />,
    );
  });
  return { renderer, onPick };
}

describe('SelectionSheet', () => {
  it('draws profile, model and thinking in that order', () => {
    const { renderer } = renderSheet();
    const html = JSON.stringify(renderer.toJSON());
    const at = ['PROFILE', 'MODEL', 'THINKING'].map((title) => html.indexOf(title));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('picks a row, and notes a model list that has not arrived yet', () => {
    const { renderer, onPick } = renderSheet();
    act(() => renderer.root.findByProps({ 'data-selection-row': 'model:claude::sonnet' }).props.onClick());
    expect(onPick).toHaveBeenCalledWith(sections[1].rows[1]);
    expect(JSON.stringify(renderer.toJSON())).toContain('loading models');
  });

  it('says nothing about loading once the models are in', () => {
    const { renderer } = renderSheet(false);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('loading models');
  });

  it('a disabled row says why, and does not fire', () => {
    const { renderer, onPick } = renderSheet();
    const row = renderer.root.findByProps({ 'data-selection-row': 'profile:ds' });
    expect(row.props['data-disabled']).toBe('true');
    act(() => row.props.onClick());
    expect(onPick).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).toContain('needs a new session');
  });

  it('marks what is running now, and prefers the reason over the sub-label', () => {
    const { renderer } = renderSheet();
    const html = JSON.stringify(renderer.toJSON());
    expect(html).toContain('current');
    expect(html).not.toContain('glm-5 · pi');
  });
});
