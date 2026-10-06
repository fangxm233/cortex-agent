import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import '@/design/content-surfaces.css';
import { IconButton } from '@/design/IconButton';
import { useDownloadFile } from './useDownloadFile';
import { useZoom } from './useZoom';
import { useVocabOptional } from '@/i18n';
import { ChatMarkdown } from '@/design/ChatMarkdown';
import { isMarkdownName } from './doc-kind';
import type { DocItem } from './preview-item';
import { HtmlBody } from './HtmlBody';
import { usePreviewHost, usePreviewModalChrome } from './preview-modal';
import { useWorkspaceText } from './useWorkspaceText';
import { clampPage, pageAtScroll, parseJump, type PageBox } from './pdf-pager';
import { PDF_RENDER_SCALE, PdfPreview, type PdfPageCanvas, type PdfPageSize } from './pdf-preview';
import { fetchWorkspaceBytes } from './workspace-bytes';

// Shared in-app document previewer — the single inline viewer for agent-sent (and user-uploaded)
// PDF + text files on web AND mobile. Opening a document NEVER opens a new browser tab (a no-op in the
// Tauri WebView); it raises this full-screen modal (scrim + rendered document + download/close).
// - text/markdown: fetched as text, rendered as Markdown (.md) or a monospace <pre>.
// - pdf: pdf.js draws pages to <canvas> as they near the viewport (reliable in webkit2gtk / Android System WebView, which
//   have NO built-in PDF viewer — an <iframe src=blob:pdf> would silently blank there).
// One instance is mounted per shell (ShellProviders) and opened via useDocViewer().openDoc(item).
//
// The modal is the DEFAULT mode. Where a dock host exists (the desktop workbench — see
// `features/dock`, reached through the `design/dock-intake` seam), the modal also offers ◧: the
// document leaves the modal and opens as a TAB in the
// dock beside the chat, and from then on `openDoc` opens (or focuses) a tab instead of a modal.

const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024; // 2 MB — beyond this, prompt to download instead.
const PDF_PREVIEW_LIMIT = 50 * 1024 * 1024; // 50 MB — likewise for a PDF.
const mono = "'IBM Plex Mono',monospace";

interface DocViewerContextValue {
  openDoc: (item: DocItem) => void;
}

// Default to a no-op so presentational components render without a provider in scope (mirrors MediaViewer).
const DocViewerContext = createContext<DocViewerContextValue>({ openDoc: () => {} });

/** Text/Markdown body — fetch the file's text (authenticated) and render it.
 *  `source` forces the raw text for a Markdown file, which is what the dock's "Source" toggle asks
 *  for; every other kind already renders as raw text and ignores it.
 *  Exported so the dock's `DockFileBody` renders the SAME document body as this modal. */
