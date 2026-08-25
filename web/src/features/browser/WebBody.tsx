// input:  a docked WebItem, the app/API origins and the pinned-preview dock
// output: the browser pane body — address bar, navigation, viewport presets and the frame
// pos:    desktop browser pane; all pure model logic lives in browser-target.ts
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useEffect, useMemo, useRef, useState } from 'react';
import { apiBase } from '@/lib/desktop-config';
import { openExternalUrl } from '@/lib/external-navigation';
import { usePinnedPreview } from '@/features/media/PinnedPreviewProvider';
import {
  EMPTY_HISTORY,
  VIEWPORT_PRESETS,
  WEB_SANDBOX,
  canGoBack,
  canGoForward,
  currentUrl,
  goBack,
  goForward,
  normalizeBrowserUrl,
  previewOriginConflict,
  pushHistory,
  webItem,
  type BrowserHistory,
  type WebItem,
} from './browser-target';

const MONO = "'IBM Plex Mono',monospace";

const EMPTY_HINT = 'Enter a port (5173) or a URL. Remote dev servers appear here once forwarded.';

/**
 * The docked browser body.
 *
 * Navigation is OUR history stack re-pointing the frame's `src`: the frame is cross-origin, so its
 * internal history is unreachable from here. `reloadNonce` is part of the frame key so a reload
 * remounts the frame even when the URL is unchanged.
 */
export function WebBody({ item }: { item: WebItem }): JSX.Element {
  const { show } = usePinnedPreview();
  const [history, setHistory] = useState<BrowserHistory>(() =>
    item.url === '' ? EMPTY_HISTORY : pushHistory(EMPTY_HISTORY, item.url),
  );
  const [draft, setDraft] = useState(item.url);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [viewport, setViewport] = useState(VIEWPORT_PRESETS[0]);
  const [rejected, setRejected] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const url = currentUrl(history);

  // An item swapped in from outside (a future agent push, or a second open) navigates the pane.
  useEffect(() => {
    if (item.url !== '' && item.url !== currentUrl(history)) {
      setHistory((h) => pushHistory(h, item.url));
      setDraft(item.url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.url]);

  useEffect(() => {
    setDraft(url ?? '');
  }, [url]);

  useEffect(() => {
    if (url === null) inputRef.current?.focus();
  }, [url]);

  // The app page and the API are the two origins a framed page must never share (browser-target.ts).
  const forbiddenOrigins = useMemo(
    () => [typeof window === 'undefined' ? '' : window.location.origin, apiBase()],
    [],
  );

  const navigate = (raw: string): void => {
    const next = normalizeBrowserUrl(raw);
    if (next === null) {
      setRejected('Not a previewable address — use http(s), a host:port, or a bare port.');
      return;
    }
    if (previewOriginConflict(next, forbiddenOrigins)) {
      setRejected('Refused: that is this app’s own origin. Previewing it would hand the page your session.');
      return;
    }
    setRejected(null);
    setHistory((h) => pushHistory(h, next));
    show(webItem(next));
  };

  const step = (dir: 'back' | 'forward'): void => {
    setHistory((h) => {
      const next = dir === 'back' ? goBack(h) : goForward(h);
      const target = currentUrl(next);
      if (target) show(webItem(target));
      return next;
    });
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Toolbar */}
      <div
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 8px',
          borderBottom: '1px solid var(--proto-line)',
          background: 'var(--proto-card)',
        }}
      >
        <NavBtn title="Back" disabled={!canGoBack(history)} onClick={() => step('back')}>‹</NavBtn>
        <NavBtn title="Forward" disabled={!canGoForward(history)} onClick={() => step('forward')}>›</NavBtn>
        <NavBtn title="Reload" disabled={url === null} onClick={() => setReloadNonce((n) => n + 1)}>⟳</NavBtn>
        <input
          ref={inputRef}
          value={draft}
          spellCheck={false}
          placeholder="5173 or http://host:port"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') navigate(draft);
            if (e.key === 'Escape') setDraft(url ?? '');
          }}
          style={{
            flex: 1,
            minWidth: 0,
            height: 26,
            padding: '0 8px',
            borderRadius: 7,
            border: '1px solid var(--proto-line)',
            background: 'var(--proto-gray)',
            color: 'var(--proto-ink)',
            font: `500 11px ${MONO}`,
            outline: 'none',
          }}
        />
        <select
          title="Viewport width"
          value={viewport.id}
          onChange={(e) => setViewport(VIEWPORT_PRESETS.find((p) => p.id === e.target.value) ?? VIEWPORT_PRESETS[0])}
          style={{
            height: 26,
            borderRadius: 7,
            border: '1px solid var(--proto-line)',
            background: 'var(--proto-card)',
            color: 'var(--proto-muted)',
            font: `500 10.5px ${MONO}`,
            cursor: 'pointer',
          }}
        >
          {VIEWPORT_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        <NavBtn title="Open in system browser" disabled={url === null} onClick={() => { if (url) void openExternalUrl(url); }}>↗</NavBtn>
      </div>

      {rejected && (
        <div style={{ flex: 'none', padding: '6px 10px', borderBottom: '1px solid var(--proto-line)', background: 'var(--proto-gray)', color: 'var(--proto-danger, #c0392b)', font: `500 10.5px ${MONO}` }}>
          {rejected}
        </div>
      )}

      {/* Frame */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--proto-gray)', display: 'flex', justifyContent: 'center' }}>
        {url === null ? (
          <div style={{ margin: 'auto', padding: '32px 24px', textAlign: 'center', color: 'var(--proto-muted-2)', font: `500 11.5px ${MONO}`, maxWidth: 320 }}>
            {EMPTY_HINT}
          </div>
        ) : (
          <iframe
            key={`${url}#${reloadNonce}`}
            src={url}
            title={item.name}
            sandbox={WEB_SANDBOX}
            style={{
              border: 'none',
              width: viewport.width ?? '100%',
              flex: viewport.width ? 'none' : 1,
              minHeight: '100%',
              background: 'var(--proto-card)',
            }}
          />
        )}
      </div>
    </div>
  );
}

function NavBtn({ children, title, disabled, onClick }: {
  children: React.ReactNode;
  title: string;
  disabled?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        width: 26,
        height: 26,
        flex: 'none',
        borderRadius: 7,
        border: '1px solid var(--proto-line)',
        background: 'var(--proto-card)',
        color: disabled ? 'var(--proto-faint)' : 'var(--proto-muted)',
        font: `500 13px ${MONO}`,
        cursor: disabled ? 'default' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}
