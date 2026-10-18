import type { AttachmentMeta } from './types';
import { formatBytes } from '@/lib/format';

export function formatAttachmentSize(bytes: number): string {
  return formatBytes(bytes, { fractionDigits: 1, maxUnit: 'MB' });
}

export function attachmentFileExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toUpperCase().slice(0, 4) : 'FILE';
}

export function attachmentTypeColor(type: AttachmentMeta['type']): { bg: string; fg: string } {
  if (type === 'image') return { bg: 'var(--proto-accent-bg)', fg: 'var(--proto-accent)' };
  if (type === 'video') return { bg: 'var(--proto-danger-bg)', fg: 'var(--proto-danger)' };
  return { bg: 'var(--proto-gray)', fg: 'var(--proto-muted)' };
}

export interface AttachmentKindWords {
  image: string;
  video: string;
  file: string;
}

/** The type word a quiet attachment row shows before the size: a localized word for pictures and
 *  videos, which read as what they are, and the extension for everything else ("CSV", "PDF"), which
 *  is how people name a document. A name with no extension falls back to the generic word. */
export function attachmentKindLabel(type: AttachmentMeta['type'], name: string, words: AttachmentKindWords): string {
  if (type === 'image') return words.image;
  if (type === 'video') return words.video;
  return name.lastIndexOf('.') > 0 ? attachmentFileExt(name) : words.file;
}
