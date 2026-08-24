// input:  a view document item, authenticated file access, and a render mode
// output: the sandboxed frame that renders an agent-authored HTML view
// pos:    the single renderer behind the inline card, the doc modal and the docked pane
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useEffect, useMemo, useRef, useState } from 'react';
import { fileDownloadUrl } from '@/lib/files';
import { authHeaders } from '@/lib/desktop-config';
import { useTheme } from '@/theme';
import type { DocItem } from './DocViewer';
import { useViewHeight } from './useViewHeight';
import {
  VIEW_SANDBOX, VIEW_HEIGHT_DEFAULT, VIEW_HEIGHT_MAX, VIEW_HEIGHT_MAX_EXPANDED, wrapViewDocument,
} from './html-sandbox';

// Renders `AttachmentMeta.type === 'view'` documents. The bytes are fetched HERE, by the parent,
// with the auth header — the frame itself can never reach the download endpoint (see html-sandbox.ts
// for why `src=` is not an option in either the browser or the desktop shell) — and are handed over
// as `srcdoc` inside a frame sandboxed to `allow-scripts` only.

/** Matches DocViewer's own text ceiling and the server's view file cap. */
const VIEW_SIZE_LIMIT = 2 * 1024 * 1024;

const mono = "'IBM Plex Mono',monospace";

type LoadState = 'loading' | 'ok' | 'toolarge' | 'failed';

export interface HtmlBodyProps {
  item: DocItem;
  /**
   * `inline` grows the frame to the document's reported height, bounded by the card ceiling.
   * `expanded` (modal / docked pane) fills its container and lets the document scroll itself.
   */
  mode?: 'inline' | 'expanded';
  /** First-paint height for `inline` before the document reports its own. */
  initialHeight?: number;
}

export function HtmlBody({ item, mode = 'expanded', initialHeight = VIEW_HEIGHT_DEFAULT }: HtmlBodyProps): JSX.Element {
  const theme = useTheme();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [html, setHtml] = useState<string | null>(null);

  // Effective theme comes off the root attribute the theme layer already maintains; re-read it
  // whenever the preference changes so a view's form controls and scrollbars follow the app.
  // The frame is its own document, so the app's CSS variables do not reach it — the resolved
  // `--proto-ink` value is carried across explicitly rather than referenced.
  const { effectiveTheme, ink } = useMemo(() => {
    if (typeof document === 'undefined') return { effectiveTheme: 'light' as const, ink: undefined };
    const root = document.documentElement;
    return {
      effectiveTheme: root.getAttribute('data-theme') === 'dark' ? ('dark' as const) : ('light' as const),
      ink: getComputedStyle(root).getPropertyValue('--proto-ink').trim() || undefined,
    };
  }, [theme]);

  useEffect(() => {
    let alive = true;
    setState('loading');
    setHtml(null);
    (async () => {
      const res = await fetch(fileDownloadUrl(item.path, 'inline'), { headers: authHeaders() });
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      const blob = await res.blob();
      if (blob.size > VIEW_SIZE_LIMIT) {
        if (alive) setState('toolarge');
        return;
      }
      const text = await blob.text();
      if (alive) { setHtml(text); setState('ok'); }
    })().catch(() => { if (alive) setState('failed'); });
    return () => { alive = false; };
  }, [item.path]);

  const srcDoc = useMemo(
    () => (html === null ? null : wrapViewDocument(html, { theme: effectiveTheme, ink })),
    [html, effectiveTheme, ink],
  );

  const inline = mode === 'inline';
  const reported = useViewHeight(frameRef, {
    initial: initialHeight,
    max: inline ? VIEW_HEIGHT_MAX : VIEW_HEIGHT_MAX_EXPANDED,
    enabled: inline,
  });

  if (state !== 'ok' || srcDoc === null) {
    return (
      <Placeholder height={inline ? initialHeight : undefined}>
        {state === 'loading' && 'Loading view…'}
        {state === 'failed' && `Failed to load ${item.name}`}
        {state === 'toolarge' && 'View too large to render — download to open it.'}
      </Placeholder>
    );
  }

  return (
    <iframe
      ref={frameRef}
      title={item.name}
      // The whole isolation boundary. Read html-sandbox.ts before touching this attribute.
      sandbox={VIEW_SANDBOX}
      srcDoc={srcDoc}
      referrerPolicy="no-referrer"
      loading="lazy"
      style={{
        display: 'block',
        width: '100%',
        height: inline ? reported : '100%',
        border: 0,
        background: 'transparent',
      }}
    />
  );
}

function Placeholder({ children, height }: { children: React.ReactNode; height?: number }): JSX.Element {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: height ?? '100%', minHeight: 88, padding: '20px',
        boxSizing: 'border-box', color: 'var(--proto-muted-2)', font: `500 11.5px ${mono}`,
      }}
    >
      {children}
    </div>
  );
}
