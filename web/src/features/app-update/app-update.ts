// The Tauri shell checks the server's /api/app-update/manifest.json in the background, downloads +
// sha256-verifies the platform asset from the GitHub release, then emits `app-update-available`
// (see desktop/src-tauri/src/app_update.rs). Installing is platform-branched shell-side: AppImage
// swaps itself and relaunches, Windows hands off to the NSIS installer, Android raises the system
// package installer, dmg/deb/rpm are opened from Downloads for the user to finish.
//
// Off-shell (plain browser / ui-http) every seam function is a no-op — the prompt is APP-only.
// A pending shell update SUPERSEDES the SPA-only hot-update prompt (the new shell ships a fresh
// SPA seed and OTA converges the rest), so the shared headless prompt owner selects this store first.
import type { Vocab } from '@/i18n/vocab';
import { isNativeShell } from '@/lib/desktop-config';
import { listenNativeEvent, safeInvoke } from '@/lib/native-bridge';
import { formatUpdateSize } from '@/features/hot-update/frontend-update';

/** A downloaded, verified app shell update (payload of `app-update-available` / `get_app_update`). */
export interface AppUpdateInfo {
  /** CalVer release version, e.g. `2026.7.30`. */
  version: string;
  /** GitHub release page URL. */
  releaseUrl?: string;
  /** Release notes (markdown), server-truncated. */
  notes?: string;
  /** Installer byte size; absent when unknown. */
  size?: number;
  /** Package kind driving the install flow: appimage / nsis / apk / dmg / deb / rpm. */
  kind: string;
  /**
   * What the shell will do with this update, decided from where the app is actually installed and
   * the user's preference (desktop/src-tauri/src/install_site.rs):
   *
   *   `silent` — it installs itself when the app next quits, so NO modal may be raised; a toast is
   *              the whole notification.
   *   `prompt` — the user has to act (portable copy, package-manager install, silent turned off).
   *
   * Absent on an older shell that predates silent updating, which is exactly `prompt`.
   */
  apply: 'silent' | 'prompt';
}

export const APP_UPDATE_AVAILABLE_EVENT = 'app-update-available';

// ─── Pure helpers (DOM-free, unit-tested) ───────────────────────────────────

/** Coerce an unknown event payload into an AppUpdateInfo, or null if it is not shaped like one. */
export function parseAppUpdate(payload: unknown): AppUpdateInfo | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.version !== 'string' || !p.version) return null;
  if (typeof p.kind !== 'string' || !p.kind) return null;
  // Default to `prompt`: an unknown or older shell must ask rather than silently assume consent.
  const apply = p.apply === 'silent' ? 'silent' : 'prompt';
  const u: AppUpdateInfo = { version: p.version, kind: p.kind, apply };
  if (typeof p.releaseUrl === 'string' && p.releaseUrl) u.releaseUrl = p.releaseUrl;
  if (typeof p.notes === 'string' && p.notes) u.notes = p.notes;
  if (typeof p.size === 'number' && p.size > 0) u.size = p.size;
  return u;
}

/** Toast copy for an update that will install itself on quit — the only notice a silent update gets. */
export function silentUpdateNotice(update: AppUpdateInfo, L: Vocab): string {
  return L.updateSilentNotice.replace('{version}', update.version);
}

/** Mono meta line under the title: `Cortex <version> · <size> · 已下载` (size omitted if unknown). */
export function appUpdateSummaryLine(update: AppUpdateInfo, L: Vocab): string {
  const parts = [`Cortex ${update.version}`];
  const size = formatUpdateSize(update.size);
  if (size) parts.push(size);
  parts.push(L.updateDownloaded);
  return parts.join(' · ');
}

/** Primary-button label per install flow. */
export function installCtaLabel(kind: string, L: Vocab): string {
  switch (kind) {
    case 'appimage': return L.updateRestartInstall;
    case 'nsis': return L.updateRunInstaller;
    case 'apk': return L.updateInstall;
    case 'dmg':
    case 'deb':
    case 'rpm': return L.updateOpenInstaller;
    default: return L.updateApply;
  }
}

/** Reassurance / instruction copy per install flow. */
export function installDescription(kind: string, L: Vocab): string {
  switch (kind) {
    case 'appimage':
      return L.updateAppimageHint;
    case 'nsis':
      return L.updateNsisHint;
    case 'apk':
      return L.updateApkHint;
    case 'dmg':
      return L.updateDmgHint;
    case 'deb':
    case 'rpm':
      return L.updatePackageHint;
    default:
      return L.updateInstallHint;
  }
}

// ─── Module store (availability observable by any surface) ──────────────────

let current: AppUpdateInfo | null = null;
const subscribers = new Set<() => void>();

/** Set / clear the pending app update and notify subscribers. Also called by tests. */
export function publishAppUpdate(update: AppUpdateInfo | null): void {
  current = update;
  for (const cb of subscribers) cb();
}

export function subscribeAppUpdate(cb: () => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export function getAppUpdateSnapshot(): AppUpdateInfo | null {
  return current;
}

// ─── Native-shell seam (off-shell no-op) ────────────────────────────────────

/**
 * Start the bridge: subscribe to `app-update-available` and run the `get_app_update` backstop for a
 * missed event, publishing into the store. Returns an unsubscribe fn; a no-op off-shell (browser).
 */
export async function startAppUpdateBridge(): Promise<() => void> {
  if (!isNativeShell()) return () => {};
  const unlisten = await listenNativeEvent(APP_UPDATE_AVAILABLE_EVENT, (payload) => {
    const update = parseAppUpdate(payload);
    if (update) publishAppUpdate(update);
  });
  const existing = await safeInvoke('get_app_update');
  if (existing.ok) {
    const update = parseAppUpdate(existing.value);
    if (update) publishAppUpdate(update);
  }
  return unlisten;
}

/**
 * Install the pending update. Resolves to the opened installer path for the assisted flows
 * (dmg/deb/rpm), null when the shell handed off (it may exit before this resolves). Throws with the
 * shell's error message on failure.
 */
export async function installAppUpdate(): Promise<string | null> {
  if (!isNativeShell()) return null;
  const result = await safeInvoke('install_app_update');
  if (result.ok) return typeof result.value === 'string' ? result.value : null;
  // The handoff flows tear the webview down. String rejections are real shell failures to surface.
  if (result.reason === 'failed' && typeof result.error === 'string' && result.error) {
    throw new Error(result.error);
  }
  return null;
}

/** Persist "skip this version" shell-side and clear the pending update locally. */
export async function skipAppUpdate(): Promise<void> {
  publishAppUpdate(null);
  if (!isNativeShell()) return;
  await safeInvoke('skip_app_update');
}
