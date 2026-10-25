import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutostartController, type AutostartController } from './useAutostartController';

const native = vi.hoisted(() => ({ desktop: true, safeInvoke: vi.fn() }));
vi.mock('@/lib/desktop-config', () => ({ isDesktopShell: () => native.desktop }));
vi.mock('@/lib/native-bridge', () => ({ safeInvoke: native.safeInvoke }));

async function mount(): Promise<() => AutostartController> {
  let current!: AutostartController;
  function Probe() { current = useAutostartController(); return null; }
  await act(async () => { create(<Probe />); });
  return () => current;
}

describe('useAutostartController', () => {
  beforeEach(() => {
    native.desktop = true;
    native.safeInvoke.mockReset();
  });

  it('shows what the shell reports and writes through it', async () => {
    native.safeInvoke.mockResolvedValueOnce({ ok: true, value: 'off' });
    const controller = await mount();
    expect(controller().state).toBe('off');
    native.safeInvoke.mockResolvedValueOnce({ ok: true, value: 'on' });
    await act(async () => { controller().set(true); });
    expect(native.safeInvoke).toHaveBeenLastCalledWith('autostart_set', { enabled: true });
    expect(controller().state).toBe('on');
    expect(controller().failed).toBe(false);
  });

  it('keeps the registered state and flags a failed write', async () => {
    native.safeInvoke.mockResolvedValueOnce({ ok: true, value: 'on' });
    const controller = await mount();
    native.safeInvoke.mockResolvedValueOnce({ ok: false, reason: 'failed', error: 'AUTOSTART_FAILED' });
    await act(async () => { controller().set(false); });
    expect(controller().state).toBe('on');
    expect(controller().failed).toBe(true);
  });

  it('offers nothing on a remote connection or an older shell', async () => {
    native.safeInvoke.mockResolvedValueOnce({ ok: false, reason: 'failed', error: 'AUTOSTART_UNAVAILABLE' });
    expect((await mount())().state).toBeNull();
  });

  it('never asks outside the desktop app', async () => {
    native.desktop = false;
    expect((await mount())().state).toBeNull();
    expect(native.safeInvoke).not.toHaveBeenCalled();
  });
});
