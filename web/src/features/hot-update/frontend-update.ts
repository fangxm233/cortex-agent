// input:  unknown native update payloads, typed bridge capabilities, and shared byte formatting
// output: parsed update state, display labels, subscriptions, and safe shell commands
// pos:    Off-shell-safe hot-update adapter using the canonical native bridge
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// Desktop and Android stage a bundle, emit `frontend-update-staged`, then relaunch/exit to promote it.
// Plain browsers remain safe no-ops through the guarded global Tauri seam.
import { isNativeShell } from '@/lib/desktop-config';
import { listenNativeEvent, safeInvoke } from '@/lib/native-bridge';
import { formatBytes } from '@/lib/format';

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
  const fractionDigits = bytes >= 1024 * 1024 ? 1 : 0;
  return formatBytes(bytes, { fractionDigits, maxUnit: 'MB' });
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
  return listenNativeEvent(FRONTEND_UPDATE_STAGED_EVENT, (payload) => {
    const update = parseStagedUpdate(payload);
    if (update) cb(update);
  });
}

/** Backstop for a missed event: query the shell for a currently-staged update. Null off-shell / none. */
export async function getStagedUpdate(): Promise<StagedUpdate | null> {
  if (!isNativeShell()) return null;
  const result = await safeInvoke('get_staged_update');
  return result.ok ? parseStagedUpdate(result.value) : null;
}

/** Apply the staged update — relaunches (desktop) or exits (Android) the app. No-op off-shell. */
export async function applyFrontendUpdate(): Promise<void> {
  if (!isNativeShell()) return;
  await safeInvoke('apply_frontend_update');
}
