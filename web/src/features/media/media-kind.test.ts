import { describe, expect, it } from 'vitest';
import { mediaKindOf } from './media-kind';

describe('mediaKindOf', () => {
  it('maps image/video to their kind', () => {
    expect(mediaKindOf('image')).toBe('image');
    expect(mediaKindOf('video')).toBe('video');
  });
  it('maps a plain file to null', () => {
    expect(mediaKindOf('file')).toBeNull();
  });
});
