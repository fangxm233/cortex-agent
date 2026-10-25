import { mediaKindOf } from './media-kind';
import type { AttachmentMeta } from '@/features/attachments/types';
import type { MediaItem } from './preview-item';

// One message's attachments as the lightbox group they open into: its images and videos, in order.

type MediaSource = Pick<AttachmentMeta, 'type' | 'name' | 'path'>;

export function attachmentMediaGroup(attachments: readonly MediaSource[]): MediaItem[] {
  return attachments.flatMap((a) => {
    const kind = mediaKindOf(a.type);
    return kind ? [{ kind, name: a.name, path: a.path }] : [];
  });
}

/** The group's entry for `a` — the item the lightbox opens on. */
export function groupMember(group: readonly MediaItem[], a: MediaSource): MediaItem {
  return group.find((item) => item.path === a.path) ?? { kind: mediaKindOf(a.type) ?? 'image', name: a.name, path: a.path };
}
