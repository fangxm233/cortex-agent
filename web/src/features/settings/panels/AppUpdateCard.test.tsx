// input:  a mocked native bridge and shell predicate
// output: off-shell hiding, pref reads/writes and the fallen-back-to-asking state
// pos:    Settings → Advanced silent-update switch regressions
// >>> Once updated, update this header and parent CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ native: true, invoke: vi.fn() }));
vi.mock('@/lib/desktop-config', () => ({ isNativeShell: () => h.native }));
vi.mock('@/lib/native-bridge', () => ({ safeInvoke: h.invoke }));

import { AppUpdateCard } from './AppUpdateCard';

const PREFS = { silent: true, failedAttempts: 0 };

/** get_update_prefs answers `prefs`; set_update_silent answers the stored result of the edit. */
function shellWith(prefs: Record<string, unknown>) {
  let stored = prefs;
  h.invoke.mockImplementation(async (command: string, args?: { silent: boolean }) => {
    if (command === 'set_update_silent') {
      stored = { ...stored, silent: args!.silent, ...(args!.silent ? { failedAttempts: 0 } : {}) };
    }
    return { ok: true, value: stored };
  });
}

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<AppUpdateCard />); });
  return renderer;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.native = true;
  shellWith(PREFS);
});

describe('silent app update switch', () => {
  it('renders nothing off-shell and never asks the bridge', async () => {
    h.native = false;

    const renderer = await render();

    expect(renderer.toJSON()).toBeNull();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('stays hidden on a shell without the update-prefs commands', async () => {
    h.invoke.mockResolvedValue({ ok: false, reason: 'unavailable' });

    const renderer = await render();

    expect(renderer.toJSON()).toBeNull();
  });

  it('writes the new value through set_update_silent and follows what was persisted', async () => {
    const renderer = await render();
    expect(renderer.root.findByProps({ role: 'switch' }).props['aria-checked']).toBe(true);

    await act(async () => renderer.root.findByProps({ role: 'switch' }).props.onClick());

    expect(h.invoke).toHaveBeenLastCalledWith('set_update_silent', { silent: false });
    expect(renderer.root.findByProps({ role: 'switch' }).props['aria-checked']).toBe(false);
  });

  it('keeps the switch where it was when the shell refuses the write', async () => {
    const renderer = await render();
    h.invoke.mockResolvedValue({ ok: false, reason: 'failed', error: 'disk full' });

    await act(async () => renderer.root.findByProps({ role: 'switch' }).props.onClick());

    expect(renderer.root.findByProps({ role: 'switch' }).props['aria-checked']).toBe(true);
    expect(renderer.root.findByProps({ role: 'alert' }).children.length).toBeGreaterThan(0);
  });

  it('says the shell is already asking after three failed silent installs, and can retry', async () => {
    shellWith({ silent: true, failedAttempts: 3 });

    const renderer = await render();
    // The switch still reports the stored preference; the copy must not claim it is working.
    expect(renderer.root.findByProps({ role: 'switch' }).props['aria-checked']).toBe(true);

    await act(async () => renderer.root.findByProps({ 'data-app-update-retry': '' }).props.onClick());

    expect(h.invoke).toHaveBeenLastCalledWith('set_update_silent', { silent: true });
    expect(renderer.root.findAllByProps({ 'data-app-update-retry': '' })).toHaveLength(0);
  });
});
