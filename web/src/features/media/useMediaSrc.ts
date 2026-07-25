import { useEffect, useState } from 'react';
import { fetchFileObjectUrl } from '@/lib/files';

// Resolve a media item's displayable source, shared by the full-screen `Lightbox` and the docked
// `PinnedPreviewPanel` (both show the SAME image/video at full size, so they resolve it the same
// way): a local composer preview already carries an object `url`; a workspace `path` is fetched with
// auth into one (revoked on close / change). Unlike `useWorkspaceObjectUrl` (thumbnails, which just
// render nothing on error) this reports `failed`, so a full-size viewer can say so instead of
// showing an endless "Loading…".

export interface MediaSrc {
  src: string | null;
  failed: boolean;
}

export function useMediaSrc(item: { url?: string; path?: string }): MediaSrc {
  const [src, setSrc] = useState<string | null>(item.url ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (item.url) {
      setSrc(item.url);
      setFailed(false);
      return;
    }
    if (!item.path) return;
    let alive = true;
    let created: string | null = null;
    setSrc(null);
    setFailed(false);
    fetchFileObjectUrl(item.path, 'inline')
      .then((u) => {
        if (alive) {
          created = u;
          setSrc(u);
        } else {
          URL.revokeObjectURL(u);
        }
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [item.path, item.url]);

  return { src, failed };
}
