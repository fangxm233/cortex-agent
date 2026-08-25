// input:  a docked WebItem, the app/API origins, the port forward and the pinned-preview dock
// output: the browser pane body — address bar, navigation, viewport presets and the frame
// pos:    desktop browser pane; all pure model logic lives in browser-target.ts
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useEffect, useMemo, useRef, useState } from 'react';
import { apiBase } from '@/lib/desktop-config';
import { openExternalUrl } from '@/lib/external-navigation';
import { usePinnedPreview } from '@/features/media/PinnedPreviewProvider';
import { canForward, listRemotePorts, startForward, type ListeningPort } from './forward';
import {
  EMPTY_HISTORY,
  VIEWPORT_PRESETS,
  WEB_SANDBOX,
  FRAME_REFUSED_HINT,
  frameRefusedEmbedding,
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
  /** Set when a load event fires but nothing was actually displayed — see frameRefusedEmbedding. */
  const [refused, setRefused] = useState(false);
  const [portsOpen, setPortsOpen] = useState(false);
  const [ports, setPorts] = useState<ListeningPort[] | null>(null);
  const [portsError, setPortsError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  const url = currentUrl(history);

  // The flag describes ONE frame instance; a new url or a reload must start from "unknown" again.
  useEffect(() => { setRefused(false); }, [url, reloadNonce]);

  const onFrameLoad = (): void => {
    let documentReachable = false;
    try {
      documentReachable = !!frameRef.current?.contentDocument;
    } catch {
      // A SecurityError means a real cross-origin document is in there — the load succeeded.
      documentReachable = false;
    }
    setRefused(frameRefusedEmbedding({ loaded: true, documentReachable }));
  };

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

  // A server-side port becomes previewable by forwarding it to a real local port first; without
  // the native shell (browser mode) the loopback address only resolves when the UI is being viewed
  // on the server itself, which is exactly what it then means.
  const openPort = async (port: number): Promise<void> => {
    setPortsOpen(false);
    try {
      const url = canForward() ? (await startForward(port)).url : `http://127.0.0.1:${port}/`;
      navigate(url);
    } catch (e) {
      setRejected((e as Error).message);
    }
  };

  const togglePorts = (): void => {
    const next = !portsOpen;
    setPortsOpen(next);
    if (!next) return;
    setPortsError(null);
    listRemotePorts()
      .then(setPorts)
      .catch((e: Error) => setPortsError(e.message));
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
        <button
          type="button"
          title="Ports listening on the server"
          onClick={togglePorts}
          style={{
            height: 26,
            flex: 'none',
            padding: '0 8px',
            borderRadius: 7,
            border: portsOpen ? '1.5px solid var(--proto-accent)' : '1px solid var(--proto-line)',
            background: portsOpen ? 'var(--proto-accent-bg)' : 'var(--proto-card)',
            color: portsOpen ? 'var(--proto-accent)' : 'var(--proto-muted)',
            font: `600 10.5px ${MONO}`,
            cursor: 'pointer',
          }}
        >
          Ports
        </button>
        <NavBtn title="Open in system browser" disabled={url === null} onClick={() => { if (url) void openExternalUrl(url); }}>↗</NavBtn>
      </div>

      {portsOpen && (
        <div style={{ flex: 'none', maxHeight: 190, overflow: 'auto', borderBottom: '1px solid var(--proto-line)', background: 'var(--proto-card)' }}>
          {portsError ? (
            <PortsNote>{portsError}</PortsNote>
          ) : ports === null ? (
            <PortsNote>Loading…</PortsNote>
          ) : ports.length === 0 ? (
            <PortsNote>Nothing is listening on the server’s loopback.</PortsNote>
          ) : (
            ports.map((p) => (
              <button
                key={p.port}
                type="button"
                onClick={() => void openPort(p.port)}
                style={{
                  display: 'flex',
                  width: '100%',
                  alignItems: 'center',
                  gap: 10,
                  padding: '6px 12px',
                  border: 'none',
                  borderBottom: '1px solid var(--proto-line)',
                  background: 'transparent',
                  color: 'var(--proto-ink)',
                  font: `500 11px ${MONO}`,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span style={{ fontWeight: 600 }}>{p.port}</span>
                <span style={{ color: 'var(--proto-muted-2)' }}>{p.process ?? '—'}</span>
                <span style={{ marginLeft: 'auto', color: 'var(--proto-faint)' }}>{p.address}</span>
              </button>
            ))
          )}
          {!canForward() && (
            <PortsNote>Forwarding needs the desktop app — these open as plain localhost here.</PortsNote>
          )}
        </div>
      )}

      {refused && url !== null && (
        <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--proto-line)', background: 'var(--proto-gray)', color: 'var(--proto-muted-2)', font: `500 10.5px ${MONO}` }}>
          <span>{FRAME_REFUSED_HINT}</span>
          <button
            type="button"
            data-action="open-external"
            onClick={() => void openExternalUrl(url)}
            style={{ border: '1px solid var(--proto-line)', borderRadius: 6, background: 'transparent', color: 'var(--proto-accent)', font: `600 10.5px ${MONO}`, padding: '1px 7px', cursor: 'pointer' }}
          >
            ↗
          </button>
        </div>
      )}

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
            ref={frameRef}
            onLoad={onFrameLoad}
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

function PortsNote({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ padding: '8px 12px', color: 'var(--proto-muted-2)', font: `500 10.5px ${MONO}` }}>{children}</div>
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
