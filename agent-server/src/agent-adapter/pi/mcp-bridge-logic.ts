/** Load platform-specific tools only for sessions originating from that platform. */
export function shouldLoadSlack(channel: string | undefined): boolean {
  return !!channel && channel.startsWith('slack:');
}

export function shouldLoadFeishu(channel: string | undefined): boolean {
  return !!channel && channel.startsWith('feishu:');
}

export function shouldLoadWeb(channel: string | undefined): boolean {
  return !!channel && channel.startsWith('web:');
}

export function shouldLoadThreadControl(threadId: string | undefined): boolean {
  return !!threadId;
}

type PiTextContent = { type: 'text'; text: string };
type PiImageContent = { type: 'image'; data: string; mimeType: string };
export type PiContent = PiTextContent | PiImageContent;

/** The inline image types every PI provider adapter can encode (`pi-ai` normalizes to exactly
 *  these). Anything else reaching a provider is a 400, so an unknown type stays a text note. */
const PI_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** The provider-safe form of `mimeType`, or null when PI cannot send it inline. */
function inlineImageMime(mimeType: string | undefined): string | null {
  if (!mimeType) return null;
  const base = mimeType.split(';')[0]?.trim().toLowerCase();
  if (!base) return null;
  const normalized = base === 'image/jpg' ? 'image/jpeg' : base;
  return PI_IMAGE_MIMES.has(normalized) ? normalized : null;
}

/** An image block PI will carry to the model, or null to fall back to a text description.
 *  A model without vision needs no guard here: `pi-ai` downgrades image blocks to a placeholder
 *  before the request is built (transform-messages.ts, `downgradeUnsupportedImages`). */
function inlineImage(data: string | undefined, mimeType: string | undefined): PiImageContent | null {
  const mime = inlineImageMime(mimeType);
  if (!mime || typeof data !== 'string' || data.length === 0) return null;
  return { type: 'image', data, mimeType: mime };
}

/** Map an MCP content item into PI content without silently dropping unsupported payloads.
 *  Images pass through as image blocks — PI tool results carry `(TextContent | ImageContent)[]`
 *  natively, so `remote_read` and any other image-returning MCP tool stay visible to a vision
 *  model. Only what PI cannot send inline degrades to a description. */
export function mapMcpContent(item: {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { uri?: string; text?: string; blob?: string; mimeType?: string };
  [key: string]: unknown;
}): PiContent {
  if (item.type === 'text' && typeof item.text === 'string') {
    return { type: 'text', text: item.text };
  }
  if (item.type === 'image') {
    const image = inlineImage(item.data, item.mimeType);
    if (image) return image;
    const len = typeof item.data === 'string' ? item.data.length : 0;
    return { type: 'text', text: `[Image: mimeType=${item.mimeType ?? 'unknown'}, base64(${len} chars)]` };
  }
  if (item.type === 'resource' && item.resource) {
    const resource = item.resource;
    if (typeof resource.text === 'string') return { type: 'text', text: resource.text };
    if (typeof resource.blob === 'string') {
      const image = inlineImage(resource.blob, resource.mimeType);
      if (image) return image;
      return {
        type: 'text',
        text: `[Binary resource: uri=${resource.uri ?? 'unknown'}, mimeType=${resource.mimeType ?? 'unknown'}]`,
      };
    }
  }
  return { type: 'text', text: JSON.stringify(item) };
}
