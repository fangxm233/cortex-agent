// App shell update bridge — the seam the app-update prompt talks to the native shell over, plus a
// tiny module-level store so OTHER surfaces (the hot-update prompt) can observe availability.
//
// The Tauri shell checks the server's /api/app-update/manifest.json in the background, downloads +
// sha256-verifies the platform asset from the GitHub release, then emits `app-update-available`
// (see desktop/src-tauri/src/app_update.rs). Installing is platform-branched shell-side: AppImage
// swaps itself and relaunches, Windows hands off to the NSIS installer, Android raises the system
// package installer, dmg/deb/rpm are opened from Downloads for the user to finish.
//
// Off-shell (plain browser / ui-http) every seam function is a no-op — the prompt is APP-only.
// A pending shell update SUPERSEDES the SPA-only hot-update prompt (the new shell ships a fresh
// SPA seed and OTA converges the rest), so the hot-update providers read this store and stand down
// while an app update is available.
import { isNativeShell } from '@/lib/desktop-config';
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
}

export const APP_UPDATE_AVAILABLE_EVENT = 'app-update-available';

// ─── Pure helpers (DOM-free, unit-tested) ───────────────────────────────────

/** Coerce an unknown event payload into an AppUpdateInfo, or null if it is not shaped like one. */
export function parseAppUpdate(payload: unknown): AppUpdateInfo | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.version !== 'string' || !p.version) return null;
  if (typeof p.kind !== 'string' || !p.kind) return null;
  const u: AppUpdateInfo = { version: p.version, kind: p.kind };
  if (typeof p.releaseUrl === 'string' && p.releaseUrl) u.releaseUrl = p.releaseUrl;
  if (typeof p.notes === 'string' && p.notes) u.notes = p.notes;
  if (typeof p.size === 'number' && p.size > 0) u.size = p.size;
  return u;
}

/** Mono meta line under the title: `Cortex <version> · <size> · 已下载` (size omitted if unknown). */
export function appUpdateSummaryLine(update: AppUpdateInfo): string {
  const parts = [`Cortex ${update.version}`];
  const size = formatUpdateSize(update.size);
  if (size) parts.push(size);
  parts.push('已下载');
  return parts.join(' · ');
}

/** Primary-button label per install flow. */
export function installCtaLabel(kind: string): string {
  switch (kind) {
    case 'appimage': return '重启更新';
    case 'nsis': return '运行安装程序';
    case 'apk': return '安装';
    case 'dmg':
    case 'deb':
    case 'rpm': return '打开安装包';
    default: return '更新';
  }
}

/** Reassurance / instruction copy per install flow. */
export function installDescription(kind: string): string {
  switch (kind) {
    case 'appimage':
      return '新版本已在后台下载并校验完成，点击后自动替换并重启。运行中的线程在服务端继续执行，不受影响。';
    case 'nsis':
      return '新版本已在后台下载并校验完成。点击后将退出 App 并启动安装程序，按提示完成安装后重新打开即可。';
    case 'apk':
      return '新版本已在后台下载并校验完成。点击安装后按系统提示完成升级，运行中的线程在服务端继续执行。';
    case 'dmg':
      return '新版本已在后台下载并校验完成。将打开磁盘映像，把 Cortex 拖入 Applications 即完成升级。';
    case 'deb':
    case 'rpm':
      return '新版本已在后台下载并校验完成。将打开安装包，用系统安装器完成升级后重新打开 App。';
    default:
      return '新版本已在后台下载并校验完成。';
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

interface TauriGlobal {
  event?: {
    listen: (
      event: string,
      handler: (e: { payload: unknown }) => void,
    ) => Promise<() => void>;
  };
  core?: { invoke: <T = unknown>(cmd: string) => Promise<T> };
}

function tauri(): TauriGlobal | undefined {
  return (globalThis as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
}

/**
 * Start the bridge: subscribe to `app-update-available` and run the `get_app_update` backstop for a
 * missed event, publishing into the store. Returns an unsubscribe fn; a no-op off-shell (browser).
 */
export async function startAppUpdateBridge(): Promise<() => void> {
  if (!isNativeShell()) return () => {};
  const t = tauri();
  if (!t) return () => {};
  let unlisten = () => {};
  try {
    if (t.event) {
      const fn = await t.event.listen(APP_UPDATE_AVAILABLE_EVENT, (e) => {
        const u = parseAppUpdate(e.payload);
        if (u) publishAppUpdate(u);
      });
      unlisten = () => {
        try { fn(); } catch { /* already torn down */ }
      };
    }
    const existing = parseAppUpdate(await t.core?.invoke<unknown>('get_app_update'));
    if (existing) publishAppUpdate(existing);
  } catch {
    /* shell without the commands (older build) — stay silent */
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
  const core = tauri()?.core;
  if (!core) return null;
  try {
    return (await core.invoke<string | null>('install_app_update')) ?? null;
  } catch (e) {
    // The handoff flows (installer spawn / AppImage relaunch) tear the webview down — a torn IPC
    // is not an error. String rejections from the shell are real failures worth surfacing.
    if (typeof e === 'string' && e) throw new Error(e);
    return null;
  }
}

/** Persist "skip this version" shell-side and clear the pending update locally. */
export async function skipAppUpdate(): Promise<void> {
  publishAppUpdate(null);
  if (!isNativeShell()) return;
  try {
    await tauri()?.core?.invoke('skip_app_update');
  } catch {
    /* worst case: offered again next launch */
  }
}
