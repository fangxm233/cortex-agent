import { useEffect, useState } from 'react';
import { fetchFileObjectUrl } from '@/lib/files';

// Fetch a workspace `path` (image / video) into an authenticated object URL for inline preview.
// A plain <img>/<video src> cannot set the x-cortex-token header, so previews go through the same
// authenticated blob fetch as downloads (lib/files) and are wrapped in an object URL — correct in
// browser/ui-http (proxy/Access) and desktop/remote (token header) modes alike. The URL is revoked
// on unmount / path change. Pass `enabled=false` to skip the fetch (e.g. non-previewable types).

export function useWorkspaceObjectUrl(path: string | null | undefined, enabled = true): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path || !enabled) {
      setUrl(null);
      return;
    }
    let alive = true;
    let created: string | null = null;
    fetchFileObjectUrl(path, 'inline')
      .then((u) => {
        if (alive) {
          created = u;
          setUrl(u);
        } else {
          URL.revokeObjectURL(u);
        }
      })
      .catch(() => {
        if (alive) setUrl(null);
      });
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [path, enabled]);
  return url;
}
