import { describe, expect, it } from 'vitest';
import { isEditableTarget } from './useHotUpdate';

// vitest runs in the node environment here (no jsdom), so we exercise the pure gate over lightweight
// element-shaped mocks rather than real DOM nodes — it only reads tagName / type / isContentEditable.
function mockEl(tagName: string, extra: Record<string, unknown> = {}): Element {
  return { tagName, ...extra } as unknown as Element;
}

describe('isEditableTarget', () => {
  it('guards textareas and text inputs', () => {
    expect(isEditableTarget(mockEl('TEXTAREA'))).toBe(true);
    expect(isEditableTarget(mockEl('INPUT', { type: 'text' }))).toBe(true);
    expect(isEditableTarget(mockEl('INPUT', { type: 'search' }))).toBe(true);
    // An input with no explicit type defaults to text entry.
    expect(isEditableTarget(mockEl('INPUT', { type: '' }))).toBe(true);
  });

  it('does not guard non-text inputs', () => {
    expect(isEditableTarget(mockEl('INPUT', { type: 'checkbox' }))).toBe(false);
    expect(isEditableTarget(mockEl('INPUT', { type: 'button' }))).toBe(false);
    expect(isEditableTarget(mockEl('INPUT', { type: 'range' }))).toBe(false);
  });

  it('guards contenteditable elements', () => {
    expect(isEditableTarget(mockEl('DIV', { isContentEditable: true }))).toBe(true);
  });

  it('does not guard plain elements or null', () => {
    expect(isEditableTarget(mockEl('DIV', { isContentEditable: false }))).toBe(false);
    expect(isEditableTarget(mockEl('BUTTON'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
