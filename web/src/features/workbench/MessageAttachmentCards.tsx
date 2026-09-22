// input:  Attachment metadata, media viewers, download actions
// output: AttachmentCard, AgentFileGroup
// pos:    Transcript attachment cards with compact file controls
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { MENU_FOCUS } from './MenuChrome';
import { useVocab } from '@/i18n';
import { useDownloadFile } from '@/features/media/useDownloadFile';
import { useMediaViewer } from '@/features/media/MediaViewer';
import { useDocViewer } from '@/features/media/DocViewer';
import { useWorkspaceObjectUrl } from '@/features/media/useWorkspaceObjectUrl';
import { mediaKindOf } from '@/features/media/media-kind';
import { VideoThumb } from '@/features/media/VideoThumb';
import { docKindOfAttachment } from '@/features/media/doc-kind';
import { HtmlBody } from '@/features/media/HtmlBody';
import { useDock } from '@/features/dock/DockProvider';
import type { AttachmentMeta, AttachmentMeta as Attachment } from '@/features/attachments/types';
import { attachmentFileExt, attachmentTypeColor, formatAttachmentSize } from './attachment-presentation';

const mono = "'IBM Plex Mono',monospace";
const stageFallback = 'repeating-linear-gradient(45deg,var(--proto-line),var(--proto-line) 5px,var(--proto-line) 5px,var(--proto-line) 10px)';

const mediaNameStyle: CSSProperties = {
  position: 'absolute', left: 6, bottom: 5, font: `500 11px ${mono}`, color: 'var(--proto-muted)',
  background: 'var(--media-label-bg)', padding: '1.5px 5px', borderRadius: 'var(--r-chip)', overflow: 'hidden',
  textOverflow: 'ellipsis', whiteSpace: 'nowrap', boxSizing: 'border-box',
};
const smallPlayStyle: CSSProperties = {
  position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: 26,
  height: 26, borderRadius: '50%', background: 'var(--media-control-bg-strong)', color: 'var(--ink-solid-fg)',
  fontSize: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: 2, boxSizing: 'border-box',
};

function thumbStageStyle(url: string | null, width: number, height: number): CSSProperties {
  return {
    position: 'relative', width, height, borderRadius: 'var(--r-card)',
    boxShadow: 'var(--shadow-card-subtle), 0 0 0 1px var(--proto-line-2)',
    background: url ? 'var(--media-stage-bg)' : stageFallback, boxSizing: 'border-box', flex: 'none',
    overflow: 'hidden', cursor: 'pointer',
  };
}

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
  const url = useWorkspaceObjectUrl(a.path);
  return (
    <div role="button" title={a.name} onClick={() => openMedia({ kind, name: a.name, path: a.path })} style={thumbStageStyle(url, width, height)}>
      <ThumbBody url={url} kind={kind} name={a.name} />
      {kind === 'video' && <span style={smallPlayStyle}>▶</span>}
      <span style={{ ...mediaNameStyle, maxWidth: width - 12 }}>{a.name}</span>
    </div>
  );
}

const userFileStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 9, background: 'var(--material-card-bg)', boxShadow: 'var(--material-card-shadow)',
  borderRadius: 'var(--r-card)', padding: '8px 12px 8px 9px',
};

function FileBadge({ type, name, agent = false }: {
  type: AttachmentMeta['type'];
  name: string;
  agent?: boolean;
}): JSX.Element {
  const colors = attachmentTypeColor(type);
  const style: CSSProperties = {
    width: agent ? 28 : 26, height: agent ? 34 : 32, borderRadius: 'var(--r-chip)', background: colors.bg,
    color: colors.fg, display: 'flex', alignItems: 'center', justifyContent: 'center',
    font: `700 10.5px ${mono}`, flex: 'none',
  };
  return <span style={style}>{attachmentFileExt(name)}</span>;
}

export function AttachmentCard({ a }: { a: AttachmentMeta }): JSX.Element {
  const { openDoc } = useDocViewer();
  if (a.type === 'image' || a.type === 'video') return <MediaThumb a={a} width={150} height={98} />;
  const docKind = docKindOfAttachment(a);
  const preview = docKind
    ? () => openDoc({ kind: docKind, name: a.name, path: a.path, mimeType: a.mimeType })
    : undefined;
  return (
    <div role={preview ? 'button' : undefined} title={preview ? a.name : undefined} onClick={preview} style={{ ...userFileStyle, cursor: preview ? 'pointer' : 'default' }}>
      <FileBadge type={a.type} name={a.name} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ font: `500 11px ${mono}`, color: 'var(--proto-ink)' }}>{a.name}</span>
        <span style={{ font: `400 11px ${mono}`, color: 'var(--proto-muted)' }}>{formatAttachmentSize(a.size)} · {a.path}</span>
      </span>
    </div>
  );
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i + 1) : path;
}

