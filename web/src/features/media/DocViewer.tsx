import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fileDownloadUrl } from '@/lib/files';
import { useDownloadFile } from './useDownloadFile';
import { authHeaders } from '@/lib/desktop-config';
import { ChatMarkdown } from '@/features/workbench/ChatMarkdown';
import { isMarkdownName, type DocKind } from './doc-kind';
import { clampPage, pageAtScroll, parseJump, type PageBox } from './pdf-pager';

// Shared in-app document previewer — the single inline viewer for agent-sent (and user-uploaded)
// PDF + text files on web AND mobile. Opening a document NEVER opens a new browser tab (a no-op in the
// Tauri WebView); it raises this full-screen modal (scrim + rendered document + download/close).
// - text/markdown: fetched as text, rendered as Markdown (.md) or a monospace <pre>.
// - pdf: pdf.js renders each page to a <canvas> (reliable in webkit2gtk / Android System WebView, which
//   have NO built-in PDF viewer — an <iframe src=blob:pdf> would silently blank there).
// One instance is mounted per shell (AppShell / MobileShell) and opened via useDocViewer().openDoc(item).

const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024; // 2 MB — beyond this, prompt to download instead.
const mono = "'IBM Plex Mono',monospace";

export interface DocItem {
  kind: DocKind;
  name: string;
  /** Workspace-relative `workspace/…` path → authenticated fetch. */
  path: string;
  mimeType?: string;
}

interface DocViewerContextValue {
  openDoc: (item: DocItem) => void;
  close: () => void;
}

// Default to a no-op so presentational components render without a provider in scope (mirrors MediaViewer).
const DocViewerContext = createContext<DocViewerContextValue>({ openDoc: () => {}, close: () => {} });

/** Text/Markdown body — fetch the file's text (authenticated) and render it. */
function TextBody({ item }: { item: DocItem }): JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'toolarge' | 'failed'>('loading');

  useEffect(() => {
    let alive = true;
    setState('loading');
    setText(null);
    (async () => {
      const res = await fetch(fileDownloadUrl(item.path, 'inline'), { headers: authHeaders() });
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      const blob = await res.blob();
      if (blob.size > TEXT_PREVIEW_LIMIT) {
        if (alive) setState('toolarge');
        return;
      }
      const t = await blob.text();
      if (alive) { setText(t); setState('ok'); }
    })().catch(() => { if (alive) setState('failed'); });
    return () => { alive = false; };
  }, [item.path]);

  if (state === 'loading') return <Centered>Loading…</Centered>;
  if (state === 'failed') return <Centered failed>Failed to load {item.name}</Centered>;
  if (state === 'toolarge') return <Centered>File too large to preview — download to view.</Centered>;

  if (isMarkdownName(item.name)) {
    return (
      <div style={{ padding: '22px 26px', color: 'var(--proto-ink)', fontSize: 13.5, lineHeight: 1.6 }}>
        <ChatMarkdown text={text ?? ''} />
      </div>
    );
  }
  return (
    <pre
      style={{
        margin: 0,
        padding: '20px 22px',
        font: `500 12px/1.6 ${mono}`,
        color: 'var(--proto-ink)',
        whiteSpace: 'pre',
        overflowX: 'auto',
      }}
    >
      {text}
    </pre>
  );
}

/** PDF body — pdf.js renders each page to a canvas. Loads pdf.js lazily on first PDF open.
 *  A page pager (counter + prev/next + jump-to-page) tracks the page under the viewport center. */
function PdfBody({ item }: { item: DocItem }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef<HTMLDivElement[]>([]);
  const [state, setState] = useState<'loading' | 'ok' | 'failed'>('loading');
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    let alive = true;
    let cancelled = false;
    const container = containerRef.current;
    if (container) container.innerHTML = '';
    pagesRef.current = [];
    setState('loading');
    setNumPages(0);
    setCurrentPage(1);

    (async () => {
      const [{ getPdfjs }, res] = await Promise.all([
        import('./pdf-worker'),
        fetch(fileDownloadUrl(item.path, 'inline'), { headers: authHeaders() }),
      ]);
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      const data = await res.arrayBuffer();
      if (cancelled) return;
      const pdfjs = getPdfjs();
      const pdf = await pdfjs.getDocument({ data }).promise;
      if (cancelled) return;
      if (alive) setNumPages(pdf.numPages);

      const target = containerRef.current;
      if (!target) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        if (cancelled) return;
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1.5 });
        const wrapper = document.createElement('div');
        wrapper.style.maxWidth = `${Math.floor(viewport.width)}px`;
        wrapper.style.margin = '0 auto 12px';
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = '100%';
        canvas.style.height = 'auto';
        canvas.style.display = 'block';
        canvas.style.borderRadius = '6px';
        canvas.style.background = '#fff';
        canvas.style.boxShadow = '0 2px 10px rgba(0,0,0,.25)';
        ctx.scale(dpr, dpr);
        wrapper.appendChild(canvas);
        target.appendChild(wrapper);
        pagesRef.current.push(wrapper);
        await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      }
      if (alive && !cancelled) setState('ok');
    })().catch(() => { if (alive && !cancelled) setState('failed'); });

    return () => { alive = false; cancelled = true; };
  }, [item.path]);

  const pageBoxes = useCallback((): PageBox[] => {
    const scroll = scrollRef.current;
    if (!scroll) return [];
    const base = scroll.getBoundingClientRect().top - scroll.scrollTop;
    return pagesRef.current.map((el) => ({ top: el.getBoundingClientRect().top - base, height: el.offsetHeight }));
  }, []);

  const onScroll = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const p = pageAtScroll(pageBoxes(), scroll.scrollTop, scroll.clientHeight);
    setCurrentPage((prev) => (prev === p ? prev : p));
  }, [pageBoxes]);

  const goToPage = useCallback((n: number) => {
    const scroll = scrollRef.current;
    const el = pagesRef.current[clampPage(n, numPages) - 1];
    if (!scroll || !el) return;
    const top = el.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
    scroll.scrollTo({ top: Math.max(0, top - 12), behavior: 'smooth' });
  }, [numPages]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
      {numPages > 0 && state !== 'failed' && (
        <PdfPager current={currentPage} total={numPages} onJump={goToPage} />
      )}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '20px 16px', boxSizing: 'border-box' }}
      >
        {state === 'loading' && <Centered>Loading PDF…</Centered>}
        {state === 'failed' && <Centered failed>Failed to render {item.name}</Centered>}
        <div ref={containerRef} style={{ maxWidth: 900, margin: '0 auto' }} />
      </div>
    </div>
  );
}

