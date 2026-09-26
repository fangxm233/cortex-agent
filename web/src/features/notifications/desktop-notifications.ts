import { readDesktopConfig } from '@/lib/desktop-config';
import { isNativeCommandMissing, listenNativeEvent, safeInvoke,
  type DesktopNotificationAction } from '@/lib/native-bridge';
import { notificationConnectionGuard } from './notification-connection';
import { sendOsNotification, type OsNotificationSpec } from './os-notify';

type Target = { sessionId?: string; projectId?: string };
type ActionHandler = (action: DesktopNotificationAction, current: () => boolean) => Promise<boolean>;

export async function sendDesktopNotification(spec: OsNotificationSpec, data?: Target): Promise<boolean> {
  const result = await safeInvoke('desktop_notifications_post', { ...spec, data });
  if (result.ok) return true;
  // Old shells can display only. Never register stock onAction on desktop.
  if (result.reason === 'failed' && isNativeCommandMissing(result)) return sendOsNotification(spec, data);
  return false;
}

async function routeAction(action: DesktopNotificationAction, cb: ActionHandler, current: () => boolean) {
  if (!current()) return;
  if (action.serverUrl !== readDesktopConfig()?.serverUrl) {
    await safeInvoke('desktop_notifications_ack', { actionId: action.actionId });
    return;
  }
  if (await cb(action, current) && current()) {
    await safeInvoke('desktop_notifications_ack', { actionId: action.actionId });
  }
}

async function drainActions(cb: ActionHandler, current: () => boolean) {
  if (!current()) return;
  const result = await safeInvoke('desktop_notifications_pending');
  if (!current() || isNativeCommandMissing(result)) return;
  if (!result.ok) throw new Error('Unable to read pending desktop notification actions');
  for (const action of result.value.actions) await routeAction(action, cb, current);
}

const ACTION_RETRY_DELAYS = [1_000, 2_000, 4_000];

function actionDrainer(cb: ActionHandler, current: () => boolean) {
  let tail = Promise.resolve();
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearRetry = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  // Retry and resume drains share the event queue: never route a retained click concurrently.
  const drain = () => {
    tail = tail.then(async () => {
      clearRetry();
      await drainActions(cb, current);
      attempt = 0;
    }).catch(() => {
      if (!current() || attempt >= ACTION_RETRY_DELAYS.length) return;
      timer = setTimeout(() => { timer = undefined; void drain(); }, ACTION_RETRY_DELAYS[attempt++]);
    });
    return tail;
  };
  const resume = () => { clearRetry(); attempt = 0; void drain(); };
  return { drain, resume, dispose: clearRetry };
}

export async function listenDesktopNotificationActions(cb: ActionHandler, signal?: AbortSignal): Promise<() => void> {
  let disposed = signal?.aborted ?? false;
  let unregister = () => {};
  const sameConnection = notificationConnectionGuard();
  const current = () => !disposed && sameConnection();
  const actions = actionDrainer(cb, current);
  const off = () => {
    disposed = true;
    actions.dispose();
    signal?.removeEventListener('abort', off);
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', actions.resume);
      window.removeEventListener('online', actions.resume);
    }
    unregister();
  };
  if (disposed) return off;
  signal?.addEventListener('abort', off, { once: true });
  unregister = await listenNativeEvent('desktop-notification-action', actions.resume);
  if (disposed) { unregister(); return off; }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', actions.resume);
    window.addEventListener('online', actions.resume);
  }
  await actions.drain();
  return off;
}