export function TextBody({ item, source = false }: { item: DocItem; source?: boolean }): JSX.Element {
  const { text, state } = useWorkspaceText(item.path, TEXT_PREVIEW_LIMIT);
  const L = useVocabOptional();

  if (state === 'loading') return <Centered>{L.cmLoading}</Centered>;
  if (state === 'failed') return <Centered failed>{L.cmLoadFailed.replace('{name}', item.name)}</Centered>;
  if (state === 'toolarge') return <Centered>{L.mediaTextTooLarge}</Centered>;

  if (!source && isMarkdownName(item.name)) {
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

/** PDF body — pdf.js draws the pages near the viewport to canvases (see `pdf-preview.ts`). Loads
 *  pdf.js lazily on first PDF open; a file over `PDF_PREVIEW_LIMIT` is offered as a download.
 *  A page pager (counter + prev/next + jump-to-page) tracks the page under the viewport center.
 *  `actions` are host controls (the dock hangs its download there, since a docked tab has no header
 *  of its own); they keep the bar alive even before the pages exist, so a PDF that fails to render
 *  can still be downloaded.
 *  Exported so the dock's `DockFileBody` renders the SAME document body as this modal. */
export function PdfBody({ item, actions }: { item: DocItem; actions?: ReactNode }): JSX.Element {
  const L = useVocabOptional();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef<HTMLDivElement[]>([]);
  const [state, setState] = useState<'loading' | 'ok' | 'toolarge' | 'failed'>('loading');
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const { containerRef: zoomRef, style: zoomStyle, zoom, zoomIn, zoomOut, resetZoom } = useZoom({ mode: 'css-zoom', maxScale: 5 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    let cancelled = false;
    let observer: IntersectionObserver | null = null;
    container.replaceChildren();
    pagesRef.current = [];
    setState('loading');
    setNumPages(0);
    setCurrentPage(1);

    const slots: HTMLDivElement[] = [];
    const preview = new PdfPreview<PDFPageProxy>(pageCanvas(slots, Math.min(window.devicePixelRatio || 1, 2)));
    preview.open({
      fetchBytes: (signal) => fetchWorkspaceBytes(item.path, PDF_PREVIEW_LIMIT, signal),
      loadPdfjs: async () => (await import('./pdf-worker')).getPdfjs(),
    }).then((opened) => {
      if (cancelled || opened.kind === 'closed') return;
      if (opened.kind === 'toolarge') {
        setState('toolarge');
        return;
      }
      for (let pageNumber = 1; pageNumber <= opened.numPages; pageNumber++) {
        const slot = pageSlot(opened.pageSize);
        slot.dataset.page = String(pageNumber);
        container.appendChild(slot);
        slots.push(slot);
      }
      pagesRef.current = slots;
      // Pages within a screen above or below the visible part are drawn; the rest stay blank sheets.
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const pageNumber = Number((entry.target as HTMLElement).dataset.page);
          if (entry.isIntersecting) preview.show(pageNumber);
          else preview.hide(pageNumber);
        }
      }, { root: scrollRef.current, rootMargin: '100% 0px' });
      for (const slot of slots) observer.observe(slot);
      setNumPages(opened.numPages);
      setState('ok');
    }).catch(() => { if (!cancelled) setState('failed'); });

    return () => {
      cancelled = true;
      observer?.disconnect();
      preview.close();
    };
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
    <div className="content-surface" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
      {((numPages > 0 && state !== 'failed') || actions) && (
        <PdfPager
          current={currentPage}
          total={state === 'failed' ? 0 : numPages}
          onJump={goToPage}
          scale={zoom.scale}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onZoomReset={resetZoom}
          actions={actions}
        />
      )}
      <div
        ref={(el) => { scrollRef.current = el; zoomRef(el); }}
        onScroll={onScroll}
        style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '20px 16px', boxSizing: 'border-box' }}
      >
        {state === 'loading' && <Centered>{L.mediaPdfLoading}</Centered>}
        {state === 'failed' && <Centered failed>{L.mediaPdfFailed.replace('{name}', item.name)}</Centered>}
        {state === 'toolarge' && <Centered>{L.mediaTextTooLarge}</Centered>}
        <div ref={containerRef} style={{ ...zoomStyle, maxWidth: 900, margin: '0 auto' }} />
      </div>
    </div>
  );
}

/** A page's place in the document: sized like the page before it is drawn, so the scroll height,
 *  the pager and jump-to-page are right from the start. */
function pageSlot(size: PdfPageSize): HTMLDivElement {
  const slot = document.createElement('div');
  slot.style.margin = '0 auto 12px';
  slot.style.overflow = 'hidden';
  slot.style.borderRadius = 'var(--r-control)';
  slot.style.background = 'var(--media-paper-bg)';
  slot.style.boxShadow = 'var(--media-paper-shadow)';
  sizeSlot(slot, size);
  return slot;
}

function sizeSlot(slot: HTMLDivElement, size: PdfPageSize): void {
  slot.style.maxWidth = `${Math.floor(size.width)}px`;
  slot.style.aspectRatio = `${size.width} / ${size.height}`;
}

function pageCanvas(slots: HTMLDivElement[], dpr: number): PdfPageCanvas<PDFPageProxy> {
  return {
    draw(pageNumber, page) {
      const slot = slots[pageNumber - 1];
      const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
      sizeSlot(slot, viewport);
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.display = 'block';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      slot.replaceChildren(canvas);
      return page.render({ canvas, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] });
    },
    clear(pageNumber) {
      const canvas = slots[pageNumber - 1]?.querySelector('canvas');
      if (!canvas) return;
      // Zero the backing store so the memory goes now, not whenever the canvas is collected.
      canvas.width = 0;
      canvas.height = 0;
      canvas.remove();
    },
  };
}

/** Page pager toolbar — prev/next + an editable "N / total" jump field + zoom controls, plus any
 *  host actions. With no pages yet it collapses to just those actions. */
