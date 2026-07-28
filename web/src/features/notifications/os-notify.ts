// input:  notification items, native-shell availability, and Tauri notification events
// output: permission-gated OS notification delivery and tap subscriptions
// pos:    Mobile native-notification bridge with browser fallback
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// OS/system-notification bridge (design 1q: mobile uses system push, not an in-app banner).
//
// The mobile app is a Tauri v2 Android shell wrapping this SPA (see desktop/CORTEX.md). The Android
// System WebView does NOT implement the web Notifications API, so `new Notification()` / service-worker
// `showNotification()` never fire there — the ONLY way to raise a real OS notification is the Tauri
// notification plugin (`@tauri-apps/plugin-notification`), which invokes the native shell.
//
// This module is the single seam the notification providers call. It is a no-op in a plain browser
// (no Tauri shell) so the SPA still builds + runs there; the caller falls back to the in-app toaster
// when `sendOsNotification` reports it could not deliver. The plugin is dynamically imported so the
// browser bundle never eagerly evaluates Tauri internals (they throw off-shell).
import { isNativeShell } from '@/lib/desktop-config';
import type { NotificationItem } from './notification-vm';

/** Minimal OS-notification payload — the native-agnostic shape a NotificationItem maps to. */
export interface OsNotificationSpec {
  title: string;
  body: string;
}

/** Pure map: a NotificationItem → the {title, body} an OS notification shows. Title = conversation /
 *  notice name (bold line); body = the one-line preview. Deterministic, DOM-free, unit-tested. */
export function osNotificationSpec(item: NotificationItem): OsNotificationSpec {
  return { title: item.title, body: item.meta };
}

/** True only inside the native (Tauri) shell — the only context where an OS notification can fire.
 *  A plain browser (including a narrow mobile browser) returns false → callers use the in-app toaster. */
export function osNotifyAvailable(): boolean {
  return isNativeShell();
}

// Cached permission result so we neither re-prompt nor re-invoke on every notification. `null` = not
// yet resolved this session.
let permissionGranted: boolean | null = null;

/** Ensure OS-notification permission, prompting once if still undecided. Returns whether it is granted.
 *  No-op (false) off-shell. Safe to call on mount and again lazily before the first send. */
export async function ensureOsNotifyPermission(): Promise<boolean> {
  if (!osNotifyAvailable()) return false;
  if (permissionGranted !== null) return permissionGranted;
  try {
    const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification');
    let granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === 'granted';
    }
    permissionGranted = granted;
    return granted;
  } catch {
    permissionGranted = false;
    return false;
  }
}

/** Fire an OS notification. `data` is an opaque string map echoed back verbatim to `onOsNotificationAction`
 *  when the user taps the notification (stored in the OS notification's `extra`), so the caller can route
 *  the tap — e.g. `{ sessionId, projectId }` for deep-link navigation. os-notify stays route-agnostic:
 *  it only carries the payload, the caller interprets it.
 *
 *  Returns true when the notification was handed to the native shell, false when it could not deliver
 *  (off-shell, permission denied, or a plugin error) — the caller then falls back to the in-app toaster
 *  so a notification is never silently dropped. */
export async function sendOsNotification(
  spec: OsNotificationSpec,
  data?: Record<string, string>,
): Promise<boolean> {
  if (!osNotifyAvailable()) return false;
  try {
    const granted = await ensureOsNotifyPermission();
    if (!granted) return false;
    const { sendNotification } = await import('@tauri-apps/plugin-notification');
    // autoCancel: tapping the notification dismisses it (Android) — the tap is delivered to onAction.
    sendNotification({ title: spec.title, body: spec.body, extra: data, autoCancel: true });
    return true;
  } catch {
    return false;
  }
}

/** Subscribe to notification taps. The callback receives the `data` payload passed to
 *  `sendOsNotification` (the OS notification's `extra`), letting the caller route the tap (deep-link).
 *  Returns an unsubscribe function; a no-op off-shell (a plain browser has no native notifications). */
export async function onOsNotificationAction(
  cb: (data: Record<string, unknown> | undefined) => void,
): Promise<() => void> {
  if (!osNotifyAvailable()) return () => {};
  try {
    const { onAction } = await import('@tauri-apps/plugin-notification');
    const listener = await onAction((n) => cb(n.extra));
    return () => {
      void listener.unregister();
    };
  } catch {
    return () => {};
  }
}
