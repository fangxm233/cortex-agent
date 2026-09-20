// input:  mocked plugin listeners, native commands, foreground events and timers
// output: retained action, bounded retry, scope, dedup and teardown regression tests
// pos:    Notification protocol tests for the canonical bridge
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listenNativeNotificationActions, mobileNotificationStatus } from './native-bridge';

const h = vi.hoisted(() => ({ listener: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ addPluginListener: h.listener }));
const action = { actionId: 'a1', scope: 'server-a', kind: 'session', sessionId: 's1' };
let emit: (value: unknown) => void;
const unregister = vi.fn();
const invoke = vi.fn();
beforeEach(() => {
  unregister.mockReset();
  h.listener.mockReset().mockImplementation(async (_plugin, _event, callback) => {
    emit = callback;
    return { unregister };
  });
  invoke.mockReset().mockImplementation(async (command) => {
    if (command === 'mobile_notifications_status') return { enabled: true, running: true, permissionGranted: true, scope: 'server-a' };
    if (command.endsWith('pending_actions')) return { actions: [action] };
    return {};
  });
  Reflect.set(globalThis, '__TAURI__', { core: { invoke } });
});
afterEach(() => Reflect.deleteProperty(globalThis, '__TAURI__'));

describe('retained Android actions', () => {
  it('distinguishes missing old-APK commands from native status errors', async () => {
    invoke.mockRejectedValueOnce('Command mobile_notifications_status not found');
    expect(await mobileNotificationStatus()).toBeNull();
    invoke.mockRejectedValueOnce('connection failed');
    await expect(mobileNotificationStatus()).rejects.toThrow('Unable to read');
    invoke.mockResolvedValueOnce({ enabled: 'yes' });
    await expect(mobileNotificationStatus()).rejects.toThrow('Invalid native');
  });

  it('reads completion ownership as an optional capability of newer shells', async () => {
    const shell = { enabled: true, running: true, permissionGranted: true, scope: 'server-a' };
    invoke.mockResolvedValueOnce(shell);
    expect((await mobileNotificationStatus())?.completionNotifications).toBeUndefined();
    invoke.mockResolvedValueOnce({ ...shell, completionNotifications: true });
    expect((await mobileNotificationStatus())?.completionNotifications).toBe(true);
    invoke.mockResolvedValueOnce({ ...shell, completionNotifications: 'yes' });
    await expect(mobileNotificationStatus()).rejects.toThrow('Invalid native');
  });

  it('serializes different taps so slower earlier routing cannot overwrite the latest target', async () => {
    let resolve!: () => void;
    const handled = vi.fn().mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    const off = await listenNativeNotificationActions(handled);
    await vi.waitFor(() => expect(handled).toHaveBeenCalledOnce());
    emit({ ...action, actionId: 'second', sessionId: 's2' });
    await new Promise((done) => setTimeout(done, 0));
    expect(handled).toHaveBeenCalledOnce();
    resolve();
    await vi.waitFor(() => expect(handled).toHaveBeenCalledTimes(2));
    expect(handled.mock.calls.map(([value]) => value.sessionId)).toEqual(['s1', 's2']);
    off();
  });

  it('registers before reading, deduplicates warm/cold and acks only after handling', async () => {
    let resolve!: () => void;
    const handled = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const off = await listenNativeNotificationActions(handled);
    await vi.waitFor(() => expect(handled).toHaveBeenCalledOnce());
    expect(h.listener).toHaveBeenCalledWith('cortex-notifications', 'actionPerformed', expect.any(Function));
    expect(h.listener.mock.invocationCallOrder[0]).toBeLessThan(invoke.mock.invocationCallOrder[0]);
    emit(action);
    expect(invoke).not.toHaveBeenCalledWith('plugin:cortex-notifications|ack_action', expect.anything());
    resolve();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('plugin:cortex-notifications|ack_action', { actionId: 'a1' }));
    emit(action);
    await new Promise((done) => setTimeout(done, 0));
    expect(handled).toHaveBeenCalledOnce();
    off(); off();
    expect(unregister).toHaveBeenCalledOnce();
  });

  it('retains failed callbacks and ignores actions from another server', async () => {
    const handled = vi.fn().mockRejectedValueOnce(new Error('navigation failed')).mockResolvedValue(undefined);
    const off = await listenNativeNotificationActions(handled);
    await vi.waitFor(() => expect(handled).toHaveBeenCalledOnce());
    expect(invoke).not.toHaveBeenCalledWith('plugin:cortex-notifications|ack_action', expect.anything());
    emit({ ...action, actionId: 'wrong', scope: 'server-b' });
    emit(action);
    await vi.waitFor(() => expect(handled).toHaveBeenCalledTimes(2));
    expect(handled).not.toHaveBeenCalledWith(expect.objectContaining({ scope: 'server-b' }));
    off();
  });

  it('acks successful navigation even when navigation unmounts the listener', async () => {
    const controller = new AbortController();
    const handled = vi.fn(() => { controller.abort(); });
    await listenNativeNotificationActions(handled, controller.signal);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('plugin:cortex-notifications|ack_action', { actionId: 'a1' }));
    expect(unregister).toHaveBeenCalledOnce();
  });

  it('never handles a delayed pending queue after disposal', async () => {
    let resolve!: (value: unknown) => void;
    invoke.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const controller = new AbortController();
    const handled = vi.fn();
    const pending = listenNativeNotificationActions(handled, controller.signal);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    controller.abort();
    resolve({ actions: [action] });
    await pending;
    expect(handled).not.toHaveBeenCalled();
    expect(unregister).toHaveBeenCalledOnce();
  });

  it('retains explicitly unhandled actions without acknowledging them', async () => {
    const handled = vi.fn(() => false);
    const off = await listenNativeNotificationActions(handled);
    await vi.waitFor(() => expect(handled).toHaveBeenCalledOnce());
    expect(invoke).not.toHaveBeenCalledWith('plugin:cortex-notifications|ack_action', expect.anything());
    off();
  });

  describe('foreground retries without listener recreation', () => {
    let off: (() => void) | undefined;
    let documentTarget: EventTarget & { visibilityState: string };
    const calls = (command: string) => invoke.mock.calls.filter(([name]) => name.endsWith(command));
    const flush = () => vi.advanceTimersByTimeAsync(0);

    beforeEach(() => {
      vi.useFakeTimers();
      documentTarget = Object.assign(new EventTarget(), { visibilityState: 'visible' });
      vi.stubGlobal('document', documentTarget);
      vi.stubGlobal('window', new EventTarget());
    });
    afterEach(() => {
      off?.();
      off = undefined;
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it.each(['reject', 'false'])('retries a %s routing failure and then stops', async (failure) => {
      const handled = vi.fn().mockResolvedValue(undefined);
      if (failure === 'reject') handled.mockRejectedValueOnce(new Error('route unavailable'));
      else handled.mockResolvedValueOnce(false);
      off = await listenNativeNotificationActions(handled);
      await flush();
      expect(handled).toHaveBeenCalledOnce();
      expect(calls('ack_action')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(handled).toHaveBeenCalledTimes(2);
      expect(calls('ack_action')).toHaveLength(1);
      expect(h.listener).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      const count = invoke.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(invoke).toHaveBeenCalledTimes(count);
    });

    it.each(['mobile_notifications_status', 'plugin:cortex-notifications|pending_actions'])(
      'recovers from a failed %s fetch', async (failedCommand) => {
        const original = invoke.getMockImplementation()!;
        let failed = false;
        invoke.mockImplementation(async (command, args) => {
          if (command === failedCommand && !failed) {
            failed = true;
            throw new Error('temporarily offline');
          }
          return original(command, args);
        });
        const handled = vi.fn();
        off = await listenNativeNotificationActions(handled);
        await flush();
        expect(handled).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(handled).toHaveBeenCalledOnce();
        expect(calls('ack_action')).toHaveLength(1);
        expect(h.listener).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it('retries acknowledgement without navigating again', async () => {
      const original = invoke.getMockImplementation()!;
      let failed = false;
      invoke.mockImplementation(async (command, args) => {
        if (command.endsWith('ack_action') && !failed) {
          failed = true;
          throw new Error('ack failed');
        }
        return original(command, args);
      });
      const handled = vi.fn();
      off = await listenNativeNotificationActions(handled);
      await flush();
      expect(calls('ack_action')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls('ack_action')).toHaveLength(2);
      expect(handled).toHaveBeenCalledOnce();
      expect(h.listener).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not poll an empty queue and drains newly retained taps on focus and resume', async () => {
      const original = invoke.getMockImplementation()!;
      let queued: unknown[] = [];
      invoke.mockImplementation(async (command, args) => command.endsWith('pending_actions')
        ? { actions: queued } : original(command, args));
      const handled = vi.fn();
      off = await listenNativeNotificationActions(handled);
      await flush();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls('pending_actions')).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      queued = [action];
      window.dispatchEvent(new Event('focus'));
      await flush();
      expect(handled).toHaveBeenCalledOnce();
      documentTarget.visibilityState = 'hidden';
      documentTarget.dispatchEvent(new Event('visibilitychange'));
      queued = [{ ...action, actionId: 'a2' }];
      window.dispatchEvent(new Event('focus'));
      await flush();
      expect(calls('pending_actions')).toHaveLength(2);
      documentTarget.visibilityState = 'visible';
      documentTarget.dispatchEvent(new Event('visibilitychange'));
      await flush();
      expect(handled).toHaveBeenCalledTimes(2);
      expect(calls('pending_actions')).toHaveLength(3);
      expect(h.listener).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('bounds persistent failures, then permits recovery on focus', async () => {
      const handled = vi.fn().mockReturnValue(false);
      off = await listenNativeNotificationActions(handled);
      await flush();
      for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
        const count = handled.mock.calls.length;
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(handled).toHaveBeenCalledTimes(count);
        await vi.advanceTimersByTimeAsync(1);
        expect(handled).toHaveBeenCalledTimes(count + 1);
      }
      expect(handled).toHaveBeenCalledTimes(6);
      expect(vi.getTimerCount()).toBe(0);
      handled.mockReturnValue(undefined);
      window.dispatchEvent(new Event('focus'));
      await flush();
      expect(handled).toHaveBeenCalledTimes(7);
      expect(calls('ack_action')).toHaveLength(1);
      expect(h.listener).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('pauses pending retries while hidden and resumes immediately', async () => {
      const handled = vi.fn().mockReturnValue(false);
      off = await listenNativeNotificationActions(handled);
      await flush();
      expect(vi.getTimerCount()).toBe(1);
      documentTarget.visibilityState = 'hidden';
      documentTarget.dispatchEvent(new Event('visibilitychange'));
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(handled).toHaveBeenCalledOnce();
      handled.mockReturnValue(undefined);
      documentTarget.visibilityState = 'visible';
      documentTarget.dispatchEvent(new Event('visibilitychange'));
      await flush();
      expect(handled).toHaveBeenCalledTimes(2);
      expect(calls('ack_action')).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['off', 'abort'])('removes retry timers and foreground listeners on %s', async (dispose) => {
      const removeWindow = vi.spyOn(window, 'removeEventListener');
      const removeDocument = vi.spyOn(document, 'removeEventListener');
      const controller = new AbortController();
      const handled = vi.fn().mockReturnValue(false);
      off = await listenNativeNotificationActions(handled, controller.signal);
      await flush();
      expect(vi.getTimerCount()).toBe(1);
      if (dispose === 'abort') controller.abort();
      else off();
      expect(vi.getTimerCount()).toBe(0);
      expect(removeWindow).toHaveBeenCalledWith('focus', expect.any(Function));
      expect(removeDocument).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
      const count = invoke.mock.calls.length;
      emit(action);
      window.dispatchEvent(new Event('focus'));
      documentTarget.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(handled).toHaveBeenCalledOnce();
      expect(invoke).toHaveBeenCalledTimes(count);
      expect(unregister).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not recreate a timer when in-flight retry routing rejects after teardown', async () => {
      let reject!: (error: Error) => void;
      const handled = vi.fn().mockReturnValueOnce(false).mockImplementationOnce(
        () => new Promise((_resolve, fail) => { reject = fail; }),
      );
      off = await listenNativeNotificationActions(handled);
      await flush();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(handled).toHaveBeenCalledTimes(2);
      off();
      reject(new Error('route unavailable'));
      await flush();
      expect(vi.getTimerCount()).toBe(0);
      expect(calls('ack_action')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(handled).toHaveBeenCalledTimes(2);
    });

    it('does not navigate when an in-flight retry status resolves after teardown', async () => {
      const original = invoke.getMockImplementation()!;
      let resolve!: (value: unknown) => void;
      let attempts = 0;
      invoke.mockImplementation(async (command, args) => {
        if (command === 'mobile_notifications_status') {
          if (++attempts === 1) throw new Error('offline');
          return new Promise((done) => { resolve = done; });
        }
        return original(command, args);
      });
      const handled = vi.fn();
      off = await listenNativeNotificationActions(handled);
      await flush();
      await vi.advanceTimersByTimeAsync(1_000);
      off();
      resolve(await original('mobile_notifications_status'));
      await flush();
      expect(handled).not.toHaveBeenCalled();
      expect(calls('ack_action')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('cleans delayed registration without reading or navigating after abort', async () => {
    let resolve!: (value: { unregister: typeof unregister }) => void;
    h.listener.mockImplementation((_plugin, _event, callback) => {
      emit = callback;
      return new Promise((done) => { resolve = done; });
    });
    const controller = new AbortController();
    const handled = vi.fn();
    const pending = listenNativeNotificationActions(handled, controller.signal);
    await vi.waitFor(() => expect(h.listener).toHaveBeenCalledOnce());
    controller.abort();
    emit(action);
    resolve({ unregister });
    const off = await pending;
    off();
    expect(unregister).toHaveBeenCalledOnce();
    expect(handled).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
