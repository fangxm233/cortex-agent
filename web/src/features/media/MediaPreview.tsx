import type { CSSProperties, ReactNode } from 'react';
import { stageFallback } from './thumb-stage';
import { VideoThumb } from './VideoThumb';
import type { MediaKind } from './media-kind';

const frameStyle: CSSProperties = {
  display: 'inline-block', position: 'relative', maxWidth: 'min(320px, 100%)', verticalAlign: 'top',
  borderRadius: 'var(--r-card)', boxShadow: 'var(--shadow-card-subtle), 0 0 0 1px var(--proto-line-2)',
  overflow: 'hidden', boxSizing: 'border-box', cursor: 'pointer',
};
const playStyle: CSSProperties = {
  position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: 40,
  height: 40, borderRadius: '50%', background: 'var(--media-control-bg-dark)', color: 'var(--ink-solid-fg)',
  fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: 3, boxSizing: 'border-box',
};
const nameStyle: CSSProperties = {
  position: 'absolute', left: 8, bottom: 7, maxWidth: 'calc(100% - 16px)',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  font: "500 11px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)',
  background: 'var(--media-label-bg)', padding: '1.5px 5px', borderRadius: 'var(--r-chip)',
};

interface PreviewProps {
  url: string | null;
  kind: MediaKind;
  name: string;
  external?: boolean;
  onError?: () => void;
}

function MediaPreviewBody({ url, kind, name, external, onError }: PreviewProps): JSX.Element {
  const style: CSSProperties = { display: 'block', maxWidth: '100%', maxHeight: 240, width: 'auto', height: 'auto' };
  if (!url) return <span data-media-placeholder style={{ display: 'block', width: 320, maxWidth: '100%', height: 180 }} />;
  if (kind === 'image') return <img src={url} alt={name} referrerPolicy="no-referrer" style={style} onError={onError} />;
  return external
    ? <video src={url} muted playsInline preload="metadata" style={style} onError={onError} />
    : <VideoThumb src={url} style={style} onError={onError} />;
}

export function MediaPreview({ onOpen, children, ...props }: PreviewProps & {
  onOpen: () => void;
  children?: ReactNode;
}): JSX.Element {
  return (
    <span role="button" tabIndex={0} aria-label={props.name} title={props.name} onClick={onOpen}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(); } }}
      style={{ ...frameStyle, background: props.url ? 'var(--media-stage-bg)' : stageFallback }}>
      <MediaPreviewBody {...props} />
      {props.kind === 'video' && <span style={playStyle}>▶</span>}
      <span style={nameStyle}>{props.name}</span>
      {children}
    </span>
  );
}
