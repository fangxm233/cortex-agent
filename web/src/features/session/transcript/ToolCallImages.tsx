import { useRef, type CSSProperties, type MouseEvent } from 'react';
import type { ToolCallImage } from '@/features/session/composer/chat-content';
import { useMediaViewer } from '@/features/media/MediaViewer';
import { thumbStageStyle } from '@/features/media/thumb-stage';
import { useNearViewport } from '@/features/media/useNearViewport';
import { useWorkspaceObjectUrl } from '@/features/media/useWorkspaceObjectUrl';

const THUMB_HEIGHT = 120;
/** Placeholder width until the image's own aspect ratio is known. */
const PENDING_WIDTH = 160;

const stripStyle: CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: 6, padding: '2px 13px 10px',
};
const imageStyle: CSSProperties = {
  display: 'block', height: '100%', width: 'auto', maxWidth: '100%', objectFit: 'cover',
};

function ToolImageThumb({ image }: { image: ToolCallImage }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const near = useNearViewport(hostRef);
  const url = useWorkspaceObjectUrl(near ? image.path : null);
  const { openMedia } = useMediaViewer();
  const open = (event: MouseEvent<HTMLDivElement>): void => {
    // The panel around it collapses on click; opening an image must not.
    event.stopPropagation();
    openMedia({ kind: 'image', name: image.name, path: image.path });
  };
  return (
    <div
      ref={hostRef} role="button" title={image.name} onClick={open} data-tool-image
      style={{ ...thumbStageStyle(url, url ? 'auto' : PENDING_WIDTH, THUMB_HEIGHT), maxWidth: '100%' }}
    >
      {url ? <img src={url} alt={image.name} style={imageStyle} /> : null}
    </div>
  );
}

/** The images one tool call returned, at a fixed row height and their own aspect ratio. */
export function ToolCallImages({ images }: { images: ToolCallImage[] }): JSX.Element {
  return (
    <div style={stripStyle}>
      {images.map((image) => <ToolImageThumb key={image.path} image={image} />)}
    </div>
  );
}
