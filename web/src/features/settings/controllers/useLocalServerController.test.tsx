import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocalServerController, type LocalServerController } from './useLocalServerController';

const native = vi.hoisted(() => ({ desktop: true, safeInvoke: vi.fn() }));
vi.mock('@/lib/desktop-config', () => ({ isDesktopShell: () => native.desktop }));
vi.mock('@/lib/native-bridge', () => ({ safeInvoke: native.safeInvoke }));

async function mount(): Promise<() => LocalServerController> {
  let current!: LocalServerController;
  function Probe() { current = useLocalServerController(); return null; }
  await act(async () => { create(<Probe />); });
  return () => current;
}

describe('useLocalServerController', () => {
  beforeEach(() => {
    native.desktop = true;
    native.safeInvoke.mockReset();
  });

  it('offers the stop for a local install and stops only after confirming', async () => {
    native.safeInvoke.mockResolvedValueOnce({ ok: true, value: null });
    const controller = await mount();
    expect(controller().offered).toBe(true);
    act(() => { controller().arm(); });
    expect(controller().armed).toBe(true);
    expect(native.safeInvoke).toHaveBeenCalledTimes(1);
    native.safeInvoke.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => { controller().stop(); });
    expect(native.safeInvoke).toHaveBeenLastCalledWith('local_server_stop');
    expect(controller().pending).toBe(true);
  });

  it('flags a failed stop and drops the confirmation', async () => {
    native.safeInvoke.mockResolvedValueOnce({ ok: true, value: null });
    const controller = await mount();
    act(() => { controller().arm(); });
    native.safeInvoke.mockResolvedValueOnce({ ok: false, reason: 'failed', error: 'SERVER_STOP_FAILED' });
    await act(async () => { controller().stop(); });
    expect(controller()).toMatchObject({ failed: true, pending: false, armed: false });
  });

  it('offers nothing on a remote connection or an older shell', async () => {
    native.safeInvoke.mockResolvedValueOnce({ ok: false, reason: 'failed', error: 'SERVER_CONTROL_UNAVAILABLE' });
    expect((await mount())().offered).toBe(false);
  });

  it('never asks outside the desktop app', async () => {
    native.desktop = false;
    expect((await mount())().offered).toBe(false);
    expect(native.safeInvoke).not.toHaveBeenCalled();
  });
});
