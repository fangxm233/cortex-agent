// input:  pending updates, focused element shapes, and focusout events
// output: shared typing gate classification and deferred prompt surfacing
// pos:    Headless update focus-gating specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isEditableTarget, useUpdateGating } from './useUpdateGating';

function mockEl(tagName: string, extra: Record<string, unknown> = {}): Element {
  return { tagName, ...extra } as unknown as Element;
}

let activeElement: Element | null;
let focusOut: (() => void) | null;
let shown: string | null;
function Probe({ pending }: { pending: string | null }) {
  shown = useUpdateGating(pending);
  return null;
}

beforeEach(() => {
  activeElement = null;
  focusOut = null;
  shown = null;
  vi.stubGlobal('document', {
    get activeElement() { return activeElement; },
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === 'focusout') focusOut = listener;
    }),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('window', { setTimeout: (callback: () => void) => callback() });
});

describe('isEditableTarget', () => {
  it('only guards text-editing surfaces', () => {
    expect(isEditableTarget(mockEl('TEXTAREA'))).toBe(true);
    expect(isEditableTarget(mockEl('INPUT', { type: 'search' }))).toBe(true);
    expect(isEditableTarget(mockEl('INPUT', { type: 'checkbox' }))).toBe(false);
    expect(isEditableTarget(mockEl('DIV', { isContentEditable: true }))).toBe(true);
    expect(isEditableTarget(mockEl('BUTTON'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('useUpdateGating', () => {
  it('defers a pending update until focus leaves the editor', () => {
    activeElement = mockEl('TEXTAREA');
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<Probe pending="b7e2" />); });
    expect(shown).toBeNull();

    activeElement = mockEl('DIV');
    act(() => focusOut?.());
    expect(shown).toBe('b7e2');

    act(() => renderer.update(<Probe pending={null} />));
    expect(shown).toBeNull();
  });
});
