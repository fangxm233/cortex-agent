import * as path from 'path';
import { promises as fs } from 'fs';
import { WORKSPACE_DIR } from '@core/paths.js';
import { imageMimeExtension, sniffImageMime } from '@core/media-types.js';
import type { AttachmentMeta, ToolResultImage } from '@core/types/agent-types.js';

/** Physical directory backing the UI-relative `workspace/tool-images/` prefix: one subdirectory
 *  per session, removed by the retention sweep once the session is gone. */
export const TOOL_IMAGES_DIR = path.join(WORKSPACE_DIR, 'tool-images');

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_') || '_';
}

/** The directory name a session's tool images live under. */
export function toolImageSessionDir(sessionId: string): string {
  return safeSegment(sessionId);
}

/**
 * Write the images one tool call returned under `tool-images/<sessionId>/<toolUseId>-<n>.<ext>` and
 * describe them as image attachments. The bytes decide the type (a declared mime can lie); anything
 * that is not a recognisable image is skipped rather than served under a guessed one.
 */
export async function writeToolImages(
  sessionId: string,
  toolUseId: string,
  images: readonly ToolResultImage[],
  root: string = TOOL_IMAGES_DIR,
): Promise<AttachmentMeta[]> {
  const sessionDir = toolImageSessionDir(sessionId);
  const dir = path.join(root, sessionDir);
  const stem = safeSegment(toolUseId);
  const written: AttachmentMeta[] = [];
  for (const [index, image] of images.entries()) {
    const bytes = Buffer.from(image.data, 'base64');
    const mimeType = sniffImageMime(bytes.subarray(0, 16)) ?? image.mimeType;
    const ext = imageMimeExtension(mimeType);
    if (!ext || bytes.length === 0) continue;
    if (written.length === 0) await fs.mkdir(dir, { recursive: true });
    const name = `${stem}-${index}${ext}`;
    await fs.writeFile(path.join(dir, name), bytes);
    written.push({
      name, path: `workspace/tool-images/${sessionDir}/${name}`, size: bytes.length, mimeType, type: 'image',
    });
  }
  return written;
}
