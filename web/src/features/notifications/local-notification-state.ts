import { useSyncExternalStore } from 'react';

const KEY = 'cortex.local.notifications.enabled';
const CHANGE = 'cortex-local-notifications-change';
let volatile: boolean | undefined;
export function localNotificationsEnabled(): boolean {
  if (volatile !== undefined) return volatile;
  try { return localStorage.getItem(KEY) !== 'false'; } catch { return true; }
}
export function setLocalNotificationsEnabled(enabled: boolean): void {
  volatile = enabled;
  try { localStorage.setItem(KEY, String(enabled)); volatile = undefined; } catch { /* Keep the in-memory preference. */ }
  window.dispatchEvent(new Event(CHANGE));
}
function subscribe(listener: () => void): () => void {
  window.addEventListener(CHANGE, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(CHANGE, listener);
    window.removeEventListener('storage', listener);
  };
}
export function useLocalNotificationsEnabled(): boolean {
  return useSyncExternalStore(subscribe, localNotificationsEnabled, () => true);
}
export function notificationForeground(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus();
}
