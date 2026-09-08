// input:  File-drop hook, DOM target and drag events
// output: Pane-wide file acceptance and non-file drag checks
// pos:    Desktop chat drop-target behavior specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { useFileDropTarget } from './useFileDropTarget';

type DragListener = (event: DragEvent) => void;

function fakeTarget(): { target: HTMLElement; listeners: Map<string, DragListener> } {
  const listeners = new Map<string, DragListener>();
  const target = {
    addEventListener: vi.fn((name: string, listener: DragListener) => listeners.set(name, listener)),
    removeEventListener: vi.fn((name: string) => listeners.delete(name)),
  } as unknown as HTMLElement;
  return { target, listeners };
}

function dragEvent(types: string[], files: File[] = []): DragEvent {
  return {
    dataTransfer: { types, items: { length: files.length }, files, dropEffect: 'none' },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as DragEvent;
}

function DropHarness({ target, onFiles }: {
  target: HTMLElement;
  onFiles: (files: FileList) => void;
}): JSX.Element {
  const state = useFileDropTarget({ current: target }, onFiles);
  return <div data-drop-state data-active={state.active} data-count={state.fileCount} />;
}

describe('useFileDropTarget', () => {
  it('accepts files anywhere on the supplied chat-pane target', () => {
    const { target, listeners } = fakeTarget();
    const onFiles = vi.fn();
    const files = [{ name: 'one.txt' }, { name: 'two.png' }] as File[];
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<DropHarness target={target} onFiles={onFiles} />); });

    const enter = dragEvent(['Files'], files);
    act(() => listeners.get('dragenter')!(enter));
    expect(renderer.root.findByProps({ 'data-drop-state': true }).props).toMatchObject({
      'data-active': true, 'data-count': 2,
    });
    expect(enter.preventDefault).toHaveBeenCalledOnce();

    const drop = dragEvent(['Files'], files);
    act(() => listeners.get('drop')!(drop));
    expect(onFiles).toHaveBeenCalledWith(files);
    expect(renderer.root.findByProps({ 'data-drop-state': true }).props['data-active']).toBe(false);
    act(() => renderer.unmount());
  });

  it('leaves non-file drags untouched', () => {
    const { target, listeners } = fakeTarget();
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<DropHarness target={target} onFiles={vi.fn()} />); });

    const enter = dragEvent(['text/plain']);
    act(() => listeners.get('dragenter')!(enter));
    expect(enter.preventDefault).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ 'data-drop-state': true }).props['data-active']).toBe(false);
    act(() => renderer.unmount());
  });
});
