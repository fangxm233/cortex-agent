import { describe, expect, it } from 'vitest';
import { mediaKindOf, isPreviewable } from './media-kind';

describe('mediaKindOf', () => {
  it('maps image/video to their kind', () => {
    expect(mediaKindOf('image')).toBe('image');
    expect(mediaKindOf('video')).toBe('video');
  });
  it('maps a plain file to null', () => {
    expect(mediaKindOf('file')).toBeNull();
  });
});

describe('isPreviewable', () => {
  it('is true for image and video, false for file', () => {
    expect(isPreviewable('image')).toBe(true);
    expect(isPreviewable('video')).toBe(true);
    expect(isPreviewable('file')).toBe(false);
  });
});