function PdfPager({ current, total, onJump, scale, onZoomIn, onZoomOut, onZoomReset, actions }: {
  current: number; total: number; onJump: (n: number) => void;
  scale: number; onZoomIn: () => void; onZoomOut: () => void; onZoomReset: () => void;
  actions?: ReactNode;
}): JSX.Element {
  const L = useVocabOptional();
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
        borderBottom: '1px solid var(--proto-line-2)',
        background: 'var(--material-card-bg)',
        flex: 'none',
      }}
    >
      {total > 0 && (
        <IconButton label={L.mediaPrevPage} size={28} disabled={current <= 1} onClick={() => onJump(current - 1)} style={controlStyle(current <= 1)}>
          ↑
        </IconButton>
      )}
      {total > 0 && (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, font: `600 11.5px ${mono}`, color: 'var(--proto-ink)' }}>
        <input
          value={draft}
          inputMode="numeric"
          aria-label={L.mediaPageNumber}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => { if (e.key === 'Enter') { commit(); e.currentTarget.blur(); } }}
          onBlur={commit}
          style={{
            width: 44,
            textAlign: 'center',
            padding: '3px 4px',
            borderRadius: 'var(--r-chip)',
            border: '1px solid var(--proto-line-2)',
            background: 'var(--material-inset-bg)',
            color: 'var(--proto-ink)',
            font: `600 11.5px ${mono}`,
          }}
        />
        <span style={{ color: 'var(--proto-muted)' }}>/ {total}</span>
      </div>
      )}
      {total > 0 && (
        <IconButton label={L.mediaNextPage} size={28} disabled={current >= total} onClick={() => onJump(current + 1)} style={controlStyle(current >= total)}>
          ↓
        </IconButton>
      )}

      {/* Zoom controls */}
      {total > 0 && (
      <div style={{ marginLeft: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
        <IconButton label={L.mViewZoomOut} size={28} disabled={scale <= 1} onClick={onZoomOut} style={controlStyle(scale <= 1)}>−</IconButton>
        <IconButton
          label={L.mediaZoomReset}
          size={28}
          onClick={onZoomReset}
          style={{ width: 'auto', minWidth: 36, padding: '0 4px', font: `600 11px ${mono}`, userSelect: 'none' }}
        >
          {Math.round(scale * 100)}%
        </IconButton>
        <IconButton label={L.mViewZoomIn} size={28} disabled={scale >= 5} onClick={onZoomIn} style={controlStyle(scale >= 5)}>+</IconButton>
      </div>
      )}
      {actions && <div style={{ marginLeft: total > 0 ? 12 : 0, display: 'flex', alignItems: 'center', gap: 4 }}>{actions}</div>}
    </div>
  );
}

/** The bordered control look of the viewer's toolbars, on top of IconButton. A disabled control
 *  fades as a whole rather than only its glyph. */
function controlStyle(disabled = false): CSSProperties {
  return {
    border: '1px solid var(--proto-line-2)',
    borderRadius: 'var(--r-control)',
    background: 'var(--material-control-bg)',
    boxShadow: 'var(--material-control-shadow)',
    fontSize: 14,
    userSelect: 'none',
    ...(disabled ? { opacity: 0.4, color: 'var(--proto-muted)' } : {}),
  };
}

function Centered({ children, failed }: { children: ReactNode; failed?: boolean }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '48px 20px', color: failed ? 'var(--proto-danger)' : 'var(--proto-muted)', font: `500 12px ${mono}` }}>
      {children}
    </div>
  );
}

function DocModal({ item, onClose, onPin }: { item: DocItem; onClose: () => void; onPin?: () => void }): JSX.Element {
  const dl = useDownloadFile();
  const L = useVocabOptional();
  usePreviewModalChrome(onClose);

  return (
    <div
      className="content-surface"
      role="dialog"
      aria-modal="true"
      aria-label={item.name}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 4000,
        background: 'var(--media-backdrop-soft)',
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
          // The toolbar is glass; the document body below keeps its stable reading surface.
          background: 'var(--material-overlay-bg)',
          backdropFilter: 'var(--glass-filter)',
          WebkitBackdropFilter: 'var(--glass-filter)',
          border: '1px solid var(--proto-line-2)',
          borderRadius: 'var(--r-float)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: 'var(--material-overlay-shadow)',
        }}
      >
        {/* Header — filename + download + close. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            borderBottom: '1px solid var(--proto-line-2)',
            flex: 'none',
            background: 'transparent',
          }}
        >
          <span style={{ font: `600 11.5px ${mono}`, color: 'var(--proto-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {item.name}
          </span>
          {onPin && (
            <IconButton label={L.mediaPin} onClick={onPin} style={controlStyle()}>
              ◧
            </IconButton>
          )}
          <IconButton label={L.cmDownload} onClick={() => dl(item.path, item.name)} style={controlStyle()}>
            ↓
          </IconButton>
          <IconButton label={L.cmClose} onClick={onClose} style={{ ...controlStyle(), fontSize: 16 }}>
            ×
          </IconButton>
        </div>

        {/* Body */}
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: item.kind === 'pdf' ? 'var(--proto-gray)' : 'var(--proto-card)' }}>
          {item.kind === 'pdf' ? <PdfBody item={item} />
            : item.kind === 'html' ? <HtmlBody item={item} mode="expanded" />
            : <TextBody item={item} />}
        </div>
      </div>
    </div>
  );
}

export function DocViewerProvider({ children }: { children: ReactNode }): JSX.Element {
  const { item, open, close, pin } = usePreviewHost<DocItem>();
  const value = useMemo(() => ({ openDoc: open }), [open]);
  return (
    <DocViewerContext.Provider value={value}>
      {children}
      {item && <DocModal item={item} onClose={close} onPin={pin} />}
    </DocViewerContext.Provider>
  );
}

export function useDocViewer(): DocViewerContextValue {
  return useContext(DocViewerContext);
}
