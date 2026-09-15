// input:  a local file a Feishu send is about to carry
// output: an image_key when Feishu can show it inline in the chat, null when it has to go as a file
// pos:    platform/adapters — shared by the Feishu adapter's `uploadFile` and the `feishu_send_file`
//         MCP tool, the two independent implementations of "send this file to Feishu". Both used to
//         call `im/v1/files` unconditionally, so a screenshot the agent produced arrived as a
//         download card: the user had to tap it to see their own picture, and it never previewed in
//         a notification or on mobile. `im/v1/images` was never called at all.

import { createReadStream, promises as fs } from 'fs';
import { sniffImageMime } from '@core/media-types.js';
import { createLogger } from '@core/log.js';

const log = createLogger('feishu-image');

/** Feishu rejects an image upload above 10 MB (im/v1/images). Anything larger goes as a file. */
export const FEISHU_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Bytes read to identify the file's real type. */
const SNIFF_BYTES = 16;

/** The formats Feishu renders inline in a chat. Deliberately a subset of what it accepts: a format
 *  we cannot identify from its first bytes is safer as a file than as a rejected upload. */
const INLINE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);

/** Just enough of the Lark client to upload an image — the adapter's `lark.Client` and the MCP
 *  module's `LarkClient` are different types over the same endpoint. */
interface ImageUploadClient {
  im: { v1: { image: { create(req: { data: { image_type: string; image: unknown } }): Promise<unknown> } } };
}

/**
 * The mime Feishu would show inline for this file, or null when it must be sent as a file.
 *
 * Decided from the bytes, not the extension: the agent writes `chart.png` with whatever its plotting
 * library produced, and a mislabelled file that is uploaded as an image is rejected by the API.
 */
export async function inlineImageMime(filePath: string, size: number): Promise<string | null> {
  if (!(size > 0) || size > FEISHU_IMAGE_MAX_BYTES) return null;
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0);
    const mime = sniffImageMime(buf.subarray(0, bytesRead));
    return mime && INLINE_IMAGE_MIMES.has(mime) ? mime : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Upload `filePath` as a chat image and return its `image_key`, or null when the caller should send
 * it as a file instead.
 *
 * Null is the ordinary outcome for a non-image, an oversized image — and for an upload the app is
 * not allowed to make: `im/v1/images` needs the `im:resource` scope, which an app registered before
 * Cortex ever sent an image will not have. A missing scope must degrade to the previous behaviour,
 * never lose the send.
 */
export async function uploadFeishuImage(
  client: unknown, filePath: string, size: number,
): Promise<string | null> {
  if (!(await inlineImageMime(filePath, size))) return null;
  try {
    const res = await (client as ImageUploadClient).im.v1.image.create({
      data: { image_type: 'message', image: createReadStream(filePath) },
    }) as { code?: number; msg?: string; data?: { image_key?: string }; image_key?: string } | null;
    if (res && typeof res.code === 'number' && res.code !== 0) {
      throw new Error(`Feishu API error ${res.code}: ${res.msg ?? 'unknown'}`);
    }
    const key = res?.data?.image_key ?? res?.image_key;
    if (key) return key;
    log.warn(`image upload returned no image_key for ${filePath}; sending it as a file`);
  } catch (e) {
    log.warn(`image upload failed for ${filePath} (${(e as Error).message}); sending it as a file`);
  }
  return null;
}
