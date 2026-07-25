import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PinnedPreviewPanel, PINNED_PREVIEW_EMPTY_HINT } from './PinnedPreviewPane';
import { PREVIEW_SPLIT_DEFAULT, type PreviewItem } from './pinned-preview';

// Presentational contract of the docked preview pane (the pinned counterpart of the modal
// lightbox). State/wiring lives in PinnedPreviewProvider; this asserts the chrome only.

const noop = (): void => {};
const render = (item: PreviewItem | null): string =>
  renderToStaticMarkup(
    <PinnedPreviewPanel item={item} split={PREVIEW_SPLIT_DEFAULT} onClose={noop} onResizeStart={noop} />,
  );

describe('PinnedPreviewPanel', () => {
  it('empty pane: keeps the split open with a hint, no media element', () => {
    const html = render(null);
    expect(html).toContain(PINNED_PREVIEW_EMPTY_HINT);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<video');
  });

  it('renders a local composer preview straight from its object URL, with no download action', () => {
    const html = render({ kind: 'image', name: 'local.png', url: 'blob:local' });
    expect(html).toContain('local.png');
    expect(html).toContain('src="blob:local"');
    expect(html).not.toContain('title="Download"');
  });

  it('a workspace image carries the download action in the header', () => {
    const html = render({ kind: 'image', name: 'shot.png', path: 'workspace/shot.png' });
    expect(html).toContain('shot.png');
    expect(html).toContain('title="Download"');
  });

  it('always offers the unpin action (× restores the modal preview mode)', () => {
    expect(render(null)).toContain('title="Unpin preview"');
    expect(render({ kind: 'image', name: 'a.png', url: 'blob:a' })).toContain('title="Unpin preview"');
  });

  it('video items render a playable <video>, not an <img>', () => {
    const html = render({ kind: 'video', name: 'clip.mp4', url: 'blob:clip' });
    expect(html).toContain('<video');
    expect(html).not.toContain('<img');
  });

  it('takes its share of the flex row from the split ratio', () => {
    const html = renderToStaticMarkup(
      <PinnedPreviewPanel item={null} split={0.35} onClose={noop} onResizeStart={noop} />,
    );
    expect(html).toContain('flex-grow:0.35');
  });
});
