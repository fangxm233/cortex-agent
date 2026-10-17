import { useEffect, useState } from 'react';
import { fetchFileObjectUrl } from '@/lib/files';

interface WorkspaceMediaUrl {
  url: string | null;
  failed: boolean;
}
const EMPTY: WorkspaceMediaUrl = { url: null, failed: false };

function loadWorkspaceUrl(path: string, report: (state: WorkspaceMediaUrl) => void): () => void {
  const controller = new AbortController();
  let alive = true;
  let created: string | null = null;
  fetchFileObjectUrl(path, 'inline', controller.signal)
    .then((url) => {
      if (!alive) { URL.revokeObjectURL(url); return; }
      created = url;
      report({ url, failed: false });
    })
    .catch(() => { if (alive) report({ url: null, failed: true }); });
  return () => {
    alive = false;
    controller.abort();
    if (created) URL.revokeObjectURL(created);
  };
}

export function useWorkspaceObjectUrlState(path: string | null | undefined): WorkspaceMediaUrl {
  const [state, setState] = useState<WorkspaceMediaUrl>(EMPTY);
  useEffect(() => {
    setState(EMPTY);
    if (path) return loadWorkspaceUrl(path, setState);
  }, [path]);
  return state;
}

// Authenticated workspace fetch; the object URL is revoked on path change or unmount.
export function useWorkspaceObjectUrl(path: string | null | undefined): string | null {
  return useWorkspaceObjectUrlState(path).url;
}
