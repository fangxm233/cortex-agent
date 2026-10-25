import { useMemo, useRef, useState, type RefObject } from 'react';
import type { ChatMediaProps } from '@/design/ChatMediaContext';
import { useVocabOptional } from '@/i18n';
import { isAllowedMediaUrl, isMediaUrl, inlineMediaKind, isSupportedExternalMedia } from './inline-media-source';
import { useNearViewport } from './useNearViewport';
import { useInlineMediaResource, type InlineMediaError } from './useInlineMediaResource';
import { useWorkspaceObjectUrlState } from './useWorkspaceObjectUrl';
import { useMediaViewer } from './MediaViewer';
import { MediaPreview } from './MediaPreview';
import { useMediaGroupMember } from './inline-media-group';
import type { MediaItem } from './preview-item';

function MediaFailure({ name, error }: { name: string; error: InlineMediaError }): JSX.Element {
  const L = useVocabOptional();
  const labels: Record<InlineMediaError, string> = {
    offline: L.mediaInlineOffline, not_found: L.mediaInlineNotFound, unsupported: L.mediaInlineUnsupported,
    too_large: L.mediaInlineTooLarge, load_failed: L.mediaInlineFailed,
  };
  return <span>{name}<br /><span style={{ fontSize: 12, color: 'var(--proto-muted)' }}>{labels[error]}</span></span>;
}

function ResolvedMedia({ host, item, url, error, name, src }: {
  host: RefObject<HTMLElement>; item?: MediaItem; url: string | null; error?: InlineMediaError; name: string; src: string;
}): JSX.Element {
  const { openMedia } = useMediaViewer();
  const [failed, setFailed] = useState(false);
  const shown = useMemo(() => (item ? { ...item, name } : null), [item, name]);
  const group = useMediaGroupMember(host, url && !error && !failed ? shown : null);
  if (error || failed) return <MediaFailure name={name} error={error ?? 'load_failed'} />;
  return <MediaPreview url={url} kind={item?.kind ?? inlineMediaKind(src)} name={name}
    external={!!item?.url} onError={() => setFailed(true)} onOpen={() => { if (shown && url) openMedia(shown, group?.items()); }} />;
}

function LocalMedia({ near, host, ...props }: ChatMediaProps & { near: boolean; host: RefObject<HTMLElement> }): JSX.Element {
  const resource = useInlineMediaResource(props, near);
  const { url, failed } = useWorkspaceObjectUrlState(resource.item?.path);
  return <ResolvedMedia host={host} item={resource.item} url={url} src={props.src} name={props.alt || resource.item?.name || props.src}
    error={resource.error ?? (failed ? 'load_failed' : undefined)} />;
}

function BlockedMedia({ src, alt }: { src: string; alt: string }): JSX.Element {
  if (!/^https?:\/\//i.test(src)) return <>{alt || src}</>;
  return <a href={src} target="_blank" rel="noreferrer" style={{ color: 'var(--proto-accent)', textDecoration: 'underline' }}>{alt || src}</a>;
}

export function InlineMedia(props: ChatMediaProps): JSX.Element {
  const host = useRef<HTMLSpanElement>(null);
  const near = useNearViewport(host);
  const external = isMediaUrl(props.src);
  const item = useMemo<MediaItem>(() => ({ url: props.src, name: props.alt || props.src, kind: inlineMediaKind(props.src) }), [props.src, props.alt]);
  if (external && !isAllowedMediaUrl(props.src)) return <BlockedMedia {...props} />;
  if (external && !isSupportedExternalMedia(props.src)) return <MediaFailure name={props.alt || props.src} error="unsupported" />;
  return (
    <span ref={host} style={{ display: 'block', maxWidth: '100%', margin: '4px 0' }}>
      {external
        ? <ResolvedMedia host={host} item={item} url={near ? props.src : null} name={item.name} src={props.src} />
        : <LocalMedia {...props} near={near} host={host} />}
    </span>
  );
}
