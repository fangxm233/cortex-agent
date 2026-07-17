import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { fetchFileObjectUrl, downloadFile } from '@/lib/files';
import type { MediaKind } from './media-kind';

// Shared full-screen media lightbox (modal) — the single previewer for every image/video surface on
// web AND mobile: the composer's attachment preview, a sent user message's photo/video, and an
// agent-sent image/video. Opening a preview NEVER opens a new browser tab; it raises this in-app modal
// (scrim + centered media + close/download). One instance is mounted per shell (AppShell / MobileShell)
// and opened from anywhere via `useMediaViewer().openMedia(item)`.

export interface MediaItem {
  kind: MediaKind;
  name: string;
  /** Workspace-relative `workspace/…` path → authenticated blob fetch (sent messages / agent files). */
  path?: string;
  /** A ready object URL (a local composer File preview) — used directly, not fetched. */
  url?: string;
}

interface MediaViewerContextValue {
  openMedia: (item: MediaItem) => void;
  close: () => void;
}

// Default to a no-op so presentational components (rebuilt 1:1, unit-tested in isolation) render
// without a provider in scope; the real open/close is supplied by MediaViewerProvider in each shell.
const MediaViewerContext = createContext<MediaViewerContextValue>({ openMedia: () => {}, close: () => {} });

const mono = "'IBM Plex Mono',monospace";

export function Lightbox({ item, onClose }: { item: MediaItem; onClose: () => void }): JSX.Element {
  // Resolve the source: a local composer preview already has an object URL; a workspace file is
  // fetched with auth into one (revoked on close / change).
  const [src, setSrc] = useState<string | null>(item.url ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (item.url) {
      setSrc(item.url);
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

  // Esc closes; lock body scroll while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const onDownload = (): void => {
    if (item.path) {
      void downloadFile(item.path, item.name);
    } else if (item.url) {
      const a = document.createElement('a');
      a.href = item.url;
      a.download = item.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={item.name}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 4000,
        background: 'rgba(10,12,16,.88)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'max(24px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom))',
        boxSizing: 'border-box',
        animation: 'cxfade .18s ease both',
      }}
    >
      {/* Top action bar — download + close. Stops propagation so bar clicks don't close the modal. */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: 'max(14px, env(safe-area-inset-top))',
          right: 14,
          display: 'flex',
          gap: 10,
          zIndex: 2,
        }}
      >
        <span
          role="button"
          title="Download"
          onClick={onDownload}
          style={{
            width: 38,
            height: 38,
            borderRadius: 10,
            background: 'rgba(255,255,255,.12)',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 16,
            cursor: 'pointer',
          }}
        >
          ↓
        </span>
        <span
          role="button"
          title="Close"
          onClick={onClose}
          style={{
            width: 38,
            height: 38,
            borderRadius: 10,
            background: 'rgba(255,255,255,.12)',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 18,
            cursor: 'pointer',
          }}
        >
          ×
        </span>
      </div>

      {/* Media stage — click-through inner wrapper stops close on the media itself. */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '94vw', maxHeight: '84vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        {failed ? (
          <div style={{ color: '#B6BDC9', font: `500 12px ${mono}` }}>Failed to load {item.name}</div>
        ) : !src ? (
          <div style={{ color: '#8A93A2', font: `500 12px ${mono}` }}>Loading…</div>
        ) : item.kind === 'video' ? (
          <video
            src={src}
            controls
            autoPlay
            playsInline
            style={{ maxWidth: '94vw', maxHeight: '84vh', borderRadius: 10, background: '#000' }}
          />
        ) : (
          <img
            src={src}
            alt={item.name}
            style={{ maxWidth: '94vw', maxHeight: '84vh', objectFit: 'contain', borderRadius: 10 }}
          />
        )}
      </div>

      {/* Filename caption */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ position: 'absolute', bottom: 'max(16px, env(safe-area-inset-bottom))', left: 0, right: 0, textAlign: 'center', color: 'rgba(255,255,255,.72)', font: `500 11px ${mono}`, padding: '0 20px', pointerEvents: 'none' }}
      >
        {item.name}
      </div>
    </div>
  );
}

export function MediaViewerProvider({ children }: { children: ReactNode }): JSX.Element {
  const [item, setItem] = useState<MediaItem | null>(null);
  const openMedia = useCallback((next: MediaItem) => setItem(next), []);
  const close = useCallback(() => setItem(null), []);
  const value = useMemo(() => ({ openMedia, close }), [openMedia, close]);
  return (
    <MediaViewerContext.Provider value={value}>
      {children}
      {item && <Lightbox item={item} onClose={close} />}
    </MediaViewerContext.Provider>
  );
}

export function useMediaViewer(): MediaViewerContextValue {
  return useContext(MediaViewerContext);
}
