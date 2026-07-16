// Frontend hot-update (OTA) bridge — the single seam the hot-update prompt talks to the native shell.
//
// The Tauri shell (desktop + Android) downloads a newer SPA bundle in the background and stages it for
// the next launch (see desktop/src-tauri/src/ota.rs). When a bundle is staged it emits the
// `frontend-update-staged` event to the webview; applying the update relaunches (desktop) or exits
// (Android) the app so startup `promote_staged()` swaps the new version in.
//
// This module is off-shell-safe: in a plain browser / ui-http (no Tauri shell) every function is a
// no-op, so the SPA still builds + runs there and the hot-update prompt simply never appears (design:
// the prompt is APP-only). Accessed via the global `window.__TAURI__` (the shell is built with
// `withGlobalTauri: true`, same as the init_script), so no extra `@tauri-apps/api` dependency is added.
import { isNativeShell } from '@/lib/desktop-config';

/** A frontend update downloaded + staged for the next launch (payload of `frontend-update-staged`). */
export interface StagedUpdate {
  /** Content-addressed id of the newly staged version (a hash, not a semver). */
  version: string;
  /** The version it replaces (staged applies on next launch). Absent on first install. */
  fromVersion?: string;
  /** Zip byte length; 0/undefined when unknown (e.g. reconstructed from disk without the manifest). */
  size?: number;
}

export const FRONTEND_UPDATE_STAGED_EVENT = 'frontend-update-staged';

// ─── Pure formatting helpers (DOM-free, unit-tested) ────────────────────────

/** Short form of a content-hash version for display: first 8 chars. Honest — never a fabricated semver. */
export function shortVersion(version: string): string {
  return version.slice(0, 8);
}

/** Version line: `<from8> → <to8>` when replacing a known version, else just `<to8>`. */
export function versionTransitionLabel(update: StagedUpdate): string {
  const to = shortVersion(update.version);
  const from = update.fromVersion ? shortVersion(update.fromVersion) : '';
  return from && from !== to ? `${from} → ${to}` : to;
}

/** Human-readable byte size ("8.4 MB" / "512 KB" / "900 B"). Returns null for 0 / missing (→ omit). */
export function formatUpdateSize(bytes: number | undefined): string | null {
  if (!bytes || bytes <= 0) return null;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** The full mono meta line under the title: `<versions> · <size> · 已下载` (size segment omitted when
 *  unknown). Matches scheme.dc.html 21a / scheme-mobile 3a ("v… → v… · 8.4 MB · 已下载"). */
export function updateSummaryLine(update: StagedUpdate): string {
  const size = formatUpdateSize(update.size);
  const parts = [versionTransitionLabel(update)];
  if (size) parts.push(size);
  parts.push('已下载');
  return parts.join(' · ');
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

/** Coerce an unknown event payload into a StagedUpdate, or null if it is not shaped like one. */
export function parseStagedUpdate(payload: unknown): StagedUpdate | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.version !== 'string' || !p.version) return null;
  return {
    version: p.version,
    fromVersion: typeof p.fromVersion === 'string' && p.fromVersion ? p.fromVersion : undefined,
    size: typeof p.size === 'number' ? p.size : undefined,
  };
}

/** Subscribe to the staged-update event. Returns an unsubscribe fn; a no-op off-shell (browser). */
export async function onFrontendUpdateStaged(
  cb: (update: StagedUpdate) => void,
): Promise<() => void> {
  if (!isNativeShell()) return () => {};
  const ev = tauri()?.event;
  if (!ev) return () => {};
  try {
    const unlisten = await ev.listen(FRONTEND_UPDATE_STAGED_EVENT, (e) => {
      const update = parseStagedUpdate(e.payload);
      if (update) cb(update);
    });
    return () => {
      try {
        unlisten();
      } catch {
        /* already torn down */
      }
    };
  } catch {
    return () => {};
  }
}

/** Backstop for a missed event: query the shell for a currently-staged update. Null off-shell / none. */
export async function getStagedUpdate(): Promise<StagedUpdate | null> {
  if (!isNativeShell()) return null;
  const core = tauri()?.core;
  if (!core) return null;
  try {
    const res = await core.invoke<unknown>('get_staged_update');
    return parseStagedUpdate(res);
  } catch {
    return null;
  }
}

/** Apply the staged update — relaunches (desktop) or exits (Android) the app. No-op off-shell. */
export async function applyFrontendUpdate(): Promise<void> {
  if (!isNativeShell()) return;
  const core = tauri()?.core;
  if (!core) return;
  try {
    await core.invoke('apply_frontend_update');
  } catch {
    /* restart/exit may tear the webview down before the promise resolves — ignore */
  }
}
