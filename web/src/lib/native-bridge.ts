// input:  optional Tauri core, events and Android plugins
// output: typed invokes, foreground-retried retained actions and safe listeners
// pos:    Canonical native boundary for all web surfaces
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

type NativeArgs = Record<string, unknown>;
type NativeUnlisten = () => unknown;
type NativeEventHandler = (event: unknown) => void;
type NativeBackHandler = (payload: unknown) => void;

interface NativeGlobal {
  core?: { invoke?: (command: string, args?: NativeArgs) => Promise<unknown> };
  event?: { listen?: (event: string, handler: NativeEventHandler) => Promise<NativeUnlisten> };
  app?: { onBackButtonPress?: (handler: NativeBackHandler) => Promise<unknown> };
}

export interface NativeForwardInfo {
  remotePort: number;
  localPort: number;
  url: string;
}

export interface NativeNotificationStatus {
  enabled: boolean;
  running: boolean;
  permissionGranted: boolean;
  scope: string;
}

export interface NativeNotificationAction {
  actionId: string;
  scope: string;
  kind: 'session' | 'approvals' | 'sessions';
  sessionId?: string;
  projectId?: string;
  approvalId?: string;
}

interface NativeCommandMap {
  mobile_notifications_configure: {
    args: { enabled: boolean; locale: string }; result: NativeNotificationStatus;
  };
  mobile_notifications_status: { args: undefined; result: NativeNotificationStatus };
  'plugin:cortex-notifications|post': {
    args: { title: string; body: string; data?: Record<string, string> }; result: unknown;
  };
  'plugin:cortex-notifications|pending_actions': {
    args: undefined; result: { actions: NativeNotificationAction[] };
  };
  'plugin:cortex-notifications|ack_action': { args: { actionId: string }; result: unknown };
  disconnect: { args: undefined; result: unknown };
  get_app_update: { args: undefined; result: unknown };
  install_app_update: { args: undefined; result: unknown };
  skip_app_update: { args: undefined; result: unknown };
  get_staged_update: { args: undefined; result: unknown };
  apply_frontend_update: { args: undefined; result: unknown };
  save_download: { args: { name: string; bytes: number[] }; result: string };
  open_path: { args: { path: string }; result: unknown };
  reveal_path: { args: { path: string }; result: unknown };
  'plugin:cortex-download|download': {
    args: { url: string; fileName: string; token: string | undefined };
    result: unknown;
  };
  forward_start: { args: { port: number }; result: NativeForwardInfo };
  forward_stop: { args: { port: number }; result: unknown };
  forward_list: { args: undefined; result: NativeForwardInfo[] };
  'plugin:app|exit': { args: undefined; result: unknown };
}

export type NativeCapability = 'invoke' | 'events' | 'back';
export type NativeUnsubscribe = () => void;
export type NativeInvokeResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'unavailable' }
  | { ok: false; reason: 'failed'; error: unknown };

type NativeCommand = keyof NativeCommandMap;
type CommandArgs<K extends NativeCommand> = NativeCommandMap[K]['args'] extends undefined
  ? [args?: undefined]
  : [args: NativeCommandMap[K]['args']];
type CommandResult<K extends NativeCommand> = NativeCommandMap[K]['result'];
type NativeEventName = 'app-update-available' | 'frontend-update-staged';

function readNativeGlobal(): NativeGlobal | undefined {
  const value: unknown = Reflect.get(globalThis, '__TAURI__');
  if (!value || typeof value !== 'object') return undefined;
  return value as NativeGlobal;
}

export function nativeCapabilities(): Record<NativeCapability, boolean> {
  const native = readNativeGlobal();
  return {
    invoke: typeof native?.core?.invoke === 'function',
    events: typeof native?.event?.listen === 'function',
    back: typeof native?.app?.onBackButtonPress === 'function',
  };
}

export function hasNativeCapability(capability: NativeCapability): boolean {
  return nativeCapabilities()[capability];
}

