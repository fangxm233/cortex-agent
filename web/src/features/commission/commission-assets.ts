// input:  a project id and a `commissions/`-relative asset path
// output: the authenticated asset URL, and its bytes as an object URL
// pos:    Commission-specific half of the file transport. The generic workspace download /
//         open / reveal helpers stay in lib/files.ts; this knows what a commission asset is.
import { apiBase, authHeaders } from '@/lib/desktop-config';

const COMMISSION_ASSET_PATH = '/api/commissions/asset';

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
