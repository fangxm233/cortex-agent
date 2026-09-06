// input:  dock actions over mixed file and web tabs, plus theme
// output: tab-body lifetime, isolation and mixed-kind switching regressions
// pos:    Focused component test for the docked tab pane
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Reorder } from 'motion/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/theme';
import { DockPane } from './DockPane';
import { DockProvider, useDock } from './DockProvider';
import type { FileItem } from './dock-tabs';

const shot: FileItem = { kind: 'image', name: 'shot.png', url: 'blob:shot' };
const other: FileItem = { kind: 'image', name: 'other.png', url: 'blob:other' };
const saved: FileItem = { kind: 'image', name: 'saved.png', path: 'workspace/runs/saved.png' };
const notes: FileItem = { kind: 'text', name: 'notes.md', path: 'workspace/knowledge/notes.md' };
const log: FileItem = { kind: 'text', name: 'run.log', path: 'workspace/run.log' };

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
      <button data-action="file-again" onClick={() => dock.openFile(shot)} />
      <button data-action="other-file" onClick={() => dock.openFile(other)} />
      <button data-action="saved-file" onClick={() => dock.openFile(saved)} />
      <button data-action="markdown" onClick={() => dock.openFile(notes)} />
      <button data-action="log" onClick={() => dock.openFile(log)} />
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
function sourceToggles(renderer: ReactTestRenderer) {
  return renderer.root.findAll((node) => node.type === 'span' && node.props['data-file-source-toggle'] !== undefined);
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

describe('DockPane file chrome', () => {
  it('puts the path and the download inside the body, not on the shared strip', () => {
    const renderer = mount();
    action(renderer, 'saved-file');

    expect(renderer.root.findByProps({ 'data-file-path': 'workspace/runs/saved.png' })).toBeTruthy();
    expect(renderer.root.findAllByProps({ 'data-file-download': '' })).toHaveLength(1);
    // The strip keeps only the dock-wide close.
    const strip = renderer.root.findByProps({ 'data-close-dock': '' });
    expect(strip.parent!.findAllByProps({ 'data-file-download': '' })).toHaveLength(0);
  });

  it('gives a file with no workspace path no bar to show', () => {
    const renderer = mount();
    action(renderer, 'file');
    expect(renderer.root.findAllByProps({ 'data-file-download': '' })).toHaveLength(0);
  });

  it('offers a source toggle for Markdown only, and flips its label', () => {
    const renderer = mount();
    action(renderer, 'log');
    expect(sourceToggles(renderer)).toHaveLength(0);

    action(renderer, 'markdown');
    expect(sourceToggles(renderer)[0]!.props.children).toBe('Source');
    act(() => sourceToggles(renderer)[0]!.props.onClick());
    expect(sourceToggles(renderer)[0]!.props.children).toBe('Rendered');
    expect(sourceToggles(renderer)[0]!.props['aria-pressed']).toBe(true);
  });

  it('keeps each file tab\u2019s source toggle to itself', () => {
    const renderer = mount();
    action(renderer, 'markdown');
    act(() => sourceToggles(renderer)[0]!.props.onClick());
    action(renderer, 'log');
    action(renderer, 'markdown');
    expect(sourceToggles(renderer)[0]!.props.children).toBe('Rendered');
  });
});
