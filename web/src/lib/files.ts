// input:  workspace/commission paths, authenticated HTTP config, and typed native download capabilities
// output: URL builders, blob fetch, download, clipboard, open, and reveal helpers
// pos:    Cross-runtime file transport for chat cards and native download-complete actions
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { apiBase, authHeaders, isNativeShell, isMobileShell } from './desktop-config';
import { hasNativeCapability, safeInvoke, type NativeInvokeResult } from './native-bridge';

const DOWNLOAD_PATH = '/api/files/download';
const COMMISSION_ASSET_PATH = '/api/commissions/asset';

// A plain browser download is a no-op inside native WebViews, so shell modes use native commands.
// The canonical bridge keeps missing/older shell capabilities observable without touching globals.

/** Build the download URL for a UI-relative `workspace/…` path. `disposition=inline` for preview. */
export function fileDownloadUrl(relPath: string, disposition: 'inline' | 'attachment' = 'attachment'): string {
  const qs = new URLSearchParams({ path: relPath, disposition });
  return `${apiBase()}${DOWNLOAD_PATH}?${qs.toString()}`;
}

/** Build the URL for a commission asset. `relPath` is project-root relative and must stay inside
 *  `commissions/` — the server enforces that; this only builds the query. */
export function commissionAssetUrl(
  projectId: string,
  relPath: string,
  disposition: 'inline' | 'attachment' = 'inline',
): string {
  const qs = new URLSearchParams({ projectId, path: relPath, disposition });
  return `${apiBase()}${COMMISSION_ASSET_PATH}?${qs.toString()}`;
}

/** Fetch a commission asset's bytes (authenticated) and return an object URL. Caller revokes it. */
export async function fetchCommissionAssetObjectUrl(
  projectId: string,
  relPath: string,
): Promise<string> {
  const res = await fetch(commissionAssetUrl(projectId, relPath, 'inline'), { headers: authHeaders() });
  if (!res.ok) throw new Error(`commission asset failed: ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

/** Fetch a workspace file's bytes (authenticated) and return an object URL. Caller revokes it. */
export async function fetchFileObjectUrl(relPath: string, disposition: 'inline' | 'attachment' = 'inline'): Promise<string> {
  const res = await fetch(fileDownloadUrl(relPath, disposition), { headers: authHeaders() });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/** Result of a download. `savedPath` is the absolute on-disk path in the native shell (returned by
 *  `save_download`); it is undefined in the browser, where the download is handed to the browser's
 *  own download manager and the final location is not observable to the page. */
export interface DownloadResult {
  savedPath?: string;
}

/**
 * Save a workspace file to disk. A plain browser `<a download>` / `window.open(blob)` is a no-op
 * inside the Tauri WebView, so the native shell routes downloads through native commands:
 *   - Android (mobile shell): hand the authenticated file URL to the system DownloadManager
 *     (`plugin:cortex-download|download`), which saves into the PUBLIC Downloads folder and raises
 *     the native "download complete" notification. No location is returned (the OS notification is
 *     the feedback), so `savedPath` is undefined.
 *   - Desktop: fetch the bytes and hand them to `save_download`, which writes them to the OS
 *     download dir and returns the saved absolute path.
 *   - Browser / ui-http: the normal `<a download>`.
 */
function throwNativeFailure(result: NativeInvokeResult<unknown>): void {
  if (!result.ok && result.reason === 'failed') throw result.error;
}

async function nativeDownload(relPath: string, name: string): Promise<DownloadResult | null> {
  if (isMobileShell()) {
    const result = await safeInvoke('plugin:cortex-download|download', {
      url: fileDownloadUrl(relPath, 'attachment'),
      fileName: name,
      token: authHeaders()['x-cortex-token'],
    });
    throwNativeFailure(result);
    return result.ok ? {} : null;
  }
  const res = await fetch(fileDownloadUrl(relPath, 'attachment'), { headers: authHeaders() });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const bytes = Array.from(new Uint8Array(await res.arrayBuffer()));
  const result = await safeInvoke('save_download', { name, bytes });
  throwNativeFailure(result);
  return result.ok ? { savedPath: result.value } : null;
}

function browserDownload(objUrl: string, name: string): void {
  const anchor = document.createElement('a');
  anchor.href = objUrl;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objUrl), 10_000);
}

export async function downloadFile(relPath: string, fileName?: string): Promise<DownloadResult> {
  const name = fileName ?? relPath.split('/').pop() ?? 'download';
  if (isNativeShell() && hasNativeCapability('invoke')) {
    const downloaded = await nativeDownload(relPath, name);
    if (downloaded) return downloaded;
  }
  const objUrl = await fetchFileObjectUrl(relPath, 'attachment');
  browserDownload(objUrl, name);
  return {};
}

/** Copy a file's path to the clipboard (hover action). */
export async function copyFilePath(relPath: string): Promise<void> {
  try { await navigator.clipboard.writeText(relPath); } catch { /* clipboard blocked — no-op */ }
}

/**
 * Open a saved file with the OS default application (desktop download-complete toast "Open file"
 * action). Native shell only — invokes the `open_path` Tauri command with the absolute path that
 * `save_download` returned. A no-op off-shell (a plain browser cannot open a local file path). */
export async function openPath(absPath: string): Promise<void> {
  if (!isNativeShell()) return;
  const result = await safeInvoke('open_path', { path: absPath });
  throwNativeFailure(result);
}

/**
 * Reveal a saved file in the OS file manager — opens its containing folder, selecting the file where
 * the platform supports it (desktop toast "Open folder" action). Native shell only — invokes the
 * `reveal_path` Tauri command. A no-op off-shell. */
export async function revealPath(absPath: string): Promise<void> {
  if (!isNativeShell()) return;
  const result = await safeInvoke('reveal_path', { path: absPath });
  throwNativeFailure(result);
}
