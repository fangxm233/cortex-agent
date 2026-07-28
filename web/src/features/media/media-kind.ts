// input:  shared attachment type
// output: media-lightbox kind or null
// pos:    Pure classifier shared by desktop and mobile attachment surfaces
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

export type MediaKind = 'image' | 'video';

/** Attachment `type` → previewable media kind, or null (plain file). Accepts the shared union used by
 *  both `AttachmentMeta` (chat-content) and `Attachment` (transcript-vm). */
export function mediaKindOf(type: 'image' | 'video' | 'file'): MediaKind | null {
  if (type === 'image') return 'image';
  if (type === 'video') return 'video';
  return null;
}
