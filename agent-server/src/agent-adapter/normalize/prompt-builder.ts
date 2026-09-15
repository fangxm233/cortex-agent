import { IMAGE_MIMES, VIDEO_MIMES } from '@core/media-types.js';
import * as path from 'path';

/** Exactly `UserMessage['attachments']` element shape (D6): the attachment travels from the
 *  RunRequest to the prompt without an intermediate per-backend form. */
export interface FileAttachment {
  mimeType: string;
  path: string;
  /** What the user called the file. Optional: an attachment that never had a name (a pasted
   *  image) is described by its path alone. Carried separately from `path` because the stored
   *  name is ASCII-folded and de-duplicated, so the path is not the name. */
  name?: string;
}

/** An attachment the platform would not hand over, named so the model does not answer as if the
 *  user had sent nothing. */
export interface FailedAttachment {
  name: string;
  reason: string;
}

/** The block that names attachments the platform would not hand over, or '' when none did.
 *  Exported because the conversation path composes its prompt text itself and must be able to
 *  fold the same notice in — an attachment that failed to download used to be logged and then
 *  silently forgotten, leaving the agent to answer as if the user had sent nothing. */
export function formatAttachmentFailures(failures: FailedAttachment[]): string {
  if (failures.length === 0) return '';
  const list = failures.map(f => `${f.name} (${f.reason})`).join('\n');
  return `[${failures.length} attachment(s) the user sent could NOT be downloaded and are `
    + `unavailable to you. Say so rather than answering as if they had not been sent:\n${list}\n]\n\n`;
}

/** `path` for a file stored under its own name; `path (name)` when the two differ. */
function describe(file: FileAttachment): string {
  const p = file.path.replace(/\\/g, '/');
  const name = file.name?.trim();
  return name && name !== path.basename(p) ? `${p} (${name})` : p;
}

export function buildPrompt(
  userMessage: string,
  files: FileAttachment[],
  failures: FailedAttachment[] = [],
): string {
  if (files.length === 0 && failures.length === 0) return userMessage;
  const imageFiles = files.filter(f => IMAGE_MIMES.has(f.mimeType));
  const videoFiles = files.filter(f => VIDEO_MIMES.has(f.mimeType));
  const otherFiles = files.filter(f => !IMAGE_MIMES.has(f.mimeType) && !VIDEO_MIMES.has(f.mimeType));
  let prefix = '';
  if (imageFiles.length > 0) {
    const paths = imageFiles.map(describe).join('\n');
    prefix += `[User sent ${imageFiles.length} image(s). Read these files to view them:\n${paths}\n]\n\n`;
  }
  if (videoFiles.length > 0) {
    const paths = videoFiles.map(describe).join('\n');
    prefix += `[User sent ${videoFiles.length} video(s). Read these files to view them:\n${paths}\n]\n\n`;
  }
  if (otherFiles.length > 0) {
    const fileList = otherFiles.map(describe).join('\n');
    prefix += `[User sent ${otherFiles.length} file(s). Read these files:\n${fileList}\n]\n\n`;
  }
  prefix += formatAttachmentFailures(failures);
  return prefix + (userMessage || (files.length > 0 ? 'Please analyze the attached file(s).' : ''));
}
