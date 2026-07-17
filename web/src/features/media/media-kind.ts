// Pure helper shared by every image/video surface (composer preview, sent user message, agent-sent
// files) on web + mobile. Maps an attachment `type` to the kind the media lightbox can present
// inline — 'image' | 'video' — or null for a plain file that is not previewable.

export type MediaKind = 'image' | 'video';

/** Attachment `type` → previewable media kind, or null (plain file). Accepts the shared union used by
 *  both `AttachmentMeta` (chat-content) and `Attachment` (transcript-vm). */
export function mediaKindOf(type: 'image' | 'video' | 'file'): MediaKind | null {
  if (type === 'image') return 'image';
  if (type === 'video') return 'video';
  return null;
}

/** True when the attachment type can be opened in the media lightbox (image or video). */
export function isPreviewable(type: 'image' | 'video' | 'file'): boolean {
  return mediaKindOf(type) !== null;
}
