import type { ToolResultImage } from '@core/types/agent-types.js';

/**
 * The inline images in one tool result's content blocks, in order.
 *
 * Two spellings reach Cortex: the Anthropic block Claude Code prints
 * (`{type:'image', source:{type:'base64', media_type, data}}`) and PI's own
 * (`{type:'image', data, mimeType}`). URL-sourced images carry no bytes and are skipped.
 */
export function toolResultImages(content: unknown): ToolResultImage[] {
  if (!Array.isArray(content)) return [];
  const images: ToolResultImage[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'image') continue;
    const image = block as { data?: unknown; mimeType?: unknown; source?: Record<string, unknown> };
    const source = image.source;
    if (source && source.type === 'base64' && typeof source.data === 'string' && source.data) {
      images.push({ mimeType: typeof source.media_type === 'string' ? source.media_type : '', data: source.data });
    } else if (typeof image.data === 'string' && image.data) {
      images.push({ mimeType: typeof image.mimeType === 'string' ? image.mimeType : '', data: image.data });
    }
  }
  return images;
}

/** Shape guard for an already-extracted image (a forwarded subagent notice). */
export function isToolResultImage(value: unknown): value is ToolResultImage {
  if (!value || typeof value !== 'object') return false;
  const image = value as Record<string, unknown>;
  return typeof image.mimeType === 'string' && typeof image.data === 'string' && image.data.length > 0;
}
