// input:  Transcript attachments, pending uploads, and mobile viewer providers
// output: Message attachment groups and composer attachment strip
// pos:    Mobile chat attachment presentation seam
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { downloadFile } from '@/lib/files';
import { HtmlBody } from '@/features/media/HtmlBody';
import { useDocViewer } from '@/features/media/DocViewer';
import { useMediaViewer } from '@/features/media/MediaViewer';
import { docKindOfAttachment } from '@/features/media/doc-kind';
import { mediaKindOf } from '@/features/media/media-kind';
import { useWorkspaceObjectUrl } from '@/features/media/useWorkspaceObjectUrl';
import { VideoThumb } from '@/features/media/VideoThumb';
import type { Attachment } from '@/features/workbench/transcript-vm';
import { MC, MONO } from '@/mobile/ui/kit';
import type { PendingAttachmentVM } from './m-chat-vm';

const STRIPES = 'repeating-linear-gradient(45deg,var(--proto-line) 0 6px,var(--proto-rail) 6px 12px)';

function ViewTile({ attachment }: { attachment: Attachment }): JSX.Element {
  const { openDoc } = useDocViewer();
  const item = { kind: 'html' as const, name: attachment.name, path: attachment.path, mimeType: attachment.mimeType };
  return (
    <div style={{ width: '100%', border: `1px solid ${MC.hairline}`, background: 'var(--proto-card)', borderRadius: 12, overflow: 'hidden', boxSizing: 'border-box' }}>
      <div role="button" onClick={() => openDoc(item)} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', borderBottom: `1px solid ${MC.hairline}`, background: 'var(--proto-rail)', cursor: 'pointer' }}>
        <span style={{ font: `700 7.5px ${MONO}`, letterSpacing: '.06em', color: 'var(--proto-accent)', background: 'var(--proto-accent-bg)', border: '1px solid var(--proto-accent-border)', borderRadius: 4, padding: '2px 5px', flex: 'none' }}>VIEW</span>
        <span style={{ font: `500 10.5px ${MONO}`, color: MC.body, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{attachment.name}</span>
        <span style={{ font: `500 10.5px ${MONO}`, color: 'var(--proto-accent)', flex: 'none' }}>↗</span>
      </div>
      <HtmlBody item={item} mode="inline" />
    </div>
  );
}

function MediaTileBody({ attachment, url, kind }: {
  attachment: Attachment;
  url: string | null;
  kind: 'image' | 'video';
}): JSX.Element {
  return (
    <>
      {url && kind === 'image' && <img src={url} alt={attachment.name} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />}
      {url && kind === 'video' && <VideoThumb src={url} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />}
      {kind === 'video' && <span style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: 26, height: 26, borderRadius: '50%', background: 'var(--media-control-bg-dark)', color: 'var(--ink-solid-fg)', fontSize: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: 2, boxSizing: 'border-box' }}>▶</span>}
      <span style={{ position: 'absolute', left: 7, bottom: 6, maxWidth: (attachment.type === 'video' ? 104 : 74) - 14, font: `500 8px ${MONO}`, color: MC.muted, background: 'var(--media-label-bg)', padding: '1px 5px', borderRadius: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', boxSizing: 'border-box' }}>{attachment.name}</span>
    </>
  );
}

function MediaTile({ attachment, kind }: {
  attachment: Attachment;
  kind: 'image' | 'video';
}): JSX.Element {
  const { openMedia } = useMediaViewer();
  const url = useWorkspaceObjectUrl(attachment.path, true);
  const width = attachment.type === 'video' ? 104 : 74;
  return (
    <div role="button" onClick={() => openMedia({ kind, name: attachment.name, path: attachment.path })} style={{ width, height: 74, borderRadius: 12, background: url ? 'var(--media-stage-bg)' : STRIPES, position: 'relative', overflow: 'hidden', flex: 'none', cursor: 'pointer' }}>
      <MediaTileBody attachment={attachment} url={url} kind={kind} />
    </div>
  );
}

function FileTile({ attachment }: { attachment: Attachment }): JSX.Element {
  const { openDoc } = useDocViewer();
  const docKind = docKindOfAttachment(attachment);
  const onTap = docKind
    ? () => openDoc({ kind: docKind, name: attachment.name, path: attachment.path, mimeType: attachment.mimeType })
    : () => void downloadFile(attachment.path, attachment.name);
  return (
    <div role="button" onClick={onTap} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--proto-card)', border: `1px solid ${MC.hairline}`, borderRadius: 9, padding: '6px 10px', flex: 'none', cursor: 'pointer' }}>
      <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke={MC.muted} strokeWidth="1.5"><path d="M3 1.5h5.5L11.5 4v8.5h-8.5z" /><path d="M8.5 1.5V4H11" /></svg>
      <span style={{ font: `500 10.5px ${MONO}`, color: MC.body }}>{attachment.name}</span>
    </div>
  );
}

function AttachmentTile({ attachment }: { attachment: Attachment }): JSX.Element {
  const kind = mediaKindOf(attachment.type);
  if (kind) return <MediaTile attachment={attachment} kind={kind} />;
  return <FileTile attachment={attachment} />;
}

export function AttachmentGroup({ attachments, side = 'right' }: {
  attachments: Attachment[];
  side?: 'left' | 'right';
}): JSX.Element {
  const edge = side === 'left' ? 'flex-start' : 'flex-end';
  const views = attachments.filter((attachment) => attachment.type === 'view');
  const tiles = attachments.filter((attachment) => attachment.type !== 'view');
  return (
    <div style={{ alignSelf: views.length > 0 ? 'stretch' : edge, display: 'flex', flexDirection: 'column', gap: 6, alignItems: views.length > 0 ? 'stretch' : edge }}>
      {views.map((attachment, index) => <ViewTile key={`view-${index}`} attachment={attachment} />)}
      {tiles.length > 0 && <div style={{ alignSelf: edge, display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: edge }}>
        {tiles.map((attachment, index) => <AttachmentTile key={index} attachment={attachment} />)}
      </div>}
    </div>
  );
}

function ComposerPreview({ attachment }: { attachment: PendingAttachmentVM }): JSX.Element | null {
  const { openMedia } = useMediaViewer();
  const kind = attachment.type ? mediaKindOf(attachment.type) : null;
  if (!attachment.previewUrl || !kind) return null;
  return (
    <span role="button" onClick={() => openMedia({ kind, name: attachment.name, url: attachment.previewUrl! })} style={{ position: 'relative', width: 26, height: 26, borderRadius: 6, overflow: 'hidden', background: 'var(--media-stage-bg)', flex: 'none', cursor: 'pointer' }}>
      {kind === 'image'
        ? <img src={attachment.previewUrl} alt={attachment.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        : <VideoThumb src={attachment.previewUrl} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
      {kind === 'video' && <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-solid-fg)', fontSize: 8, textShadow: 'var(--media-glyph-shadow)' }}>▶</span>}
    </span>
  );
}

function UploadStatus({ attachment }: { attachment: PendingAttachmentVM }): JSX.Element | null {
  if (attachment.status === 'uploading') {
    return <><div style={{ width: 34, height: 4, borderRadius: 999, background: 'var(--proto-line-2)', overflow: 'hidden' }}><div style={{ width: `${attachment.progress}%`, height: '100%', background: MC.run }} /></div><span style={{ font: `400 9px ${MONO}`, color: MC.run }}>{attachment.progress}%</span></>;
  }
  if (attachment.status === 'done') return <span style={{ fontSize: 10, color: MC.done, fontWeight: 700 }}>✓</span>;
  if (attachment.status === 'error') return <span style={{ fontSize: 10, color: MC.fail, fontWeight: 700 }}>!</span>;
  return null;
}

function ComposerChip({ attachment, onRemove }: {
  attachment: PendingAttachmentVM;
  onRemove: () => void;
}): JSX.Element {
  const uploading = attachment.status === 'uploading';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: uploading ? 7 : 6, background: 'var(--proto-card)', border: `1px solid ${uploading ? MC.runBorder : MC.hairline}`, borderRadius: 9, padding: '5px 9px', flex: 'none' }}>
      <ComposerPreview attachment={attachment} />
      <span style={{ font: `500 10px ${MONO}`, color: MC.body }}>{attachment.name}</span>
      <UploadStatus attachment={attachment} />
      <span onClick={onRemove} style={{ color: MC.faint, fontSize: 11, cursor: 'pointer' }}>✕</span>
    </div>
  );
}

export function ComposerAttachmentStrip({ attachments, onRemove }: {
  attachments: PendingAttachmentVM[];
  onRemove: (id: string) => void;
}): JSX.Element | null {
  if (attachments.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 6, padding: '0 2px 7px', overflowX: 'auto' }}>
      {attachments.map((attachment) => <ComposerChip key={attachment.id} attachment={attachment} onRemove={() => onRemove(attachment.id)} />)}
    </div>
  );
}
