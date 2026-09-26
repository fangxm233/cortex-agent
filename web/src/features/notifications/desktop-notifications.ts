// input:  native-bridge, desktop-config, legacy OS delivery
// output: Desktop notification post and retained action listener
// pos:    Desktop native notification adapter
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
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
  if (await cb(action, current)) await safeInvoke('desktop_notifications_ack', { actionId: action.actionId });
}

function actionDrainer(cb: ActionHandler, current: () => boolean): () => Promise<void> {
  let tail = Promise.resolve();
  const drain = async () => {
    if (!current()) return;
    const result = await safeInvoke('desktop_notifications_pending');
    if (!result.ok || !current()) return;
    for (const action of result.value.actions) await routeAction(action, cb, current);
  };
  // Serialize event drains so the same retained click cannot route twice before ack.
  return () => { tail = tail.then(drain).catch(() => {}); return tail; };
}

export async function listenDesktopNotificationActions(cb: ActionHandler, signal?: AbortSignal): Promise<() => void> {
  let disposed = signal?.aborted ?? false;
  let unregister = () => {};
  const sameConnection = notificationConnectionGuard();
  const current = () => !disposed && sameConnection();
  const off = () => { disposed = true; signal?.removeEventListener('abort', off); unregister(); };
  if (disposed) return off;
  signal?.addEventListener('abort', off, { once: true });
  const drain = actionDrainer(cb, current);
  unregister = await listenNativeEvent('desktop-notification-action', () => { void drain(); });
  if (disposed) { unregister(); return off; }
  await drain();
  return off;
}
