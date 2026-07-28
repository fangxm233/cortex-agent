import { describe, it, expect } from 'vitest';
import {
  clampPreviewSplit,
  isDocPreviewItem,
  parsePreviewPinned,
  parsePreviewSplit,
  previewDownloadPath,
  splitFromDrag,
  PREVIEW_SPLIT_DEFAULT,
  PREVIEW_SPLIT_MAX,
  PREVIEW_SPLIT_MIN,
  type PreviewItem,
} from './pinned-preview';

const img: PreviewItem = { kind: 'image', name: 'shot.png', path: 'workspace/shot.png' };
const localImg: PreviewItem = { kind: 'image', name: 'local.png', url: 'blob:local' };
const pdf: PreviewItem = { kind: 'pdf', name: 'paper.pdf', path: 'workspace/paper.pdf' };

describe('clampPreviewSplit', () => {
  it('keeps a ratio inside the allowed band', () => {
    expect(clampPreviewSplit(0.5)).toBe(0.5);
    expect(clampPreviewSplit(0.4)).toBe(0.4);
  });
  it('clamps below/above the band to its edges', () => {
    expect(clampPreviewSplit(0.01)).toBe(PREVIEW_SPLIT_MIN);
    expect(clampPreviewSplit(0.99)).toBe(PREVIEW_SPLIT_MAX);
  });
  it('falls back to the default for non-finite input', () => {
    expect(clampPreviewSplit(Number.NaN)).toBe(PREVIEW_SPLIT_DEFAULT);
    expect(clampPreviewSplit(Number.POSITIVE_INFINITY)).toBe(PREVIEW_SPLIT_DEFAULT);
  });
});

describe('parsePreviewSplit', () => {
  it('reads a stored ratio', () => {
    expect(parsePreviewSplit('0.42')).toBe(0.42);
  });
  it('defaults on a missing / unparseable value', () => {
    expect(parsePreviewSplit(null)).toBe(PREVIEW_SPLIT_DEFAULT);
    expect(parsePreviewSplit('')).toBe(PREVIEW_SPLIT_DEFAULT);
    expect(parsePreviewSplit('wide')).toBe(PREVIEW_SPLIT_DEFAULT);
  });
  it('clamps an out-of-band stored ratio', () => {
    expect(parsePreviewSplit('0.98')).toBe(PREVIEW_SPLIT_MAX);
  });
});

describe('parsePreviewPinned', () => {
  it('only "1" restores the pinned mode', () => {
    expect(parsePreviewPinned('1')).toBe(true);
    expect(parsePreviewPinned('0')).toBe(false);
    expect(parsePreviewPinned(null)).toBe(false);
    expect(parsePreviewPinned('true')).toBe(false);
  });
});

describe('splitFromDrag', () => {
  // The divider sits on the LEFT edge of the preview pane: dragging it left widens the preview.
  it('derives the preview share from the pointer inside the region', () => {
    // region x∈[300,1300); pointer at 800 → preview takes the right half.
    expect(splitFromDrag(300, 1000, 800)).toBeCloseTo(0.5, 5);
  });
  it('keeps a pointer dragged past either edge within the usable ratio band', () => {
    expect(splitFromDrag(300, 1000, 0)).toBeLessThanOrEqual(PREVIEW_SPLIT_MAX);
    expect(splitFromDrag(300, 1000, 5000)).toBeGreaterThanOrEqual(PREVIEW_SPLIT_MIN);
  });
  it('defaults when the region has no measurable width', () => {
    expect(splitFromDrag(300, 0, 800)).toBe(PREVIEW_SPLIT_DEFAULT);
  });
});

describe('isDocPreviewItem', () => {
  it('separates pdf/text documents from image/video media', () => {
    expect(isDocPreviewItem(pdf)).toBe(true);
    expect(isDocPreviewItem({ kind: 'text', name: 'a.md', path: 'workspace/a.md' })).toBe(true);
    expect(isDocPreviewItem(img)).toBe(false);
    expect(isDocPreviewItem({ kind: 'video', name: 'v.mp4', path: 'workspace/v.mp4' })).toBe(false);
  });
});

describe('previewDownloadPath', () => {
  it('returns the workspace path when there is one', () => {
    expect(previewDownloadPath(img)).toBe('workspace/shot.png');
    expect(previewDownloadPath(pdf)).toBe('workspace/paper.pdf');
  });
  it('returns null for a local composer preview (object URL, no workspace file yet)', () => {
    expect(previewDownloadPath(localImg)).toBeNull();
  });
});
