// input:  pinned-preview, theme and browser workspace rendering
// output: browser keep-alive regressions across pane visibility
// pos:    Focused component test for docked browser lifetime
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { webItem } from '@/features/browser/browser-target';
import { ThemeProvider } from '@/theme';
import { PinnedPreviewPane } from './PinnedPreviewPane';
import { PinnedPreviewProvider, usePinnedPreview } from './PinnedPreviewProvider';

function Harness(): JSX.Element {
  const preview = usePinnedPreview();
  return (
    <>
      <button data-action="web" onClick={() => preview.pin(webItem(''))} />
      <button data-action="hide" onClick={preview.unpin} />
      <button data-action="file" onClick={() => preview.show({ kind: 'image', name: 'shot.png', url: 'blob:shot' })} />
      <PinnedPreviewPane />
    </>
  );
}

function action(renderer: ReactTestRenderer, name: string): void {
  act(() => renderer.root.findByProps({ 'data-action': name }).props.onClick());
}

function navigate(renderer: ReactTestRenderer): void {
  const input = renderer.root.findByType('input');
  act(() => input.props.onChange({ target: { value: 'http://127.0.0.1:5173/' } }));
  act(() => input.props.onKeyDown({ key: 'Enter' }));
}

describe('PinnedPreviewPane browser keep-alive', () => {
  it('hides rather than unmounting browser frames across pane close and file preview', () => {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<ThemeProvider><PinnedPreviewProvider><Harness /></PinnedPreviewProvider></ThemeProvider>); });
    action(renderer, 'web');
    navigate(renderer);
    const frame = renderer.root.findByProps({ 'data-browser-frame': 'browser-tab-0' });

    action(renderer, 'hide');
    expect(renderer.root.findByProps({ 'data-pane': 'preview' }).props.style.display).toBe('none');
    expect(renderer.root.findByProps({ 'data-browser-frame': 'browser-tab-0' })).toBe(frame);

    action(renderer, 'web');
    expect(renderer.root.findByProps({ 'data-browser-frame': 'browser-tab-0' })).toBe(frame);
    action(renderer, 'file');
    expect(renderer.root.findByProps({ 'data-browser-keepalive': '' }).props.style.display).toBe('none');
    expect(renderer.root.findByProps({ 'data-browser-frame': 'browser-tab-0' })).toBe(frame);
  });
});
