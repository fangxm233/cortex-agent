// input:  native status/configuration and OS notification permission
// output: device-local state, completion ownership and visible reconciliation
// pos:    Android background notification lifecycle owner
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

import { useEffect, useSyncExternalStore } from 'react';
import { isMobileShell } from '@/lib/desktop-config';
import { mobileNotificationStatus, safeInvoke, type NativeNotificationStatus } from '@/lib/native-bridge';
import { ensureOsNotifyPermission, refreshOsNotifyPermission } from './os-notify';

interface MobileNotificationState {
  status: NativeNotificationStatus | null;
  supported: boolean | null;
  pending: boolean;
  error: 'permission' | 'configure' | null;
}
let state: MobileNotificationState = { status: null, supported: null, pending: false, error: null };
const listeners = new Set<() => void>();
let tail = Promise.resolve();
const visible = () => typeof document !== 'undefined' && document.visibilityState === 'visible';
const snapshot = () => state;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function publish(update: Partial<MobileNotificationState>): void {
  state = { ...state, ...update };
  listeners.forEach((listener) => listener());
}

// The page declares completion ownership on every sync, so an older cached page
// silently takes it back and keeps posting its own turn notifications.
async function configure(enabled: boolean, locale: string): Promise<NativeNotificationStatus> {
  const result = await safeInvoke('mobile_notifications_configure',
    { enabled, locale, completionNotifications: true });
  if (!result.ok) throw new Error('Native notification configuration failed');
  return result.value;
}

/** True while the native service, not this page, posts turn-completion notifications. */
export function nativeCompletionNotifications(): boolean {
  return state.status?.completionNotifications === true && state.status.enabled;
}

function enqueue(operation: () => Promise<void>): Promise<void> {
  tail = tail.then(operation).catch(() => { publish({ error: 'configure', pending: false }); });
  return tail;
}

async function reconcile(locale: string, initial: boolean, active: () => boolean): Promise<void> {
  if (!active() || !visible()) return;
  const status = await mobileNotificationStatus();
  if (!active()) return;
  publish({ status, supported: status !== null });
  const granted = await (initial ? ensureOsNotifyPermission() : refreshOsNotifyPermission());
  if (!status || !active() || !visible()) return;
  if (status.enabled && !granted) {
    publish({ status: { ...status, permissionGranted: false } });
    return;
  }
  // Even disabled configuration syncs native credentials for ordinary post/tap support.
  const next = await configure(status.enabled, locale);
  if (active()) publish({ status: next, error: null });
}

/** Only the mobile provider owns listeners. Unmount never stops the native service. */
export function startMobileNotifications(locale: string): () => void {
  if (!isMobileShell()) return () => {};
  let active = true;
  const resume = () => { void enqueue(() => reconcile(locale, false, () => active)); };
  void enqueue(() => reconcile(locale, true, () => active));
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('focus', resume);
  return () => {
    active = false;
    document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('focus', resume);
  };
}

export function useMobileNotificationLifecycle(locale: string): void {
  useEffect(() => startMobileNotifications(locale), [locale]);
}

export function useMobileNotificationSettings(): MobileNotificationState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Native preference is authoritative: failed toggles never optimistically flip it. */
export function setMobileNotificationsEnabled(enabled: boolean, locale: string): Promise<void> {
  if (!isMobileShell() || state.pending) return Promise.resolve();
  publish({ pending: true, error: null });
  return enqueue(async () => {
    // Permission IPC can outlive the foreground window; recheck visibility after it settles.
    if (enabled && (!visible() || !await refreshOsNotifyPermission() || !visible())) {
      publish({ pending: false, error: 'permission' });
      return;
    }
    const status = await configure(enabled, locale);
    publish({ status, supported: true, pending: false, error: null });
  });
}
