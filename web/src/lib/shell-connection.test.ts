import { describe, it, expect, vi } from 'vitest';
import { runDisconnect, CONNECT_SCREEN_PATH } from './shell-connection';

describe('runDisconnect', () => {
  it('clears credentials via invoke("disconnect") then navigates to the connect screen', async () => {
    const calls: string[] = [];
    const invoke = vi.fn(async (cmd: string) => {
      calls.push(`invoke:${cmd}`);
    });
    const navigate = vi.fn((url: string) => {
      calls.push(`navigate:${url}`);
    });

    await runDisconnect({ invoke, navigate });

    expect(invoke).toHaveBeenCalledWith('disconnect');
    expect(navigate).toHaveBeenCalledWith(CONNECT_SCREEN_PATH);
    // Order: the credential store is cleared BEFORE returning to the login screen.
    expect(calls).toEqual(['invoke:disconnect', `navigate:${CONNECT_SCREEN_PATH}`]);
  });

  it('still navigates to the connect screen when the clear fails (dead server is recoverable)', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('keychain unavailable');
    });
    const navigate = vi.fn();

    await runDisconnect({ invoke, navigate });

    expect(navigate).toHaveBeenCalledWith(CONNECT_SCREEN_PATH);
  });

  it('navigates even when no invoke is available (no native core)', async () => {
    const navigate = vi.fn();

    await runDisconnect({ invoke: undefined, navigate });

    expect(navigate).toHaveBeenCalledWith(CONNECT_SCREEN_PATH);
  });
});
