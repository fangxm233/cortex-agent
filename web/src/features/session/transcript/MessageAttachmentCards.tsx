import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { MENU_FOCUS } from '@/design/MenuChrome';
import { useVocab } from '@/i18n';
import { useDownloadFile } from '@/features/media/useDownloadFile';
import { useMediaViewer } from '@/features/media/MediaViewer';
import { useDocViewer } from '@/features/media/DocViewer';
import { useWorkspaceObjectUrl } from '@/features/media/useWorkspaceObjectUrl';
import { useNearViewport } from '@/features/media/useNearViewport';
import { thumbStageStyle } from '@/features/media/thumb-stage';
import { mediaKindOf } from '@/features/media/media-kind';
import { VideoThumb } from '@/features/media/VideoThumb';
import { MediaPreview } from '@/features/media/MediaPreview';
import { docKindOfAttachment } from '@/features/media/doc-kind';
import { HtmlBody } from '@/features/media/HtmlBody';
import { useDockIntake } from '@/design/dock-intake';
import { IconButton } from '@/design/IconButton';
import type { AttachmentMeta, AttachmentMeta as Attachment } from '@/features/attachments/types';
import { attachmentKindLabel, formatAttachmentSize } from '@/features/attachments/attachment-presentation';
import { EventIcon, eventRowStyle } from './EventRow';
import { viewGroupBox, widestViewWidth } from './view-width';

// A file name is a label, not code: every name, size and type word here is in the UI face. The full
// path only ever appears in a tooltip, where it is the thing being looked up.
const mediaNameStyle: CSSProperties = {
  position: 'absolute', left: 6, bottom: 5, font: '500 11px var(--font-ui)', color: 'var(--proto-muted)',
  background: 'var(--media-label-bg)', padding: '1.5px 5px', borderRadius: 'var(--r-chip)', overflow: 'hidden',
  textOverflow: 'ellipsis', whiteSpace: 'nowrap', boxSizing: 'border-box',
};
const smallPlayStyle: CSSProperties = {
  position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: 26,
  height: 26, borderRadius: '50%', background: 'var(--media-control-bg-strong)', color: 'var(--ink-solid-fg)',
  fontSize: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: 2, boxSizing: 'border-box',
};

function ThumbBody({ url, kind, name }: {
  url: string | null;
  kind: 'image' | 'video';
  name: string;
}): JSX.Element | null {
  const style: CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', display: 'block' };
  if (!url) return null;
  if (kind === 'image') return <img src={url} alt={name} style={style} />;
  return <VideoThumb src={url} style={style} />;
}

function MediaThumb({ a, width, height }: {
  a: { name: string; path: string; type: 'image' | 'video' | 'file' | 'view' };
  width: number;
  height: number;
}): JSX.Element {
  const kind = mediaKindOf(a.type)!;
  const { openMedia } = useMediaViewer();
  const hostRef = useRef<HTMLDivElement>(null);
  const near = useNearViewport(hostRef);
  const url = useWorkspaceObjectUrl(near ? a.path : null);
  return (
    <div ref={hostRef} role="button" title={a.name} onClick={() => openMedia({ kind, name: a.name, path: a.path })} style={thumbStageStyle(url, width, height)}>
      <ThumbBody url={url} kind={kind} name={a.name} />
      {kind === 'video' && <span style={smallPlayStyle}>▶</span>}
      <span style={{ ...mediaNameStyle, maxWidth: width - 12 }}>{a.name}</span>
    </div>
  );
}

// ── Files: one quiet row ──────────────────────────────────────────────────────────────────────
// A file is a line of record, not a card: the transcript's row grammar (16px glyph column, the name,
// a muted "CSV · 4.1 KB") with its actions as plain text and a borderless icon. No type chip: the
// glyph says "file" and the meta says which kind.

