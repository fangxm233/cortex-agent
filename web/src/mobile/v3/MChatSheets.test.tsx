import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { SessionStatsRow } from '@/features/workbench/session-stats';
import type { MChatCopy } from './MChatView.types';
import type { SelectionSheetVM } from './m-chat-vm';

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
// a root that lists the profiles and collapses the overrides, a pane behind each of those rows, and
// which pick closes the sheet — a profile is the wholesale move, a pane pick leaves it open so the
// next facet can be chosen in the same visit.

const selectionCopy = {
  profileTitle: 'Engine', profileSubtitle: 'this session', profileCurrent: 'current',
  profileFooter: 'next turns only', selectionPending: 'loading models…',
} as unknown as MChatCopy;

const vm: SelectionSheetVM = {
  sections: [
    { key: 'profile', title: 'PROFILE', rows: [
      { id: 'profile:plan', label: 'plan', sub: 'opus · claude', current: true, change: null },
      { id: 'profile:ds', label: 'ds', sub: 'glm-5 · pi', current: false, change: { profileName: 'ds' } },
    ], footer: '1 more profiles run on pi' },
    { key: 'model', title: 'MODEL', rows: [
      { id: 'model:follow', label: 'follow profile', sub: 'opus', current: true, change: null },
      { id: 'model:claude::sonnet', label: 'sonnet', sub: 'claude', current: false, change: { selection: { model: 'sonnet' } } },
    ], footer: '2 more models run on pi' },
    { key: 'thinking', title: 'THINKING', rows: [
      { id: 'thinking:high', label: 'high', sub: null, current: false, change: { selection: { thinking: 'high' } } },
    ] },
  ],
  rootRows: [
    { key: 'model', label: 'model', value: 'opus', overridden: false },
    { key: 'thinking', label: 'thinking', value: 'high', overridden: true },
  ],
  clearRow: { id: 'selection:clear', label: 'follow the profile for everything', sub: null, current: false, change: { selection: {} } },
};

function renderSheet(pending = true) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <SelectionSheet vm={vm} pending={pending} copy={selectionCopy} onClose={onClose} onPick={onPick} />,
    );
  });
  const open = (pane: string): void => {
    act(() => renderer.root.findByProps({ 'data-selection-pane': pane }).props.onClick());
  };
  return { renderer, onPick, onClose, open };
}

describe('SelectionSheet', () => {
  it('opens on the profile list with the overrides collapsed into one row each', () => {
    const { renderer } = renderSheet();
    const html = JSON.stringify(renderer.toJSON());
    expect(html).toContain('plan');
    expect(html).toContain('opus');       // the model row's value, without opening it
    expect(html).not.toContain('sonnet'); // the model pane itself stays closed
    expect(renderer.root.findAllByProps({ 'data-selection-pane': 'model' })).toHaveLength(1);
  });

  it('accounts for what the picker held back', () => {
    const { renderer } = renderSheet();
    expect(JSON.stringify(renderer.toJSON())).toContain('1 more profiles run on pi');
  });

  it('a pane pick sends the row, returns to the root and leaves the sheet open', () => {
    const { renderer, onPick, onClose, open } = renderSheet();
    open('model');
    act(() => renderer.root.findByProps({ 'data-selection-row': 'model:claude::sonnet' }).props.onClick());
    expect(onPick).toHaveBeenCalledWith(vm.sections[1].rows[1]);
    expect(onClose).not.toHaveBeenCalled();
    // Back at the root: the pane's rows are gone again.
    expect(renderer.root.findAllByProps({ 'data-selection-row': 'model:claude::sonnet' })).toHaveLength(0);
  });

  it('a profile pick closes the sheet — it replaces the whole engine', () => {
    const { renderer, onPick, onClose } = renderSheet();
    act(() => renderer.root.findByProps({ 'data-selection-row': 'profile:ds' }).props.onClick());
    expect(onPick).toHaveBeenCalledWith(vm.sections[0].rows[1]);
    expect(onClose).toHaveBeenCalled();
  });

  it('hands every override back at once from the root', () => {
    const { renderer, onPick } = renderSheet();
    act(() => renderer.root.findByProps({ 'data-selection-row': 'selection:clear' }).props.onClick());
    expect(onPick).toHaveBeenCalledWith(vm.clearRow);
  });

  it('notes a model list that has not arrived yet, inside the pane that is waiting for it', () => {
    const { renderer, open } = renderSheet();
    expect(JSON.stringify(renderer.toJSON())).not.toContain('loading models');
    open('model');
    expect(JSON.stringify(renderer.toJSON())).toContain('loading models');
  });

  it('says nothing about loading once the models are in', () => {
    const { renderer, open } = renderSheet(false);
    open('model');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('loading models');
  });

  it('steps back out of a pane without closing the sheet', () => {
    const { renderer, onClose, open } = renderSheet();
    open('model');
    act(() => renderer.root.findByProps({ 'data-selection-back': 'true' }).props.onClick());
    expect(onClose).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ 'data-selection-row': 'model:claude::sonnet' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-selection-pane': 'model' })).toHaveLength(1);
  });

  it('marks what is running now', () => {
    const { renderer } = renderSheet();
    expect(JSON.stringify(renderer.toJSON())).toContain('current');
  });
});
