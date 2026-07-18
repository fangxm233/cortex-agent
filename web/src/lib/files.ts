// input:  a UI-relative `workspace/…` file path + optional desktop RemoteConfig
// output: URL builder + authenticated blob fetch + download/open helpers for workspace files
// pos:    file transport for the chat file cards (15a user uploads + 20a agent-sent files). The
//         ui-http server serves files at /api/files/download behind the same dual-path auth as tRPC.
//         A plain <img src>/<a href> cannot set x-cortex-token, so previews/downloads fetch the bytes
//         with the right auth (desktop: token header; browser/ui-http: same-origin proxy/Access) and
//         wrap them in an object URL — correct in every mode.

import { apiBase, authHeaders, isNativeShell } from './desktop-config';

const DOWNLOAD_PATH = '/api/files/download';

// Native-shell (Tauri desktop/Android) IPC seam. A plain browser `<a download>` / window.open(blob)
// is a NO-OP inside the WebView, so in the native shell downloads go through the `save_download`
// command instead. Accessed via the global `window.__TAURI__` (the shell is built with
// `withGlobalTauri: true`), so no `@tauri-apps/api` dependency is added.
interface TauriGlobal {
  core?: { invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
}
function tauriCore(): TauriGlobal['core'] | undefined {
  return (globalThis as unknown as { __TAURI__?: TauriGlobal }).__TAURI__?.core;
}

/** Build the download URL for a UI-relative `workspace/…` path. `disposition=inline` for preview. */
export function fileDownloadUrl(relPath: string, disposition: 'inline' | 'attachment' = 'attachment'): string {
  const qs = new URLSearchParams({ path: relPath, disposition });
  return `${apiBase()}${DOWNLOAD_PATH}?${qs.toString()}`;
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
 * Save a workspace file to disk. In a plain browser / ui-http this triggers the normal `<a download>`.
 * In the native Tauri shell (desktop + Android) that anchor is a no-op, so the bytes are fetched and
 * handed to the `save_download` command, which writes them to the OS download dir (desktop) or the
 * app's downloads dir + a notification (Android) and returns the saved absolute path.
 */
export async function downloadFile(relPath: string, fileName?: string): Promise<DownloadResult> {
  const name = fileName ?? relPath.split('/').pop() ?? 'download';

  const core = isNativeShell() ? tauriCore() : undefined;
  if (core) {
    const res = await fetch(fileDownloadUrl(relPath, 'attachment'), { headers: authHeaders() });
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const bytes = Array.from(new Uint8Array(await res.arrayBuffer()));
    const savedPath = await core.invoke<string>('save_download', { name, bytes });
    return { savedPath };
  }

  const objUrl = await fetchFileObjectUrl(relPath, 'attachment');
  const a = document.createElement('a');
  a.href = objUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objUrl), 10_000);
  return {};
}

/** Copy a file's path to the clipboard (hover action). */
export async function copyFilePath(relPath: string): Promise<void> {
  try { await navigator.clipboard.writeText(relPath); } catch { /* clipboard blocked — no-op */ }
}
