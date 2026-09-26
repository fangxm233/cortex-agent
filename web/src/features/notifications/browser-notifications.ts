import { isNativeShell } from '@/lib/desktop-config';
import { notificationConnectionGuard } from './notification-connection';
import type { OsNotificationSpec } from './os-notify';

export type BrowserPermission = NotificationPermission | 'unsupported';
type Activate = (current: () => boolean) => void | Promise<void>;
type Notices = Map<Notification, () => void>;

export function browserPermission(): BrowserPermission {
  if (isNativeShell() || !globalThis.isSecureContext || typeof Notification !== 'function') return 'unsupported';
  return Notification.permission;
}
/** Called directly from the settings button, never by delivery or mounting. */
export async function requestBrowserPermission(): Promise<BrowserPermission> {
  if (browserPermission() === 'unsupported') return 'unsupported';
  try { return await Notification.requestPermission(); } catch { return browserPermission(); }
}

function watchNotice(notice: Notification, notices: Notices, activate: Activate, current: () => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const cleanup = () => {
      notice.onclick = null; notice.onclose = null; notice.onshow = null; notice.onerror = null;
      notices.delete(notice);
      resolve(false);
    };
    notices.set(notice, cleanup);
    notice.onshow = () => resolve(true);
    notice.onclose = cleanup;
    notice.onerror = () => { cleanup(); notice.close(); };
    notice.onclick = () => {
      if (!current()) return;
      resolve(true);
      window.focus();
      void Promise.resolve(activate(current)).catch(() => {});
      notice.close();
    };
  });
}

export function createBrowserNotifications() {
  const notices: Notices = new Map();
  let disposed = false;
  const send = async (spec: OsNotificationSpec, activate: Activate): Promise<boolean> => {
    if (disposed || browserPermission() !== 'granted') return false;
    const sameConnection = notificationConnectionGuard();
    const current = () => !disposed && sameConnection();
    try {
      return await watchNotice(new Notification(spec.title, { body: spec.body }), notices, activate, current);
    } catch { return false; }
  };
  const dispose = () => {
    disposed = true;
    notices.forEach((cleanup, notice) => { cleanup(); notice.close(); });
    notices.clear();
  };
  return { send, dispose };
}
