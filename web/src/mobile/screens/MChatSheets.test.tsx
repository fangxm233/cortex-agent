import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

import type { SelectionSheetRow, SelectionSheetVM } from './m-chat-vm';

// MBottomSheet's entrance animation needs rAF and window.history; this suite is about what the
// sheet DOES, so the chrome is stubbed exactly as MScheduleSheet's suite does.
vi.mock('@/mobile/ui/kit', async () => ({
  ...(await vi.importActual<typeof import('@/mobile/ui/kit')>('@/mobile/ui/kit')),
  MBottomSheet: ({ children, animateHeight, onBack }: any) => <div data-bottom-sheet data-animate-height={animateHeight} data-back={onBack}>{children}</div>,
}));

const { AgentSheet, MoreMenu, SelectionSheet } = await import('./MChatSheets');
const { AttachMenu } = await import('./MChatComposerPresentation');

afterEach(() => { vi.unstubAllGlobals(); });

const floatingMenus = [
  { name: 'More', render: (onClose: () => void) => <MoreMenu onClose={onClose} onSessionId={vi.fn()} /> },
  { name: 'Attach', render: (onClose: () => void) => <AttachMenu onClose={onClose} onCamera={vi.fn()} onLibrary={vi.fn()} onFile={vi.fn()} onCommands={vi.fn()} /> },
];

function press(target: EventTarget, key: string): void {
  act(() => { target.dispatchEvent(Object.assign(new Event('keydown'), { key })); });
}

describe.each(floatingMenus)('$name menu dismissal', ({ render }) => {
  it('closes on Escape and outside click, ignoring other keys', () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const onClose = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(render(onClose)); });
    press(target, 'Enter');
    expect(onClose).not.toHaveBeenCalled();
    press(target, 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => renderer.root.findAllByType('div')[0].props.onClick());
    expect(onClose).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
    press(target, 'Escape');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('uses the latest close callback and removes listeners between mounts', () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const oldClose = vi.fn();
    const newClose = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(render(oldClose)); });
    act(() => renderer.update(render(newClose)));
    press(target, 'Escape');
    expect(oldClose).not.toHaveBeenCalled();
    expect(newClose).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
    act(() => { renderer = create(render(newClose)); });
    press(target, 'Escape');
    expect(newClose).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
    press(target, 'Escape');
    expect(newClose).toHaveBeenCalledTimes(2);
  });
});

// `buildSelectionSheet` decides what the rows SAY (m-chat-vm.test); this is only about drawing them:
// favorites close the sheet; pane picks return to the root; stars change only favorite state.

const engine = { backend: 'claude' as const, provider: null, model: 'opus', thinking: null, mode: 'plan' };
const sonnet = {
  id: 'sonnet', backend: 'claude' as const, provider: null, group: 'claude', active: false,
  disabled: false, disabledReason: null, favorite: false, selection: { ...engine, model: 'sonnet' },
};
const vm: SelectionSheetVM = {
  sections: [
    { key: 'favorites', title: 'Favorites', rows: [
      { id: 'favorite:claude::opus', label: 'opus', sub: null, group: 'claude', current: true, change: null },
      { id: 'favorite:claude::sonnet', label: 'sonnet', sub: 'high', group: 'claude', current: false, change: { selection: sonnet.selection } },
      { id: 'favorite:pi:deepseek:ds', label: 'ds', sub: 'New conversation only · pi', group: 'pi · deepseek', current: false, change: null, disabled: true },
    ] },
    { key: 'model', title: 'MODEL', rows: [
      { id: 'model:claude::opus', label: 'opus', sub: null, group: 'claude', current: true, change: null },
      { id: 'model:claude::sonnet', label: 'sonnet', sub: null, group: 'claude', current: false, change: { selection: sonnet.selection }, modelOption: sonnet },
    ] },
    { key: 'thinking', title: 'THINKING', rows: [
      { id: 'thinking:default', label: 'Default', sub: null, current: false, change: { selection: engine } },
      { id: 'thinking:high', label: 'high', sub: null, current: false, change: { selection: { ...engine, thinking: 'high' } } },
    ] },
  ],
  rootRows: [
    { key: 'model', label: 'model', value: 'opus' },
    { key: 'thinking', label: 'thinking', value: 'high' },
  ],
};

