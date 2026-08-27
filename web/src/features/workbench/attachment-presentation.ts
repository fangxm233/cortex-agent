// input:  Shared chat attachment names, sizes, and semantic types
// output: Stable file labels, byte labels, and type token colors
// pos:    Reusable attachment presentation helpers for workbench surfaces
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { AttachmentMeta } from './chat-content';

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
