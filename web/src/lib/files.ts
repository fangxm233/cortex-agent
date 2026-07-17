// input:  a UI-relative `workspace/…` file path + optional desktop RemoteConfig
// output: URL builder + authenticated blob fetch + download/open helpers for workspace files
// pos:    file transport for the chat file cards (15a user uploads + 20a agent-sent files). The
//         ui-http server serves files at /api/files/download behind the same dual-path auth as tRPC.
//         A plain <img src>/<a href> cannot set x-cortex-token, so previews/downloads fetch the bytes
//         with the right auth (desktop: token header; browser/ui-http: same-origin proxy/Access) and
//         wrap them in an object URL — correct in every mode.

import { apiBase, authHeaders } from './desktop-config';

const DOWNLOAD_PATH = '/api/files/download';

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

/** Trigger a browser download of a workspace file, working in browser and desktop modes alike. */
export async function downloadFile(relPath: string, fileName?: string): Promise<void> {
  const objUrl = await fetchFileObjectUrl(relPath, 'attachment');
  const a = document.createElement('a');
  a.href = objUrl;
  a.download = fileName ?? relPath.split('/').pop() ?? 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objUrl), 10_000);
}

/** Open a workspace file inline in a new tab (image / PDF preview). */
export async function openFile(relPath: string): Promise<void> {
  const objUrl = await fetchFileObjectUrl(relPath, 'inline');
  window.open(objUrl, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(objUrl), 60_000);
}

/** Copy a file's path to the clipboard (hover action). */
export async function copyFilePath(relPath: string): Promise<void> {
  try { await navigator.clipboard.writeText(relPath); } catch { /* clipboard blocked — no-op */ }
}
