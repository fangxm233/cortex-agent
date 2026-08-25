// input:  the draft browser opt-in chip
// output: pinned opt-in semantics for session-creation browser access
// pos:    Specification for choosing browser control before a session exists
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { LangProvider } from '@/i18n';
import { BrowserOptInChip, DEFAULT_BROWSER_DEVICE } from './BrowserOptIn';
import { ComposerActionRow } from './ComposerActionRow';

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

  it('turning it on names the device the browser will run on', () => {
    const { chip, onChange } = renderChip(null);
    act(() => chip.props.onClick());
    expect(onChange).toHaveBeenCalledWith(DEFAULT_BROWSER_DEVICE);
  });

  it('turning it off clears the device rather than keeping a stale one', () => {
    const { chip, onChange } = renderChip(DEFAULT_BROWSER_DEVICE);
    act(() => chip.props.onClick());
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('shows which device is selected once on', () => {
    const { chip } = renderChip('server');
    expect(JSON.stringify(chip.props.children)).toContain('server');
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
