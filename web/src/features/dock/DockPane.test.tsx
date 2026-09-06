// input:  dock actions over mixed file and web tabs, plus theme
// output: tab-body lifetime, isolation and mixed-kind switching regressions
// pos:    Focused component test for the docked tab pane
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Reorder } from 'motion/react';
import { describe, expect, it } from 'vitest';
import { ThemeProvider } from '@/theme';
import { DockPane } from './DockPane';
import { DockProvider, useDock } from './DockProvider';
import type { FileItem } from './dock-tabs';

const shot: FileItem = { kind: 'image', name: 'shot.png', url: 'blob:shot' };
const other: FileItem = { kind: 'image', name: 'other.png', url: 'blob:other' };

function Harness(): JSX.Element {
  const dock = useDock();
  return (
    <>
      <button data-action="web" onClick={dock.openWeb} />
      <button data-action="hide" onClick={dock.closeDock} />
      <button data-action="file" onClick={() => dock.openFile(shot)} />
      <button data-action="file-again" onClick={() => dock.openFile(shot)} />
      <button data-action="other-file" onClick={() => dock.openFile(other)} />
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

describe('DockPane mixed tabs', () => {
  it('holds file previews and web pages as siblings in one strip', () => {
    const renderer = mount();
    action(renderer, 'file');
    action(renderer, 'web');
    action(renderer, 'other-file');

    expect(tabIds(renderer)).toEqual(['dock-file-0', 'browser-tab-1', 'dock-file-2']);
    const kinds = renderer.root.findAll((node) => node.props['data-tab-kind'] !== undefined)
      .map((node) => node.props['data-tab-kind'] as string);
    expect(kinds).toEqual(['file', 'web', 'file']);
    expect(bodyDisplay(renderer, 'dock-file-2')).toBe('flex');
    expect(bodyDisplay(renderer, 'dock-file-0')).toBe('none');
    expect(bodyDisplay(renderer, 'browser-tab-1')).toBe('none');
  });

  it('focuses the tab already holding a file rather than opening a second one', () => {
    const renderer = mount();
    action(renderer, 'file');
    action(renderer, 'other-file');
    action(renderer, 'file-again');

    expect(tabIds(renderer)).toEqual(['dock-file-0', 'dock-file-1']);
    expect(bodyDisplay(renderer, 'dock-file-0')).toBe('flex');
  });

  it('reuses a blank web tab instead of stacking empty ones', () => {
    const renderer = mount();
    action(renderer, 'web');
    action(renderer, 'web');
    expect(tabIds(renderer)).toEqual(['browser-tab-0']);
  });

  it('stays open on its empty hint after the last tab closes', () => {
    const renderer = mount();
    action(renderer, 'file');
    act(() => renderer.root.findByProps({ 'data-close-tab': 'dock-file-0' }).props.onClick());

    // The strip's exit animation outlives the state change, so the chrome lingers disabled —
    // what must be gone immediately is the body.
    expect(renderer.root.findByProps({ 'data-close-tab': 'dock-file-0' }).props.disabled).toBe(true);
    expect(bodyIds(renderer)).toEqual([]);
    expect(renderer.root.findByProps({ 'data-pane': 'dock' }).props.style.display).toBe('flex');
  });

  it('renders nothing at all once the dock is closed and holds no tabs', () => {
    const renderer = mount();
    action(renderer, 'hide');
    expect(renderer.root.findAllByProps({ 'data-pane': 'dock' })).toHaveLength(0);
  });
});
