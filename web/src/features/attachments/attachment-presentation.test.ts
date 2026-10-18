import { describe, expect, it } from 'vitest';
import { attachmentKindLabel } from './attachment-presentation';

const words = { image: 'Image', video: 'Video', file: 'File' };

describe('attachment kind label', () => {
  it('names pictures and videos with a word and documents by their extension', () => {
    expect(attachmentKindLabel('image', 'robustness.png', words)).toBe('Image');
    expect(attachmentKindLabel('video', 'rollout.mp4', words)).toBe('Video');
    expect(attachmentKindLabel('file', 'sweep-results.csv', words)).toBe('CSV');
    expect(attachmentKindLabel('view', 'report.html', words)).toBe('HTML');
  });

  it('falls back to the generic word when the name has no extension', () => {
    expect(attachmentKindLabel('file', 'Makefile', words)).toBe('File');
    expect(attachmentKindLabel('file', '.env', words)).toBe('File');
  });
});
