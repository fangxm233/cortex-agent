import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Reorder } from 'motion/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/theme';
import { DockPane } from './DockPane';
import { DockProvider, useDock } from './DockProvider';
import type { FileItem } from './dock-tabs';

const shot: FileItem = { kind: 'image', name: 'shot.png', url: 'blob:shot' };

// Every file body fetches its bytes on mount; hold those requests open so the bodies stay in their
// loading state and the chrome under test is the only thing that renders.
beforeAll(() => { vi.stubGlobal('fetch', () => new Promise(() => {})); });

function Harness(): JSX.Element {
  const dock = useDock();
  return (
    <>
      <button data-action="web" onClick={dock.openWeb} />
      <button data-action="hide" onClick={dock.closeDock} />
      <button data-action="file" onClick={() => dock.openFile(shot)} />
      <DockPane />
    </>
  );
}

function mount(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<ThemeProvider><DockProvider><Harness /></DockProvider></ThemeProvider>); });
  return renderer;
}

function action(renderer: ReactTestRenderer, name: string): void {
  act(() => renderer.root.findByProps({ 'data-action': name }).props.onClick());
}

/** Every tab body stays mounted, so a query for "the address bar" has to mean the VISIBLE one. */
function activeBody(renderer: ReactTestRenderer) {
  return renderer.root.findAll((node) => node.props['data-dock-tab-body'] !== undefined)
    .find((node) => node.props.style.display !== 'none')!;
}

function input(renderer: ReactTestRenderer) {
  return activeBody(renderer).findByType('input');
}

function viewport(renderer: ReactTestRenderer) {
  return activeBody(renderer).findByType('select');
}

function navigate(renderer: ReactTestRenderer, url: string): void {
  act(() => input(renderer).props.onChange({ target: { value: url } }));
  act(() => input(renderer).props.onKeyDown({ key: 'Enter' }));
}

function tabIds(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAll((node) => node.props['data-dock-tab'] !== undefined)
    .map((node) => node.props['data-dock-tab'] as string);
}

function bodyIds(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAll((node) => node.props['data-dock-tab-body'] !== undefined)
    .map((node) => node.props['data-dock-tab-body'] as string);
}

/** The toggle's host span — `findByProps` would otherwise also match the component that renders it. */
function bodyDisplay(renderer: ReactTestRenderer, id: string): string {
  return renderer.root.findByProps({ 'data-dock-tab-body': id }).props.style.display;
}

describe('DockPane tab lifetime', () => {
  it('hides rather than unmounting a web frame across a file switch and a dock close', () => {
    const renderer = mount();
    action(renderer, 'web');
    navigate(renderer, 'http://127.0.0.1:5173/');
    const frame = renderer.root.findByProps({ 'data-browser-frame': 'browser-tab-0' });

    action(renderer, 'file');
    expect(bodyDisplay(renderer, 'browser-tab-0')).toBe('none');
    expect(renderer.root.findByProps({ 'data-browser-frame': 'browser-tab-0' })).toBe(frame);

    action(renderer, 'hide');
    expect(renderer.root.findByProps({ 'data-pane': 'dock' }).props.style.display).toBe('none');
    expect(renderer.root.findByProps({ 'data-browser-frame': 'browser-tab-0' })).toBe(frame);

    action(renderer, 'web');
    expect(renderer.root.findByProps({ 'data-pane': 'dock' }).props.style.display).toBe('flex');
    expect(renderer.root.findByProps({ 'data-browser-frame': 'browser-tab-0' })).toBe(frame);
  });

  it('reorders tab chrome without moving live bodies', () => {
    const renderer = mount();
    action(renderer, 'web');
    navigate(renderer, 'http://127.0.0.1:5173/');
    action(renderer, 'web');
    navigate(renderer, 'http://127.0.0.1:3000/');
    const firstFrame = renderer.root.findByProps({ 'data-browser-frame': 'browser-tab-0' });
    const secondFrame = renderer.root.findByProps({ 'data-browser-frame': 'browser-tab-1' });

    act(() => renderer.root.findByType(Reorder.Group).props.onReorder(['browser-tab-1', 'browser-tab-0']));

    expect(tabIds(renderer)).toEqual(['browser-tab-1', 'browser-tab-0']);
    expect(bodyIds(renderer)).toEqual(['browser-tab-0', 'browser-tab-1']);
    expect(renderer.root.findByProps({ 'data-browser-frame': 'browser-tab-0' })).toBe(firstFrame);
    expect(renderer.root.findByProps({ 'data-browser-frame': 'browser-tab-1' })).toBe(secondFrame);
  });

  it('keeps address drafts and viewport choices independent per web tab', () => {
    const renderer = mount();
    action(renderer, 'web');
    navigate(renderer, 'http://127.0.0.1:5173/');
    act(() => viewport(renderer).props.onChange({ target: { value: 'phone' } }));
    action(renderer, 'web');
    act(() => input(renderer).props.onChange({ target: { value: 'draft-b' } }));
    act(() => viewport(renderer).props.onChange({ target: { value: 'desktop' } }));

    act(() => renderer.root.findByProps({ 'data-dock-tab': 'browser-tab-0' }).props.onClick());
    expect(input(renderer).props.value).toBe('http://127.0.0.1:5173/');
    expect(viewport(renderer).props.value).toBe('phone');
    act(() => renderer.root.findByProps({ 'data-dock-tab': 'browser-tab-1' }).props.onClick());
    expect(input(renderer).props.value).toBe('draft-b');
    expect(viewport(renderer).props.value).toBe('desktop');
  });
});
