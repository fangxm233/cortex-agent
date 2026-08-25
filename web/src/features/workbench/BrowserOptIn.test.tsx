// input:  the draft browser opt-in chip
// output: pinned opt-in semantics for session-creation browser access
// pos:    Specification for choosing browser control before a session exists
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { LangProvider } from '@/i18n';
import { BrowserOptInChip, DEFAULT_BROWSER_DEVICE } from './BrowserOptIn';
import { ComposerActionRow } from './ComposerActionRow';

beforeEach(() => {
  // The menu reads the connected devices when it opens; no device is the ordinary case.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, data: { devices: [] } }) })));
});

function renderChip(device: string | null, onChange = vi.fn()) {
  const renderer = create(
    <LangProvider>
      <BrowserOptInChip device={device} onChange={onChange} />
    </LangProvider>,
  );
  return { renderer, chip: renderer.root.findByProps({ 'data-chip': 'browser' }), onChange };
}

describe('BrowserOptInChip', () => {
  it('is off by default, so no session pays for browser tools unless asked', () => {
    const { chip } = renderChip(null);
    expect(chip.props['data-active']).toBe('false');
  });

  it('offers a device menu rather than a bare toggle', () => {
    // Where the browser runs matters as much as whether it runs: the server draws on the server's
    // display, a device opens a window on the screen in front of you.
    const { renderer, chip } = renderChip(null);
    act(() => chip.props.onClick({ stopPropagation: () => {} }));
    const rows = renderer.root.findAllByProps({ 'data-menu': 'browser' });
    expect(rows).toHaveLength(1);
  });

  it('picking this host names it as the device', () => {
    const { renderer, chip, onChange } = renderChip(null);
    act(() => chip.props.onClick({ stopPropagation: () => {} }));
    const row = renderer.root.findByProps({ 'data-device': DEFAULT_BROWSER_DEVICE });
    act(() => row.props.onClick({ stopPropagation: () => {} }));
    expect(onChange).toHaveBeenCalledWith(DEFAULT_BROWSER_DEVICE);
  });

  it('turning it off clears the device rather than keeping a stale one', () => {
    const { renderer, chip, onChange } = renderChip(DEFAULT_BROWSER_DEVICE);
    act(() => chip.props.onClick({ stopPropagation: () => {} }));
    const row = renderer.root.findByProps({ 'data-device': '__off__' });
    act(() => row.props.onClick({ stopPropagation: () => {} }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('shows which device is selected once on', () => {
    const { chip } = renderChip('server');
    // The chip's own label, not the menu — the menu is only built once it is opened.
    expect(chip.props.children.find((c: unknown) => typeof c === 'string')).toContain('server');
  });
});

describe('ComposerActionRow browser slot', () => {
  it('omits the chip entirely for an existing session', () => {
    // The tool set is fixed at spawn, so offering the toggle mid-session would be a lie.
    const renderer = create(
      <LangProvider>
        <ComposerActionRow profileControl={<span />} hint="" onAttach={vi.fn()} onCommands={vi.fn()} />
      </LangProvider>,
    );
    expect(renderer.root.findAllByProps({ 'data-chip': 'browser' })).toHaveLength(0);
  });
});

describe('BrowserOptInChip on an existing session', () => {
  it('reports the device without offering a control', () => {
    const onChange = vi.fn();
    const renderer = create(
      <LangProvider>
        <BrowserOptInChip device="server" />
      </LangProvider>,
    );
    const chip = renderer.root.findByProps({ 'data-chip': 'browser' });
    expect(chip.props['data-editable']).toBe('false');
    // No click handler at all — a running agent's tool set cannot change, so a control that looked
    // clickable would be a lie.
    expect(chip.props.onClick).toBeUndefined();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('explains why it cannot be changed', () => {
    const { chip } = renderChip('server');
    expect(typeof chip.props.title).toBe('string');
  });
});
