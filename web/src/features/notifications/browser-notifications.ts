// input:  Notification API, connection guard
// output: Browser permission and notification adapter
// pos:    Browser-only OS delivery with disposable click handlers
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { isNativeShell } from '@/lib/desktop-config';
import { notificationConnectionGuard } from './notification-connection';
import type { OsNotificationSpec } from './os-notify';

export type BrowserPermission = NotificationPermission | 'unsupported';
export function browserPermission(): BrowserPermission {
  if (isNativeShell() || !globalThis.isSecureContext || typeof Notification !== 'function') return 'unsupported';
  return Notification.permission;
}
/** Called directly from the settings button, never by delivery or mounting. */
export async function requestBrowserPermission(): Promise<BrowserPermission> {
  if (browserPermission() === 'unsupported') return 'unsupported';
  try { return await Notification.requestPermission(); } catch { return browserPermission(); }
}

export function createBrowserNotifications() {
  const notices = new Set<Notification>();
  let disposed = false;
  const send = (spec: OsNotificationSpec, activate: (current: () => boolean) => void | Promise<void>): boolean => {
    if (disposed || browserPermission() !== 'granted') return false;
    const sameConnection = notificationConnectionGuard();
    const current = () => !disposed && sameConnection();
    try {
      const notice = new Notification(spec.title, { body: spec.body });
      notices.add(notice);
      notice.onclose = () => { notice.onclick = null; notices.delete(notice); };
      notice.onclick = () => {
        if (!current()) return;
        window.focus();
        void Promise.resolve(activate(current)).catch(() => {});
        notice.close();
      };
      return true;
    } catch { return false; }
  };
  const dispose = () => {
    disposed = true;
    notices.forEach((notice) => { notice.onclick = null; notice.onclose = null; notice.close(); });
    notices.clear();
  };
  return { send, dispose };
}
