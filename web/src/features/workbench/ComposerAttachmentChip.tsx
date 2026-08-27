// input:  Pending composer attachment state and retry/remove callbacks
// output: Media thumbnail or document-aware file chip with unchanged controls
// pos:    Desktop composer attachment presentation boundary
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { CSSProperties, MouseEvent } from 'react';
import { useDocViewer } from '@/features/media/DocViewer';
import { useMediaViewer } from '@/features/media/MediaViewer';
import { docKindOf } from '@/features/media/doc-kind';
import { mediaKindOf, type MediaKind } from '@/features/media/media-kind';
import { VideoThumb } from '@/features/media/VideoThumb';
import { attachmentFileExt, attachmentTypeColor, formatAttachmentSize } from './attachment-presentation';
import {
  attachmentMime, attachmentName, attachmentSize, attachmentType, type PendingAttachment,
} from './composer-attachments';

const mono = "'IBM Plex Mono',monospace";

interface ChipModel {
  mime: string;
  name: string;
  ext: string;
  isImage: boolean;
  isVideo: boolean;
  kind: MediaKind | null;
  canPreview: boolean;
  colors: { bg: string; fg: string };
}

function chipModel(a: PendingAttachment): ChipModel {
  const mime = attachmentMime(a);
  const type = attachmentType(a);
  return {
    mime,
    name: attachmentName(a),
    ext: attachmentFileExt(attachmentName(a)),
    isImage: mime.startsWith('image/'),
    isVideo: mime.startsWith('video/'),
    kind: mediaKindOf(type),
    canPreview: !!a.previewUrl && a.status !== 'uploading' && a.status !== 'error',
    colors: attachmentTypeColor(type),
  };
}

const mediaWrapStyle: CSSProperties = { position: 'relative', width: 54, height: 54, flex: 'none' };
const mediaExtStyle: CSSProperties = {
  position: 'absolute', left: 4, bottom: 3, font: `500 8px ${mono}`, color: 'var(--proto-muted-2)',
  background: 'var(--media-label-bg)', padding: '1px 4px', borderRadius: 3,
};
const playStyle: CSSProperties = {
  position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: 19,
  height: 19, borderRadius: '50%', background: 'var(--media-control-bg-strong)', color: 'var(--ink-solid-fg)',
  fontSize: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: 1.5, boxSizing: 'border-box',
};
const uploadOverlayStyle: CSSProperties = {
  position: 'absolute', inset: 0, background: 'var(--media-label-bg-soft)', display: 'flex',
  alignItems: 'center', justifyContent: 'center', font: `600 9px ${mono}`, color: 'var(--proto-accent)',
};
const errorOverlayStyle: CSSProperties = {
  ...uploadOverlayStyle, cursor: 'pointer', font: `600 8px ${mono}`, color: 'var(--proto-danger)',
};
const removeStyle: CSSProperties = {
  position: 'absolute', top: -5, right: -5, width: 16, height: 16, borderRadius: '50%',
  background: 'var(--proto-ink)', color: 'var(--ink-solid-fg)', fontSize: 9, display: 'flex',
  alignItems: 'center', justifyContent: 'center', border: '1.5px solid var(--proto-card)',
  boxSizing: 'border-box', cursor: 'pointer',
};
const thumbStyle: CSSProperties = {
  position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover',
};

function mediaInnerStyle(a: PendingAttachment, canPreview: boolean): CSSProperties {
  return {
    position: 'absolute', inset: 0, borderRadius: 8,
    border: a.status === 'error' ? '1px solid var(--proto-danger)' : '1px solid var(--proto-line)',
    background: a.previewUrl ? 'var(--media-stage-bg)' : 'repeating-linear-gradient(45deg,var(--proto-line),var(--proto-line) 5px,var(--proto-line) 5px,var(--proto-line) 10px)',
    boxSizing: 'border-box', overflow: 'hidden', cursor: canPreview ? 'pointer' : 'default',
  };
}

function RemoveButton({ id, onRemove }: { id: string; onRemove: (id: string) => void }): JSX.Element {
  const remove = (event: MouseEvent): void => {
    event.stopPropagation();
    onRemove(id);
  };
  return <span onClick={remove} style={removeStyle}>×</span>;
}

function MediaContent({ a, model }: { a: PendingAttachment; model: ChipModel }): JSX.Element {
  return (
    <>
      {a.previewUrl && model.isImage && <img src={a.previewUrl} alt={model.name} style={thumbStyle} />}
      {a.previewUrl && model.isVideo && <VideoThumb src={a.previewUrl} style={thumbStyle} />}
      <span style={mediaExtStyle}>{model.ext}</span>
      {model.isVideo && a.status !== 'uploading' && <span style={playStyle}>▶</span>}
    </>
  );
}

