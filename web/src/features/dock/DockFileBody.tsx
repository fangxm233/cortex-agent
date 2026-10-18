import { useState, type CSSProperties } from 'react';
import { IconButton } from '@/design/IconButton';
import { PdfBody, TextBody } from '@/features/media/DocViewer';
import { HtmlBody } from '@/features/media/HtmlBody';
import { isMarkdownName } from '@/features/media/doc-kind';
import type { MediaItem } from '@/features/media/preview-item';
import { useDownloadFile } from '@/features/media/useDownloadFile';
import { useMediaSrc } from '@/features/media/useMediaSrc';
import { useZoom } from '@/features/media/useZoom';
import { useVocabOptional } from '@/i18n';
import { FileBar, FileBarToggle } from './FileBar';
import { isDocItem, type FileItem } from './dock-tabs';

// A docked preview is never a lesser view: pdf/text/html go through the DocViewer's own bodies and
// media gets the lightbox's full-size source and wheel/pinch zoom.
//
// What the dock adds is the row the modals get from their header — where the file is and what can be
// done with it. A PDF already has such a row (its page pager) and takes the download there; every
// other kind gets a `FileBar`. A file with no workspace path (a composer object URL for something
// not uploaded yet) has nothing to show or download, so it gets no row at all.

export function DockFileBody({ item }: { item: FileItem }): JSX.Element {
  const dl = useDownloadFile();
  const L = useVocabOptional();
  const [source, setSource] = useState(false);
  const path = item.path;
  const download = path ? () => dl(path, item.name) : undefined;
  const markdown = isDocItem(item) && item.kind === 'text' && isMarkdownName(item.name);

  if (isDocItem(item) && item.kind === 'pdf') {
    return (
      <div style={CONTENT_STYLE.pdf}>
        <PdfBody
          item={item}
          actions={download && (
            <IconButton data-file-download="" label={L.cmDownload} size={28} onClick={download} style={PAGER_BUTTON_STYLE}>↓</IconButton>
          )}
        />
      </div>
    );
  }

  return (
    <>
      {path && (
        <FileBar path={path} onDownload={download}>
          {markdown && (
            <FileBarToggle
              on={source}
              label={source ? L.dockRendered : L.wbViewSource}
              title={source ? L.dockShowRendered : L.dockShowSource}
              onClick={() => setSource((on) => !on)}
              data-file-source-toggle=""
            />
          )}
        </FileBar>
      )}
      <div style={isDocItem(item) && item.kind === 'text' ? CONTENT_STYLE.text : CONTENT_STYLE.fill}>
        {isDocItem(item)
          ? (item.kind === 'html' ? <HtmlBody item={item} mode="expanded" /> : <TextBody item={item} source={source} />)
          : <DockMediaBody item={item} />}
      </div>
    </>
  );
}

/** Full-size image / video inside the docked pane (wheel + pinch zoom, like the lightbox). */
function DockMediaBody({ item }: { item: MediaItem }): JSX.Element {
  const { src, failed } = useMediaSrc(item);
  const L = useVocabOptional();
  const { containerRef, contentRef, style: zoomStyle } = useZoom({ mode: 'transform', maxScale: 8 });

  if (failed) return <DockCentered failed>{L.cmLoadFailed.replace('{name}', item.name)}</DockCentered>;
  if (!src) return <DockCentered>{L.cmLoading}</DockCentered>;

  return (
    <div
      ref={containerRef}
      style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', padding: 12, boxSizing: 'border-box' }}
    >
      {item.kind === 'video' ? (
        <video src={src} controls playsInline style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 'var(--r-chip)', background: 'var(--media-stage-bg)' }} />
      ) : (
        <div ref={contentRef} style={{ ...zoomStyle, display: 'inline-block', maxWidth: '100%', maxHeight: '100%' }}>
          <img
            src={src}
            alt={item.name}
            draggable={false}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }}
          />
        </div>
      )}
    </div>
  );
}

/** A pane's one line of state — empty, loading, failed: muted text in the UI face, nothing around it. */
export function DockCentered({ children, failed }: { children: React.ReactNode; failed?: boolean }): JSX.Element {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', boxSizing: 'border-box', padding: '32px 20px', textAlign: 'center', color: failed ? 'var(--proto-danger)' : 'var(--proto-muted)', fontSize: 13, lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

/** The pane's background follows the body under it — a PDF sits on the darker page surface. */
export function dockFileBackground(item: FileItem): string {
  return isDocItem(item) && item.kind === 'pdf' ? 'var(--proto-gray)' : 'var(--proto-card)';
}

// Text is the only body that does not manage its own scrolling; the rest fill and scroll internally.
const CONTENT_STYLE = {
  text: { flex: 1, minHeight: 0, overflow: 'auto', scrollbarGutter: 'stable' } as CSSProperties,
  fill: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } as CSSProperties,
  pdf: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } as CSSProperties,
};

/** Resting look on top of IconButton, matching the PDF pager's own buttons beside it (whose muted glyph turns ink on hover). */
const PAGER_BUTTON_STYLE: CSSProperties = {
  borderRadius: 'var(--r-chip)',
  border: '1px solid var(--proto-line)',
  background: 'var(--proto-card)',
  fontSize: 13,
  userSelect: 'none',
};
