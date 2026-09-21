import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { MChatCopy } from './MChatView.types';
import type { SelectionSheetRow, SelectionSheetVM } from './m-chat-vm';

// MBottomSheet's entrance animation needs rAF and window.history; this suite is about what the
// sheet DOES, so the chrome is stubbed exactly as MScheduleSheet's suite does.
vi.mock('@/mobile/ui/kit', async () => ({
  ...(await vi.importActual<typeof import('@/mobile/ui/kit')>('@/mobile/ui/kit')),
  MBottomSheet: ({ children }: any) => <div data-bottom-sheet>{children}</div>,
}));

const { AgentSheet, SelectionSheet } = await import('./MChatSheets');

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

  it('steps back out of a pane without closing the sheet', () => {
    const { renderer, onClose, open } = renderSheet();
    open('model');
    act(() => renderer.root.findByProps({ 'data-selection-back': 'true' }).props.onClick());
    expect(onClose).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ 'data-selection-row': 'model:claude::sonnet' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-selection-pane': 'model' })).toHaveLength(1);
  });
});

// The environment sheet is flat — there is nothing under an agent to refine — so a tap is the whole
// visit and the sheet goes with it. Its rows come from `buildAgentSheet` (m-chat-vm.test); this is
// only about what a tap does to the sheet.

const agentRows: SelectionSheetRow[] = [
  { id: 'agent:default', label: 'default', sub: 'follow the host default', current: true, change: null },
  { id: 'agent:nimbus', label: 'nimbus', sub: 'a clean room', current: false, change: { agentName: 'nimbus' } },
  { id: 'agent:atlas', label: 'atlas', sub: 'new conversation only · pi', current: false, change: null, disabled: true },
];

function renderAgentSheet() {
  const onPick = vi.fn();
  const onClose = vi.fn();
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <AgentSheet rows={agentRows} title="agent" copy={selectionCopy} onClose={onClose} onPick={onPick} />,
    );
  });
  const tap = (id: string): void => {
    act(() => renderer.root.findByProps({ 'data-selection-row': id }).props.onClick());
  };
  return { renderer, onPick, onClose, tap };
}

describe('AgentSheet', () => {
  it('sends the agent that was tapped and closes behind it', () => {
    const { onPick, onClose, tap } = renderAgentSheet();
    tap('agent:nimbus');
    expect(onPick).toHaveBeenCalledWith(agentRows[1]);
    expect(onClose).toHaveBeenCalled();
  });

  it('hands the conversation back to the host default from the top row', () => {
    const { onPick, tap } = renderAgentSheet();
    tap('agent:default');
    expect(onPick).toHaveBeenCalledWith(agentRows[0]);
  });

  it('draws the agent this conversation cannot take, but refuses the tap', () => {
    const { renderer, onPick, onClose, tap } = renderAgentSheet();
    expect(renderer.root.findByProps({ 'data-selection-row': 'agent:atlas' }).props['data-disabled'])
      .toBe('true');
    tap('agent:atlas');
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