const ICON_COL: CSSProperties = { width: 16, height: 16, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--proto-faint)' };
const fileNameStyle: CSSProperties = {
  font: '550 13px var(--font-ui)', color: 'var(--proto-ink)', minWidth: 0,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const fileMetaStyle: CSSProperties = {
  font: '400 12.5px var(--font-ui)', color: 'var(--proto-muted)', fontVariantNumeric: 'tabular-nums',
  flex: 'none', whiteSpace: 'nowrap',
};

function useFileMeta(a: AttachmentMeta): string {
  const L = useVocab();
  const kind = attachmentKindLabel(a.type, a.name, { image: L.wbFileKindImage, video: L.wbFileKindVideo, file: L.wbFileKindFile });
  return `${kind} · ${formatAttachmentSize(a.size)}`;
}

function FileRowContent({ a }: { a: AttachmentMeta }): JSX.Element {
  return (
    <>
      <span style={ICON_COL}><EventIcon name="file" /></span>
      <span style={fileNameStyle}>{a.name}</span>
      <span style={fileMetaStyle}>{useFileMeta(a)}</span>
    </>
  );
}

/** A plain text action — the accent marks it as a link, nothing else does. */
function TextAction({ onClick, children }: { onClick: () => void; children: ReactNode }): JSX.Element {
  return (
    <button type="button" className={`${MENU_FOCUS} hover:underline`} onClick={onClick}
      style={{ border: 0, padding: '2px 4px', background: 'transparent', borderRadius: 'var(--r-chip)', font: '500 12.5px var(--font-ui)', color: 'var(--proto-accent)', cursor: 'pointer', flex: 'none' }}>
      {children}
    </button>
  );
}

function DownloadGlyph(): JSX.Element {
  return (
    <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.5v8M4.8 7.5 8 10.7l3.2-3.2M3.5 13.5h9" />
    </svg>
  );
}

// A user's upload sits beside their bubble, so it keeps a hairline capsule on the same glass as the
// bubble; the row inside is the one every file uses.
const userFileStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 8, height: 32, maxWidth: '100%', boxSizing: 'border-box',
  padding: '0 12px 0 8px', borderRadius: 'var(--r-control)', background: 'var(--glass-2)',
  boxShadow: '0 0 0 1px var(--proto-line)',
};

export function AttachmentCard({ a }: { a: AttachmentMeta }): JSX.Element {
  const { openDoc } = useDocViewer();
  if (a.type === 'image' || a.type === 'video') return <MediaThumb a={a} width={150} height={98} />;
  const docKind = docKindOfAttachment(a);
  const preview = docKind
    ? () => openDoc({ kind: docKind, name: a.name, path: a.path, mimeType: a.mimeType })
    : undefined;
  return (
    <div role={preview ? 'button' : undefined} data-attachment-file="user" title={a.path} onClick={preview}
      style={{ ...userFileStyle, cursor: preview ? 'pointer' : 'default' }}>
      <FileRowContent a={a} />
    </div>
  );
}

// A transcript-chrome icon key: borderless and muted, tinted only on hover.
function ActionBtn({ title, onClick, children }: {
  title: string;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return <IconButton size={24} label={title} onClick={onClick} style={{ fontSize: 11 }}>{children}</IconButton>;
}

function AgentFileCard({ a }: { a: Attachment }): JSX.Element {
  const L = useVocab();
  const dl = useDownloadFile();
  const { openDoc } = useDocViewer();
  const docKind = docKindOfAttachment(a);
  const preview = docKind
    ? () => openDoc({ kind: docKind, name: a.name, path: a.path, mimeType: a.mimeType })
    : undefined;
  return (
    <div role={preview ? 'button' : undefined} data-attachment-file="agent" title={a.path} onClick={preview}
      className={preview ? 'hover:bg-[var(--proto-gray)]' : undefined}
      style={eventRowStyle(false, !!preview)}>
      <FileRowContent a={a} />
      <span style={{ marginLeft: 'auto', paddingLeft: 12, display: 'flex', alignItems: 'center', gap: 4, flex: 'none' }}
        onClick={(event) => event.stopPropagation()}>
        <ActionBtn title={L.wbFileDownload} onClick={() => dl(a.path, a.name)}><DownloadGlyph /></ActionBtn>
        {preview && <TextAction onClick={preview}>{L.wbFileOpen}</TextAction>}
      </span>
    </div>
  );
}

type ViewAction = () => void;

function ViewHeader({ a, source, download, dock, expand, canPin }: {
  a: Attachment;
  source: ViewAction;
  download: ViewAction;
  dock: ViewAction;
  expand: ViewAction;
  canPin: boolean;
}): JSX.Element {
  const L = useVocab();
  return (
    <div title={a.path} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px 4px 12px', borderBottom: '1px solid var(--proto-line-2)', background: 'var(--proto-rail)' }}>
      {/* What the frame holds, as a quiet word: a filled badge here read as a second title. */}
      <span style={{ fontSize: 12, color: 'var(--proto-muted)', flex: 'none' }}>{L.wbViewBadge}</span>
      <span style={{ ...fileNameStyle, flex: 1 }}>{a.name}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 2, flex: 'none' }}>
        <ActionBtn title={L.wbViewSource} onClick={source}>{'<>'}</ActionBtn>
        <ActionBtn title={L.wbFileDownload} onClick={download}><DownloadGlyph /></ActionBtn>
        {canPin && <ActionBtn title={L.wbViewDock} onClick={dock}>◧</ActionBtn>}
        <TextAction onClick={expand}>{L.wbViewExpand}</TextAction>
      </span>
    </div>
  );
}

