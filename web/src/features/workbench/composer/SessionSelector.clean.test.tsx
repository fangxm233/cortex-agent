import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import * as RadixPopover from '@radix-ui/react-popover';
import { LangProvider } from '@/i18n';

const harness = vi.hoisted(() => ({ copyText: vi.fn(), revealPath: vi.fn() }));
vi.mock('@/lib/clipboard', () => ({ copyText: harness.copyText }));
vi.mock('@/lib/files', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/files')>(),
  revealPath: harness.revealPath,
}));

import { CleanToggleView, CleanWorkspaceChip, CleanWorkspacePanel } from './SessionSelector';

const WORKSPACE = '/srv/cortex/workspaces/ab12cd34';
const shell = globalThis as unknown as { __CORTEX_DESKTOP__?: boolean; __CORTEX_DESKTOP_CONFIG?: object };
let renderer: ReactTestRenderer;

function mount(node: JSX.Element): ReactTestRenderer {
  act(() => { renderer = create(<LangProvider>{node}</LangProvider>); });
  return renderer;
}
const chip = () => renderer.root.findByProps({ 'data-chip': 'clean' });
const action = (name: string) => renderer.root.findAllByProps({ 'data-action': name }).filter((node) => node.type === 'button');

afterEach(() => {
  act(() => renderer?.unmount());
  delete shell.__CORTEX_DESKTOP__;
  delete shell.__CORTEX_DESKTOP_CONFIG;
  harness.copyText.mockReset();
  harness.revealPath.mockReset();
});

describe('CleanToggleView', () => {
  it('uses a quiet fill while off, an inverted fill when on, and toggles', () => {
    const onToggle = vi.fn();
    mount(<CleanToggleView on={false} onToggle={onToggle} />);
    expect(chip().props['aria-pressed']).toBe(false);
    expect(chip().props.style.color).toBe('var(--proto-muted)');
    expect(chip().props.style.background).toBe('var(--proto-line-2)');
    const { height, padding } = chip().props.style;
    expect(chip().props.title).toBe('Works in its own folder without project context');
    act(() => chip().props.onClick({ stopPropagation: vi.fn() }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    act(() => renderer.update(<LangProvider><CleanToggleView on onToggle={onToggle} /></LangProvider>));
    expect(chip().props['aria-pressed']).toBe(true);
    expect(chip().props.style).toMatchObject({
      background: 'var(--ink-solid-bg)', color: 'var(--ink-solid-fg)', height, padding,
    });
    act(() => chip().props.onMouseEnter());
    expect(chip().props.style.background).toBe('var(--ink-solid-hover)');
    act(() => chip().props.onMouseLeave());
    expect(chip().props.style.background).toBe('var(--ink-solid-bg)');
  });

  it('is dimmed and inert while the session is created', () => {
    const onToggle = vi.fn();
    mount(<CleanToggleView on onToggle={onToggle} disabled />);
    expect(chip().props.disabled).toBe(true);
    expect(chip().props.style.opacity).toBe(0.55);
    act(() => chip().props.onMouseEnter());
    expect(chip().props.style.background).toBe('var(--ink-solid-bg)');
    act(() => chip().props.onClick({ stopPropagation: vi.fn() }));
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe('CleanWorkspaceChip', () => {
  it('opens the workspace popover from a read-only chip', () => {
    mount(<CleanWorkspaceChip workspaceDir={WORKSPACE} />);
    expect(chip().props['aria-pressed']).toBeUndefined();
    expect(chip().props.disabled).toBe(false);
    expect(chip().props.style).toMatchObject({ background: 'var(--ink-solid-bg)', color: 'var(--ink-solid-fg)' });
    expect(renderer.root.findByType(RadixPopover.Root).props.open).toBe(false);
  });

  it('stays an inert chip until the session row brings its path', () => {
    mount(<CleanWorkspaceChip workspaceDir={null} />);
    expect(chip().props.disabled).toBe(true);
    expect(renderer.root.findAllByType(RadixPopover.Root)).toHaveLength(0);
  });
});

describe('CleanWorkspacePanel', () => {
  it('shows the path in mono and copies it', async () => {
    harness.copyText.mockResolvedValue(true);
    mount(<CleanWorkspacePanel workspaceDir={WORKSPACE} />);
    const path = renderer.root.find((node) => node.type === 'span' && node.props.children === WORKSPACE);
    expect(path.props.style.font).toContain('Mono');
    expect(action('copy')[0].props.children).toBe('Copy');
    await act(async () => { action('copy')[0].props.onClick(); });
    expect(harness.copyText).toHaveBeenCalledWith(WORKSPACE);
    expect(action('copy')[0].props.children).toBe('Copied');
  });

  it('offers Open folder only in the desktop app on the server machine', () => {
    mount(<CleanWorkspacePanel workspaceDir={WORKSPACE} />);
    expect(action('reveal')).toHaveLength(0);
    act(() => renderer.unmount());

    shell.__CORTEX_DESKTOP__ = true;
    shell.__CORTEX_DESKTOP_CONFIG = { serverUrl: 'https://cortex.example.com', token: 't' };
    mount(<CleanWorkspacePanel workspaceDir={WORKSPACE} />);
    expect(action('reveal')).toHaveLength(0);
    act(() => renderer.unmount());

    shell.__CORTEX_DESKTOP_CONFIG = { serverUrl: 'http://127.0.0.1:3006', token: 't' };
    mount(<CleanWorkspacePanel workspaceDir={WORKSPACE} />);
    act(() => action('reveal')[0].props.onClick());
    expect(harness.revealPath).toHaveBeenCalledWith(WORKSPACE);
  });
});