// The two trailing controls of an attachment card share one glass pill shape; only the ring tone
// and the label distinguish the neutral action from the accent "open".
const pillBaseStyle: CSSProperties = {
  border: 0, padding: 0, height: 26, borderRadius: 'var(--r-chip)', background: 'var(--material-control-bg)', display: 'flex',
  alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flex: 'none',
};

function ActionBtn({ title, onClick, children }: {
  title: string;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  const style: CSSProperties = {
    ...pillBaseStyle, width: 26, boxShadow: 'var(--material-control-shadow), 0 0 0 1px var(--proto-line-2)',
    color: 'var(--proto-muted)', fontSize: 11,
  };
  return <button type="button" className={MENU_FOCUS} title={title} aria-label={title} onClick={onClick} style={style}>{children}</button>;
}

function OpenBtn({ onClick, children }: { onClick: () => void; children: ReactNode }): JSX.Element {
  const style: CSSProperties = {
    ...pillBaseStyle, boxShadow: 'var(--material-control-shadow), 0 0 0 1px var(--proto-accent-border)',
    color: 'var(--proto-accent)', font: `500 11px ${mono}`, padding: '0 9px',
  };
  return <button type="button" className={MENU_FOCUS} onClick={onClick} style={style}>{children} ↗</button>;
}

const agentFileStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10,
  background: 'var(--material-card-bg)', borderRadius: 'var(--r-card)', padding: '9px 10px',
  boxShadow: 'var(--material-card-shadow), 0 0 0 1px var(--proto-line-2)',
  boxSizing: 'border-box', maxWidth: '100%',
};
const agentNameStyle: CSSProperties = {
  font: `500 11.5px ${mono}`, color: 'var(--proto-ink)', overflow: 'hidden',
  textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const agentMetaStyle: CSSProperties = {
  font: `400 11px ${mono}`, color: 'var(--proto-muted)', overflow: 'hidden',
  textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

function AgentFileCard({ a }: { a: Attachment }): JSX.Element {
  const L = useVocab();
  const dl = useDownloadFile();
  const { openDoc } = useDocViewer();
  const docKind = docKindOfAttachment(a);
  const preview = docKind
    ? () => openDoc({ kind: docKind, name: a.name, path: a.path, mimeType: a.mimeType })
    : undefined;
  return (
    <div role={preview ? 'button' : undefined} onClick={preview} style={{ ...agentFileStyle, cursor: preview ? 'pointer' : 'default' }}>
      <FileBadge type={a.type} name={a.name} agent />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
        <span style={agentNameStyle}>{a.name}</span>
        <span style={agentMetaStyle}>{formatAttachmentSize(a.size)} · {dirOf(a.path)}</span>
      </span>
      <span style={{ display: 'flex', gap: 5, flex: 'none' }} onClick={(event) => event.stopPropagation()}>
        <ActionBtn title={L.wbFileDownload} onClick={() => dl(a.path, a.name)}>↓</ActionBtn>
        {preview && <OpenBtn onClick={preview}>{L.wbFileOpen}</OpenBtn>}
      </span>
    </div>
  );
}

function useNearViewport(hostRef: React.RefObject<HTMLDivElement>): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = hostRef.current;
    if (!element || visible) return;
    if (typeof IntersectionObserver !== 'function') { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '400px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hostRef, visible]);
  return visible;
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
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', borderBottom: '1px solid var(--proto-line-2)', background: 'var(--proto-rail)' }}>
      <span style={{ font: `700 11px ${mono}`, letterSpacing: '.06em', color: 'var(--proto-accent)', background: 'var(--proto-accent-bg)', boxShadow: '0 0 0 1px var(--proto-accent-border)', borderRadius: 'var(--r-chip)', padding: '2px 5px', flex: 'none' }}>{L.wbViewBadge}</span>
      <span style={{ font: `500 11.5px ${mono}`, color: 'var(--proto-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{a.name}</span>
      <span style={{ display: 'flex', gap: 5, flex: 'none' }}>
        <ActionBtn title={L.wbViewSource} onClick={source}>{'<>'}</ActionBtn>
        <ActionBtn title={L.wbFileDownload} onClick={download}>↓</ActionBtn>
        {canPin && <ActionBtn title={L.wbViewDock} onClick={dock}>◧</ActionBtn>}
        <OpenBtn onClick={expand}>{L.wbViewExpand}</OpenBtn>
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
  const dock = useDock();
  const hostRef = useRef<HTMLDivElement>(null);
  const visible = useNearViewport(hostRef);
  const item = { kind: 'html' as const, name: a.name, path: a.path, mimeType: a.mimeType };
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

const agentMediaStyle: CSSProperties = {
  position: 'relative', maxWidth: 320, borderRadius: 'var(--r-card)',
  boxShadow: 'var(--shadow-card-subtle), 0 0 0 1px var(--proto-line-2)',
  overflow: 'hidden', boxSizing: 'border-box', cursor: 'pointer',
};
const largePlayStyle: CSSProperties = {
  position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: 40,
  height: 40, borderRadius: '50%', background: 'var(--media-control-bg-dark)', color: 'var(--ink-solid-fg)',
  fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: 3, boxSizing: 'border-box',
};
const agentMediaNameStyle: CSSProperties = {
  position: 'absolute', left: 8, bottom: 7, maxWidth: 'calc(100% - 16px)',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  font: `500 11px ${mono}`, color: 'var(--proto-muted)',
  background: 'var(--media-label-bg)', padding: '1.5px 5px', borderRadius: 'var(--r-chip)',
};

function AgentMediaBody({ url, kind, name }: {
  url: string | null;
  kind: 'image' | 'video';
  name: string;
}): JSX.Element {
  const style: CSSProperties = { display: 'block', maxWidth: 320, maxHeight: 240, width: 'auto', height: 'auto' };
  if (!url) return <div style={{ width: 320, height: 180 }} />;
  if (kind === 'image') return <img src={url} alt={name} style={style} />;
  return <VideoThumb src={url} style={style} />;
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
  const url = useWorkspaceObjectUrl(a.path);
  const [hover, setHover] = useState(false);
  return (
    <div
      role="button" title={a.name} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onClick={() => openMedia({ kind, name: a.name, path: a.path })}
      style={{ ...agentMediaStyle, background: url ? 'var(--media-stage-bg)' : stageFallback }}
    >
      <AgentMediaBody url={url} kind={kind} name={a.name} />
      {kind === 'video' && <span style={largePlayStyle}>▶</span>}
      <span style={agentMediaNameStyle}>{a.name}</span>
      {hover && <MediaDownload a={a} onDownload={dl} />}
    </div>
  );
}

export function AgentFileGroup({ attachments }: { attachments: Attachment[] }): JSX.Element {
  const L = useVocab();
  const dl = useDownloadFile();
  const views = attachments.filter((a) => a.type === 'view');
  const media = attachments.filter((a) => mediaKindOf(a.type) !== null);
  const files = attachments.filter((a) => a.type !== 'view' && mediaKindOf(a.type) === null);
  const wide = views.length > 0;
  return (
    <div style={{ maxWidth: wide ? '92%' : '75%', width: wide ? '92%' : undefined, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6, marginTop: 10, marginInline: wide ? 'auto' : undefined }}>
      {media.length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{media.map((a, i) => <AgentMediaPreview key={`media-${i}`} a={a} />)}</div>}
      {views.map((a, i) => <AgentViewCard key={`view-${i}`} a={a} />)}
      {files.map((a, i) => <AgentFileCard key={`file-${i}`} a={a} />)}
      {attachments.length >= 3 && (
        <div style={{ font: `400 11px ${mono}`, color: 'var(--proto-muted)', padding: '2px 2px 0' }}>
          {attachments.length} {L.wbFileFiles} ·{' '}
          <button type="button" className={MENU_FOCUS} style={{ border: 0, padding: 0, background: 'transparent', font: 'inherit', color: 'var(--proto-muted)', cursor: 'pointer' }} onClick={() => attachments.forEach((a) => dl(a.path, a.name))}>{L.wbFileDownloadAll} ↓</button>
        </div>
      )}
    </div>
  );
}
