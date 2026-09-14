export type MediaKind = 'image' | 'video';

/** Attachment `type` → previewable media kind, or null (plain file). Accepts the shared union used by
 *  both `AttachmentMeta` (chat-content) and `Attachment` (transcript-vm). */
export function mediaKindOf(type: 'image' | 'video' | 'file' | 'view'): MediaKind | null {
  if (type === 'image') return 'image';
  if (type === 'video') return 'video';
  return null;
}
