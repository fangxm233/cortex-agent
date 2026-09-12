import { IMAGE_MIMES, VIDEO_MIMES } from '@core/media-types.js';
import * as path from 'path';

interface FileAttachment {
  mimeType: string;
  path: string;
}

export function buildPrompt(userMessage: string, files: FileAttachment[]): string {
  if (files.length === 0) return userMessage;
  const imageFiles = files.filter(f => IMAGE_MIMES.has(f.mimeType));
  const videoFiles = files.filter(f => VIDEO_MIMES.has(f.mimeType));
  const otherFiles = files.filter(f => !IMAGE_MIMES.has(f.mimeType) && !VIDEO_MIMES.has(f.mimeType));
  let prefix = '';
  if (imageFiles.length > 0) {
    const paths = imageFiles.map(f => f.path.replace(/\\/g, '/')).join('\n');
    prefix += `[User sent ${imageFiles.length} image(s). Read these files to view them:\n${paths}\n]\n\n`;
  }
  if (videoFiles.length > 0) {
    const paths = videoFiles.map(f => f.path.replace(/\\/g, '/')).join('\n');
    prefix += `[User sent ${videoFiles.length} video(s). Read these files to view them:\n${paths}\n]\n\n`;
  }
  if (otherFiles.length > 0) {
    const fileList = otherFiles.map(f => `${f.path.replace(/\\/g, '/')} (${path.basename(f.path)})`).join('\n');
    prefix += `[User sent ${otherFiles.length} file(s). Read these files:\n${fileList}\n]\n\n`;
  }
  return prefix + (userMessage || 'Please analyze the attached file(s).');
}