export async function safeInvoke<K extends NativeCommand>(
  command: K,
  ...[args]: CommandArgs<K>
): Promise<NativeInvokeResult<CommandResult<K>>> {
  const core = readNativeGlobal()?.core;
  if (typeof core?.invoke !== 'function') return { ok: false, reason: 'unavailable' };
  try {
    const value = await core.invoke(command, args);
    return { ok: true, value: value as CommandResult<K> };
  } catch (error) {
    return { ok: false, reason: 'failed', error };
  }
}

function idempotent(unsubscribe: NativeUnlisten): NativeUnsubscribe {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    try {
      void Promise.resolve(unsubscribe()).catch(() => {});
    } catch {
      // A torn-down native listener is already in the desired state.
    }
  };
}

function eventPayload(event: unknown): unknown {
  if (!event || typeof event !== 'object') return undefined;
  return Reflect.get(event, 'payload');
}

export async function listenNativeEvent(
  event: NativeEventName,
  handler: (payload: unknown) => void,
): Promise<NativeUnsubscribe> {
  const events = readNativeGlobal()?.event;
  if (typeof events?.listen !== 'function') return idempotent(() => {});
  try {
    const unlisten = await events.listen(event, (nativeEvent) => {
      handler(eventPayload(nativeEvent));
    });
    return idempotent(typeof unlisten === 'function' ? unlisten : () => {});
  } catch {
    return idempotent(() => {});
  }
}

function listenerUnregister(listener: unknown): NativeUnlisten {
  if (!listener || typeof listener !== 'object') return () => {};
  const unregister: unknown = Reflect.get(listener, 'unregister');
  return typeof unregister === 'function' ? () => unregister.call(listener) : () => {};
}

/** Missing commands on an older APK are compatibility, not successful delivery. */
export function isNativeCommandMissing(result: NativeInvokeResult<unknown>): boolean {
  if (result.ok) return false;
  if (result.reason === 'unavailable') return true;
  return /(?:command|plugin).*(?:not found|unknown|not registered)|unknown command|not implemented/i.test(String(result.error));
}

export async function mobileNotificationStatus(): Promise<NativeNotificationStatus | null> {
  const result = await safeInvoke('mobile_notifications_status');
  if (isNativeCommandMissing(result)) return null;
  if (!result.ok) throw new Error('Unable to read native notification status');
  const status = result.value;
  if (!status || typeof status.scope !== 'string'
    || !['enabled', 'running', 'permissionGranted'].every((key) => typeof Reflect.get(status, key) === 'boolean')) {
    throw new Error('Invalid native notification status');
  }
  return status;
}

function notificationAction(value: unknown): NativeNotificationAction | null {
  if (!value || typeof value !== 'object') return null;
  const action = value as NativeNotificationAction;
  if (typeof action.actionId !== 'string' || !action.actionId) return null;
  if (typeof action.scope !== 'string' || !action.scope) return null;
  if (!['session', 'sessions', 'approvals'].includes(action.kind)) return null;
  return action;
}

function retainedActionHandler(
  cb: (action: NativeNotificationAction) => void | boolean | Promise<void | boolean>,
  disposed: () => boolean,
  settled: () => void,
) {
  const handled = new Set<string>();
  const pending = new Set<string>();
  const retries = new Map<string, NativeNotificationAction>();
  let tail = Promise.resolve();
  const receive = (value: unknown) => {
    const action = notificationAction(value);
    if (disposed() || !action || pending.has(action.actionId)) return;
    pending.add(action.actionId);
    retries.delete(action.actionId);
    let retry = true;
    tail = tail.then(async () => {
      if (disposed()) return;
      const status = await mobileNotificationStatus();
      if (disposed()) return;
      if (!status?.scope || action.scope !== status.scope) {
        // Another server's retained actions wait for a future focus/resume drain.
        retry = false;
        return;
      }
      if (!handled.has(action.actionId)) {
        // Successful navigation may itself unmount the listener; it still must be acknowledged.
        if (await cb(action) === false) return;
        handled.add(action.actionId);
      }
      const ack = await safeInvoke('plugin:cortex-notifications|ack_action', { actionId: action.actionId });
      retry = !ack.ok && !isNativeCommandMissing(ack);
    }).catch(() => {}).finally(() => {
      pending.delete(action.actionId);
      if (disposed()) return;
      if (retry) retries.set(action.actionId, action);
      settled();
    });
  };
  return {
    receive,
    hasPending: () => retries.size > 0,
    retry: () => [...retries.values()].forEach(receive),
  };
}

