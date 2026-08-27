// input:  absent, partial, successful, failing, and delayed native bridge doubles
// output: capability, safe invoke, event/back listener, and idempotent teardown guarantees
// pos:    Contract tests for the single typed window.__TAURI__ adapter
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hasNativeCapability,
  listenNativeBack,
  listenNativeEvent,
  nativeCapabilities,
  safeInvoke,
} from './native-bridge';

function installBridge(value: unknown): void {
  Reflect.set(globalThis, '__TAURI__', value);
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, '__TAURI__');
});

describe('native bridge capabilities and invocation', () => {
  it('reports an absent or partial bridge without throwing', async () => {
    expect(nativeCapabilities()).toEqual({ invoke: false, events: false, back: false });
    expect(hasNativeCapability('invoke')).toBe(false);
    expect(await safeInvoke('disconnect')).toEqual({ ok: false, reason: 'unavailable' });

    installBridge({ core: { invoke: vi.fn() } });
    expect(nativeCapabilities()).toEqual({ invoke: true, events: false, back: false });
  });

  it('returns typed values and captures synchronous or asynchronous command failures', async () => {
    const forward = { remotePort: 4173, localPort: 32100, url: 'http://127.0.0.1:32100' };
    const invoke = vi.fn(async () => forward);
    installBridge({ core: { invoke } });

    expect(await safeInvoke('forward_start', { port: 4173 })).toEqual({ ok: true, value: forward });
    expect(invoke).toHaveBeenCalledWith('forward_start', { port: 4173 });

    invoke.mockRejectedValueOnce('missing command');
    expect(await safeInvoke('disconnect')).toEqual({
      ok: false,
      reason: 'failed',
      error: 'missing command',
    });
    invoke.mockImplementationOnce(() => { throw new Error('bridge torn down'); });
    const failed = await safeInvoke('disconnect');
    expect(failed.ok).toBe(false);
  });
});

describe('native bridge event listeners', () => {
  it('passes event payloads through as unknown and unsubscribes at most once', async () => {
    const unlisten = vi.fn(() => { throw new Error('already torn down'); });
    let emit: ((event: unknown) => void) | undefined;
    installBridge({
      event: {
        listen: vi.fn(async (_name: string, handler: (event: unknown) => void) => {
          emit = handler;
          return unlisten;
        }),
      },
    });
    const received: unknown[] = [];

    const unsubscribe = await listenNativeEvent('frontend-update-staged', (payload) => {
      received.push(payload);
    });
    emit?.({ payload: { version: 'hash' } });
    emit?.({ malformed: true });
    unsubscribe();
    unsubscribe();

    expect(received).toEqual([{ version: 'hash' }, undefined]);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

});

describe('native bridge event fallback', () => {
  it('returns an idempotent no-op when event registration is absent or rejected', async () => {
    const absent = await listenNativeEvent('app-update-available', vi.fn());
    expect(() => { absent(); absent(); }).not.toThrow();

    installBridge({ event: { listen: vi.fn(async () => { throw new Error('unsupported'); }) } });
    const rejected = await listenNativeEvent('app-update-available', vi.fn());
    expect(() => { rejected(); rejected(); }).not.toThrow();
  });

});

describe('native bridge back listener', () => {
  it('unregisters a delayed back listener once after an early dispose', async () => {
    let resolveListener: ((listener: { unregister: () => Promise<void> }) => void) | undefined;
    const unregister = vi.fn(async () => {});
    installBridge({
      app: {
        onBackButtonPress: vi.fn(() => new Promise((resolve) => {
          resolveListener = resolve;
        })),
      },
    });

    const dispose = listenNativeBack(vi.fn());
    dispose();
    dispose();
    resolveListener?.({ unregister });

    await vi.waitFor(() => expect(unregister).toHaveBeenCalledTimes(1));
  });
});