function UploadState({ a, onRetry }: { a: PendingAttachment; onRetry: (id: string) => void }): JSX.Element | null {
  if (a.status === 'uploading') {
    return (
      <>
        <span style={uploadOverlayStyle}>{a.progress}%</span>
        <span style={{ position: 'absolute', left: 0, bottom: 0, height: 3, width: `${a.progress}%`, background: 'var(--proto-accent)' }} />
      </>
    );
  }
  if (a.status !== 'error') return null;
  return <span onClick={(event) => { event.stopPropagation(); onRetry(a.id); }} style={errorOverlayStyle}>retry</span>;
}

function MediaAttachmentChip({ a, model, onRetry, onRemove, onOpen }: {
  a: PendingAttachment;
  model: ChipModel;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
  onOpen?: () => void;
}): JSX.Element {
  return (
    <div style={mediaWrapStyle}>
      <div
        role={model.canPreview ? 'button' : undefined}
        title={model.canPreview ? model.name : undefined}
        onClick={onOpen}
        style={mediaInnerStyle(a, model.canPreview)}
      >
        <MediaContent a={a} model={model} />
        <UploadState a={a} onRetry={onRetry} />
      </div>
      <RemoveButton id={a.id} onRemove={onRemove} />
    </div>
  );
}

const fileBaseStyle: CSSProperties = {
  position: 'relative', display: 'flex', alignItems: 'center', gap: 8, height: 54,
  background: 'var(--proto-rail)', borderRadius: 8, padding: '0 12px 0 8px', flex: 'none', boxSizing: 'border-box',
};
const fileNameStyle: CSSProperties = {
  font: `500 10.5px ${mono}`, color: 'var(--proto-ink)', maxWidth: 140,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

function fileChipStyle(a: PendingAttachment, preview: boolean): CSSProperties {
  return {
    ...fileBaseStyle,
    border: a.status === 'error' ? '1px solid var(--proto-danger)' : '1px solid var(--proto-line)',
    cursor: preview ? 'pointer' : 'default',
  };
}

function FileIcon({ model }: { model: ChipModel }): JSX.Element {
  const style: CSSProperties = {
    width: 26, height: 32, borderRadius: 5, background: model.colors.bg, color: model.colors.fg,
    display: 'flex', alignItems: 'center', justifyContent: 'center', font: `700 8px ${mono}`, flex: 'none',
  };
  return <span style={style}>{model.ext}</span>;
}

function fileStatus(a: PendingAttachment): string {
  if (a.status === 'uploading') return `${a.progress}%`;
  if (a.status === 'error') return a.errorMsg || 'Failed';
  return formatAttachmentSize(attachmentSize(a));
}

function FileAttachmentChip({ a, model, onRemove, onOpen }: {
  a: PendingAttachment;
  model: ChipModel;
  onRemove: (id: string) => void;
  onOpen?: () => void;
}): JSX.Element {
  const statusColor = a.status === 'uploading'
    ? 'var(--proto-accent)'
    : a.status === 'error' ? 'var(--proto-danger)' : 'var(--proto-muted-3)';
  return (
    <div role={onOpen ? 'button' : undefined} title={onOpen ? model.name : undefined} onClick={onOpen} style={fileChipStyle(a, !!onOpen)}>
      <FileIcon model={model} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={fileNameStyle}>{model.name}</span>
        <span style={{ font: `400 9px ${mono}`, color: statusColor }}>{fileStatus(a)}</span>
      </span>
      <RemoveButton id={a.id} onRemove={onRemove} />
    </div>
  );
}

export function ComposerAttachmentChip({ attachment, onRetry, onRemove }: {
  attachment: PendingAttachment;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
}): JSX.Element {
  const { openMedia } = useMediaViewer();
  const { openDoc } = useDocViewer();
  const model = chipModel(attachment);
  if (model.isImage || model.isVideo) {
    const onOpen = model.canPreview && model.kind
      ? () => openMedia({ kind: model.kind!, name: model.name, url: attachment.previewUrl! })
      : undefined;
    return <MediaAttachmentChip a={attachment} model={model} onRetry={onRetry} onRemove={onRemove} onOpen={onOpen} />;
  }
  const docKind = docKindOf(model.name, model.mime);
  const onOpen = docKind && attachment.status === 'done' && attachment.meta?.path
    ? () => openDoc({ kind: docKind, name: model.name, path: attachment.meta!.path, mimeType: model.mime })
    : undefined;
  return <FileAttachmentChip a={attachment} model={model} onRemove={onRemove} onOpen={onOpen} />;
}
