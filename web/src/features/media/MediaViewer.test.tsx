import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Lightbox, MediaViewerProvider, type MediaItem } from './MediaViewer';

// The Lightbox is rendered directly with an item. renderToStaticMarkup does not run effects, so a
// `url` item paints immediately (state seeded from item.url) while a `path` item shows the loading
// state until its authenticated fetch resolves at runtime.
function render(item: MediaItem): string {
  return renderToStaticMarkup(<Lightbox item={item} onClose={() => {}} />);
}

describe('MediaViewer Lightbox', () => {
  it('renders an <img> for an image item with a ready url', () => {
    const html = render({ kind: 'image', name: 'shot.png', url: 'blob:local-1' });
    expect(html).toContain('<img');
    expect(html).toContain('blob:local-1');
    expect(html).toContain('shot.png'); // caption
  });

  it('renders a <video> for a video item with a ready url', () => {
    const html = render({ kind: 'video', name: 'clip.mp4', url: 'blob:local-2' });
    expect(html).toContain('<video');
    expect(html).toContain('blob:local-2');
  });

  it('shows a loading state for a path item (fetch pending in a static render)', () => {
    const html = render({ kind: 'image', name: 'a.png', path: 'workspace/a.png' });
    expect(html).toContain('Loading');
    expect(html).not.toContain('<img');
  });
});

describe('MediaViewerProvider', () => {
  it('renders no lightbox when nothing is opened', () => {
    const html = renderToStaticMarkup(
      <MediaViewerProvider>
        <div>idle</div>
      </MediaViewerProvider>,
    );
    expect(html).toBe('<div>idle</div>');
  });
});