/** Page pager toolbar — prev/next + an editable "N / total" jump field. */
function PdfPager({ current, total, onJump }: { current: number; total: number; onJump: (n: number) => void }): JSX.Element {
  const [draft, setDraft] = useState(String(current));
  useEffect(() => { setDraft(String(current)); }, [current]);

  const commit = (): void => {
    const n = parseJump(draft, total);
    if (n === null) setDraft(String(current));
    else onJump(n);
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: '7px 10px',
        borderBottom: '1px solid var(--proto-line)',
        background: 'var(--proto-rail)',
        flex: 'none',
      }}
    >
      <span
        role="button"
        title="Previous page"
        aria-disabled={current <= 1}
        onClick={() => { if (current > 1) onJump(current - 1); }}
        style={pagerBtnStyle(current <= 1)}
      >
        ↑
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, font: `600 11.5px ${mono}`, color: 'var(--proto-ink)' }}>
        <input
          value={draft}
          inputMode="numeric"
          aria-label="Page number"
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => { if (e.key === 'Enter') { commit(); e.currentTarget.blur(); } }}
          onBlur={commit}
          style={{
            width: 44,
            textAlign: 'center',
            padding: '3px 4px',
            borderRadius: 6,
            border: '1px solid var(--proto-line)',
            background: 'var(--proto-card)',
            color: 'var(--proto-ink)',
            font: `600 11.5px ${mono}`,
          }}
        />
        <span style={{ color: 'var(--proto-muted)' }}>/ {total}</span>
      </div>
      <span
        role="button"
        title="Next page"
        aria-disabled={current >= total}
        onClick={() => { if (current < total) onJump(current + 1); }}
        style={pagerBtnStyle(current >= total)}
      >
        ↓
      </span>
    </div>
  );
}

function pagerBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    width: 28,
    height: 28,
    borderRadius: 8,
    border: '1px solid var(--proto-line)',
    background: 'var(--proto-card)',
    color: 'var(--proto-muted)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 14,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    flex: 'none',
    userSelect: 'none',
  };
}

function Centered({ children, failed }: { children: ReactNode; failed?: boolean }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '48px 20px', color: failed ? 'var(--proto-faint)' : 'var(--proto-muted-2)', font: `500 12px ${mono}` }}>
      {children}
    </div>
  );
}

export function DocModal({ item, onClose }: { item: DocItem; onClose: () => void }): JSX.Element {
  const dl = useDownloadFile();
  // Esc closes; lock body scroll while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

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
        background: 'rgba(10,12,16,.72)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'max(24px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom))',
        boxSizing: 'border-box',
        animation: 'cxfade .18s ease both',
      }}
    >
      {/* Document sheet — click-through inner card stops close on the content itself. */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(920px, 96vw)',
          height: 'min(88vh, 100%)',
          background: 'var(--proto-card)',
          border: '1px solid var(--proto-line)',
          borderRadius: 14,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 12px 48px rgba(0,0,0,.35)',
        }}
      >
        {/* Header — filename + download + close. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            borderBottom: '1px solid var(--proto-line)',
            flex: 'none',
            background: 'var(--proto-rail)',
          }}
        >
          <span style={{ font: `600 11.5px ${mono}`, color: 'var(--proto-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {item.name}
          </span>
          <span
            role="button"
            title="Download"
            onClick={() => dl(item.path, item.name)}
            style={btnStyle}
          >
            ↓
          </span>
          <span role="button" title="Close" onClick={onClose} style={{ ...btnStyle, fontSize: 16 }}>
            ×
          </span>
        </div>

        {/* Body */}
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: item.kind === 'pdf' ? 'var(--proto-gray)' : 'var(--proto-card)' }}>
          {item.kind === 'pdf' ? <PdfBody item={item} /> : <TextBody item={item} />}
        </div>
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 8,
  border: '1px solid var(--proto-line)',
  background: 'var(--proto-card)',
  color: 'var(--proto-muted)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 14,
  cursor: 'pointer',
  flex: 'none',
};

export function DocViewerProvider({ children }: { children: ReactNode }): JSX.Element {
  const [item, setItem] = useState<DocItem | null>(null);
  const openDoc = useCallback((next: DocItem) => setItem(next), []);
  const close = useCallback(() => setItem(null), []);
  const value = useMemo(() => ({ openDoc, close }), [openDoc, close]);
  return (
    <DocViewerContext.Provider value={value}>
      {children}
      {item && <DocModal item={item} onClose={close} />}
    </DocViewerContext.Provider>
  );
}

export function useDocViewer(): DocViewerContextValue {
  return useContext(DocViewerContext);
}