// The frame is glass, but the body inside it stays opaque `--proto-card`: it renders arbitrary
// author HTML, which has to occlude the transcript behind it to stay readable.
const viewCardStyle: CSSProperties = {
  width: '100%', background: 'var(--material-card-bg)', borderRadius: 'var(--r-card)', overflow: 'hidden',
  boxShadow: 'var(--material-card-shadow), 0 0 0 1px var(--proto-line-2)', boxSizing: 'border-box',
};

function AgentViewCard({ a }: { a: Attachment }): JSX.Element {
  const dl = useDownloadFile();
  const { openDoc } = useDocViewer();
  const dock = useDockIntake();
  const hostRef = useRef<HTMLDivElement>(null);
  const visible = useNearViewport(hostRef);
  const item = { kind: 'html' as const, name: a.name, path: a.path, mimeType: a.mimeType, viewWidth: a.viewWidth };
  const expand = (): void => openDoc(item);
  const toDock = (): void => dock.openFile(item);
  const source = (): void => openDoc({ kind: 'text', name: a.name, path: a.path, mimeType: 'text/plain' });
  const download = (): void => dl(a.path, a.name.toLowerCase().endsWith('.html') ? a.name : `${a.name}.html`);
  return (
    <div ref={hostRef} style={viewCardStyle}>
      <ViewHeader a={a} source={source} download={download} dock={toDock} expand={expand} canPin={dock.canDock} />
      <div style={{ background: 'var(--proto-card)' }}>
        {visible ? <HtmlBody item={item} mode="inline" /> : <div style={{ height: 160 }} />}
      </div>
    </div>
  );
}

function MediaDownload({ a, onDownload }: {
  a: Attachment;
  onDownload: (path: string, name: string) => void;
}): JSX.Element {
  const L = useVocab();
  return (
    <button type="button" className={MENU_FOCUS} aria-label={L.wbFileDownload} title={L.wbFileDownload} onClick={(event) => { event.stopPropagation(); onDownload(a.path, a.name); }} style={{ border: 0, padding: 0, position: 'absolute', top: 7, right: 7, width: 24, height: 24, borderRadius: 'var(--r-chip)', background: 'var(--media-control-bg-strong)', color: 'var(--ink-solid-fg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, cursor: 'pointer' }}>
      ↓
    </button>
  );
}

function AgentMediaPreview({ a }: { a: Attachment }): JSX.Element {
  const dl = useDownloadFile();
  const kind = mediaKindOf(a.type)!;
  const { openMedia } = useMediaViewer();
  const hostRef = useRef<HTMLDivElement>(null);
  const near = useNearViewport(hostRef);
  const url = useWorkspaceObjectUrl(near ? a.path : null);
  const [hover, setHover] = useState(false);
  return (
    <div ref={hostRef} style={{ maxWidth: '100%' }} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <MediaPreview url={url} kind={kind} name={a.name} onOpen={() => openMedia({ kind, name: a.name, path: a.path })}>
        {hover && <MediaDownload a={a} onDownload={dl} />}
      </MediaPreview>
    </div>
  );
}

export function AgentFileGroup({ attachments }: { attachments: Attachment[] }): JSX.Element {
  const L = useVocab();
  const dl = useDownloadFile();
  const views = attachments.filter((a) => a.type === 'view');
  const media = attachments.filter((a) => mediaKindOf(a.type) !== null);
  const files = attachments.filter((a) => a.type !== 'view' && mediaKindOf(a.type) === null);
  const viewWidth = widestViewWidth(views);
  const box: CSSProperties = viewWidth ? viewGroupBox(viewWidth) : { maxWidth: '75%' };
  return (
    <div style={{ ...box, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6, marginTop: 10 }}>
      {media.length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{media.map((a, i) => <AgentMediaPreview key={`media-${i}`} a={a} />)}</div>}
      {views.map((a, i) => <AgentViewCard key={`view-${i}`} a={a} />)}
      {files.map((a, i) => <AgentFileCard key={`file-${i}`} a={a} />)}
      {attachments.length >= 3 && (
        <div style={{ font: '400 12px var(--font-ui)', fontVariantNumeric: 'tabular-nums', color: 'var(--proto-muted)', padding: '2px 0 0' }}>
          {attachments.length} {L.wbFileFiles} ·{' '}
          <button type="button" className={MENU_FOCUS} style={{ border: 0, padding: 0, background: 'transparent', font: 'inherit', color: 'var(--proto-muted)', cursor: 'pointer' }} onClick={() => attachments.forEach((a) => dl(a.path, a.name))}>{L.wbFileDownloadAll} ↓</button>
        </div>
      )}
    </div>
  );
}
