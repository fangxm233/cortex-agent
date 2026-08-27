// input:  optional window.__TAURI__ core, event, and Android back-button capabilities
// output: typed capability checks, non-throwing invokes, and idempotent listener teardown
// pos:    Single runtime-checked native bridge boundary shared by lib, features, and mobile
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

interface NativeCommandMap {
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