const ACTION_RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000];

/** Register before draining; retry failures in bounded foreground bursts until acknowledged. */
export async function listenNativeNotificationActions(
  cb: (action: NativeNotificationAction) => void | boolean | Promise<void | boolean>,
  signal?: AbortSignal,
): Promise<NativeUnsubscribe> {
  let disposed = signal?.aborted ?? false;
  let unregister = () => {};
  let registered = false;
  let draining = false;
  let drainFailed = false;
  let retryAttempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const foreground = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
  const clearRetry = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const scheduleRetry = () => {
    if (!drainFailed && !actions.hasPending()) { clearRetry(); return; }
    if (disposed || !registered || !foreground() || timer !== undefined
      || retryAttempt >= ACTION_RETRY_DELAYS.length) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || !foreground()) return;
      retryAttempt++;
      actions.retry();
      if (drainFailed) void drain();
    }, ACTION_RETRY_DELAYS[retryAttempt]);
  };
  const actions = retainedActionHandler(cb, () => disposed, scheduleRetry);
  const drain = async () => {
    if (disposed || !registered || draining) return;
    draining = true;
    try {
      const result = await safeInvoke('plugin:cortex-notifications|pending_actions');
      if (disposed) return;
      drainFailed = !result.ok && !isNativeCommandMissing(result);
      if (result.ok) result.value.actions.forEach(actions.receive);
    } catch {
      drainFailed = true;
    } finally {
      draining = false;
      scheduleRetry();
    }
  };
  const resume = () => {
    clearRetry();
    if (disposed || !registered || !foreground()) return;
    retryAttempt = 0;
    actions.retry();
    void drain();
  };
  const receive = (value: unknown) => {
    if (disposed) return;
    retryAttempt = 0;
    actions.receive(value);
  };
  const off = idempotent(() => {
    disposed = true;
    clearRetry();
    signal?.removeEventListener('abort', off);
    if (typeof window !== 'undefined') window.removeEventListener('focus', resume);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', resume);
    unregister();
  });
  if (disposed) return off;
  signal?.addEventListener('abort', off, { once: true });
  try {
    const { addPluginListener } = await import('@tauri-apps/api/core');
    if (disposed) return off;
    const listener = await addPluginListener('cortex-notifications', 'actionPerformed', receive);
    unregister = idempotent(() => listener.unregister());
    if (disposed) { unregister(); return off; }
    registered = true;
    if (typeof window !== 'undefined') window.addEventListener('focus', resume);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', resume);
    await drain();
  } catch { off(); }
  return off;
}

export function listenNativeBack(handler: (payload: unknown) => void): NativeUnsubscribe {
  const app = readNativeGlobal()?.app;
  if (typeof app?.onBackButtonPress !== 'function') return idempotent(() => {});
  let pending: Promise<unknown>;
  try {
    pending = Promise.resolve(app.onBackButtonPress(handler));
  } catch {
    return idempotent(() => {});
  }
  let disposed = false;
  let unregister: NativeUnsubscribe | undefined;
  void pending.then((listener) => {
    unregister = idempotent(listenerUnregister(listener));
    if (disposed) unregister();
  }).catch(() => {});
  return idempotent(() => {
    disposed = true;
    unregister?.();
  });
}