function renderSheet(pending = true) {
  const onToggleFavorite = vi.fn();
  const onPick = vi.fn();
  const onClose = vi.fn();
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <SelectionSheet vm={vm} pending={pending} onClose={onClose} onPick={onPick} onToggleFavorite={onToggleFavorite} />,
    );
  });
  const open = (pane: string): void => {
    act(() => renderer.root.findByProps({ 'data-selection-pane': pane }).props.onClick());
  };
  return { renderer, onPick, onClose, open, onToggleFavorite };
}

describe('SelectionSheet', () => {
  it.each(['model', 'thinking'])('animates only navigation entering and leaving %s', (pane) => {
    const { renderer, open } = renderSheet();
    const shell = renderer.root.findByProps({ 'data-bottom-sheet': true });
    const content = () => renderer.root.findByProps({ className: 'selection-pane' });
    const root = content();
    expect(root.props['data-pane']).toBe('root');
    expect(root.props['data-motion']).toBeUndefined();
    expect(shell.props['data-animate-height']).toBe(true);
    expect(root.parent?.props.className).toBe('selection-pane-clip');
    open(pane);
    const child = content();
    expect(child.props['data-pane']).toBe(pane);
    expect(child.props['data-motion']).toBe('forward');
    expect(child).not.toBe(root);
    act(() => renderer.root.findByProps({ 'data-selection-back': 'true' }).props.onClick());
    expect(content().props['data-pane']).toBe('root');
    expect(content().props['data-motion']).toBe('back');
    expect(content()).not.toBe(root);
    open(pane);
    expect(content()).not.toBe(child);
    expect(renderer.root.findByProps({ 'data-bottom-sheet': true })).toBe(shell);
    act(() => shell.props['data-back']());
    expect(content().props['data-motion']).toBe('back');
    expect(shell.props['data-back']).toBeUndefined();
    act(() => renderer.unmount());
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

  it('a favorite pick closes the sheet', () => {
    const { renderer, onPick, onClose } = renderSheet();
    act(() => renderer.root.findByProps({ 'data-selection-row': 'favorite:claude::sonnet' }).props.onClick());
    expect(onPick).toHaveBeenCalledWith(vm.sections[0].rows[1]);
    expect(onClose).toHaveBeenCalled();
  });

  it('shows backend/provider groups and prevents cross-backend picks', () => {
    const { renderer, onPick, onClose } = renderSheet();
    expect(renderer.root.findByProps({ 'data-selection-group': 'pi · deepseek' })).toBeDefined();
    const row = renderer.root.findByProps({ 'data-selection-row': 'favorite:pi:deepseek:ds' });
    expect(row.props['data-disabled']).toBe('true');
    act(() => row.props.onClick());
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('stars change favorites without picking or navigating away', () => {
    const { renderer, open, onPick, onClose, onToggleFavorite } = renderSheet();
    open('model');
    const stopPropagation = vi.fn();
    const star = renderer.root.findByProps({ 'data-model-star': 'sonnet' });
    expect(star.props['aria-pressed']).toBe(false);
    act(() => star.props.onClick({ stopPropagation }));
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(onToggleFavorite).toHaveBeenCalledWith(sonnet);
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ className: 'selection-pane' }).props['data-pane']).toBe('model');
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
      <AgentSheet rows={agentRows} onClose={onClose} onPick={onPick} />,
    );
  });
  const tap = (id: string): void => {
    act(() => renderer.root.findByProps({ 'data-selection-row': id }).props.onClick());
  };
  return { renderer, onPick, onClose, tap };
}

describe('AgentSheet', () => {
  it('sends the agent that was tapped and closes behind it', () => {
    const { renderer, onPick, onClose, tap } = renderAgentSheet();
    expect(renderer.root.findByProps({ 'data-bottom-sheet': true }).props['data-animate-height']).toBeUndefined();
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

it('opens mobile Models settings after closing the selection sheet', () => {
  const { renderer, onClose, onPick } = renderSheet();
  act(() => renderer.root.findByProps({ 'data-selection-settings': true }).props.onClick());
  expect(onClose).toHaveBeenCalledOnce();
  expect(navigate).toHaveBeenCalledWith('/m/settings/models');
  expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(navigate.mock.invocationCallOrder.at(-1)!);
  expect(onPick).not.toHaveBeenCalled();
  act(() => renderer.unmount());
});

it('omits the session subtitle and next-turn footer from the selection sheet', () => {
  const { renderer } = renderSheet();
  const text = JSON.stringify(renderer.toJSON());
  expect(text).not.toContain('This session');
  expect(text).not.toContain('Applies from the next turn');
  act(() => renderer.unmount());
});
