// input:  notification items, shell flags and native bridge
// output: permission-gated posts and retained tap subscriptions
// pos:    OS notification delivery with old-shell fallback
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

import { isMobileShell, isNativeShell } from '@/lib/desktop-config';
import {
  isNativeCommandMissing, listenNativeNotificationActions, mobileNotificationStatus, safeInvoke,
} from '@/lib/native-bridge';
import type { NotificationItem } from './notification-vm';

export interface OsNotificationSpec { title: string; body: string }
export type OsActionHandler = (data: Record<string, unknown> | undefined) => void | boolean | Promise<void | boolean>;

export function osNotificationSpec(item: NotificationItem): OsNotificationSpec {
  return { title: item.title, body: item.meta };
}

export function osNotifyAvailable(): boolean { return isNativeShell(); }

let permissionGranted: boolean | null = null;
let permissionRequest: Promise<boolean> | undefined;
const PROMPT_KEY = 'cortex.mobile.notifications.permission-requested';
let prompted = false;

function wasPrompted(): boolean {
  if (!isMobileShell()) return prompted;
  try { return prompted || localStorage.getItem(PROMPT_KEY) === 'true'; }
  catch { return prompted; }
}

function rememberPrompt(): void {
  prompted = true;
  if (!isMobileShell()) return;
  try { localStorage.setItem(PROMPT_KEY, 'true'); } catch { /* In-memory guard remains. */ }
}

/** Resume rechecks OS settings without showing another permission dialog. */
export async function refreshOsNotifyPermission(): Promise<boolean> {
  if (!osNotifyAvailable()) return false;
  try {
    const { isPermissionGranted } = await import('@tauri-apps/plugin-notification');
    permissionGranted = await isPermissionGranted();
  } catch { permissionGranted = false; }
  return permissionGranted;
}

async function requestOnce(): Promise<boolean> {
  if (await refreshOsNotifyPermission()) return true;
  if (wasPrompted()) return false;
  if (isMobileShell() && typeof document !== 'undefined' && document.visibilityState !== 'visible') return false;
  rememberPrompt();
  try {
    const { requestPermission } = await import('@tauri-apps/plugin-notification');
    permissionGranted = (await requestPermission()) === 'granted';
  } catch { permissionGranted = false; }
  return permissionGranted;
}

export async function ensureOsNotifyPermission(): Promise<boolean> {
  if (!osNotifyAvailable()) return false;
  if (permissionRequest) return permissionRequest;
  if (permissionGranted !== null) return permissionGranted;
  permissionRequest = requestOnce().finally(() => { permissionRequest = undefined; });
  return permissionRequest;
}

export async function sendOsNotification(spec: OsNotificationSpec, data?: Record<string, string>): Promise<boolean> {
  if (!osNotifyAvailable()) return false;
  try {
    if (!await ensureOsNotifyPermission()) return false;
    if (isMobileShell()) {
      const result = await safeInvoke('plugin:cortex-notifications|post', { ...spec, data });
      if (!isNativeCommandMissing(result)) return result.ok;
    }
    const { sendNotification } = await import('@tauri-apps/plugin-notification');
    sendNotification({ ...spec, extra: data, autoCancel: true });
    return true;
  } catch { return false; }
}

/** Installed plugin emits notification.extra on Android; older shells emit extra. */
function legacyActionData(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const nested = Reflect.get(value, 'notification');
  const extra: unknown = nested && typeof nested === 'object'
    ? Reflect.get(nested, 'extra') ?? Reflect.get(value, 'extra') : Reflect.get(value, 'extra');
  return extra && typeof extra === 'object' ? extra as Record<string, unknown> : undefined;
}

async function listenLegacyActions(cb: OsActionHandler, signal?: AbortSignal): Promise<() => void> {
  let disposed = signal?.aborted ?? false;
  let unregister = () => {};
  const off = () => {
    disposed = true;
    signal?.removeEventListener('abort', off);
    unregister();
  };
  signal?.addEventListener('abort', off, { once: true });
  try {
    const { onAction } = await import('@tauri-apps/plugin-notification');
    if (disposed) return off;
    const listener = await onAction((value) => {
      if (!disposed) void Promise.resolve(cb(legacyActionData(value))).catch(() => {});
    });
    let removed = false;
    unregister = () => {
      if (removed) return;
      removed = true;
      void listener.unregister().catch(() => {});
    };
    if (disposed) unregister();
  } catch { off(); }
  return off;
}

export async function onOsNotificationAction(cb: OsActionHandler, signal?: AbortSignal): Promise<() => void> {
  if (!osNotifyAvailable() || signal?.aborted) return () => {};
  if (!isMobileShell()) return listenLegacyActions(cb, signal);
  try {
    const status = await mobileNotificationStatus();
    if (status) return listenNativeNotificationActions((action) => cb({ ...action }), signal);
    return listenLegacyActions(cb, signal);
  } catch { return () => {}; }
}
