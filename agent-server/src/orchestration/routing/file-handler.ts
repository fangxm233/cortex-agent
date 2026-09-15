import { createLogger } from '@core/log.js';
import type { PlatformAdapter } from '@platform/adapter.js';
import type { IncomingMessage, PlatformFileRef, DownloadedFile } from '@platform/types.js';
import { finalizeInboundFile, prepareInboundAttachmentDir } from '../attachments-store.js';

const log = createLogger('file-handler');

export interface AttachmentFailure {
  name: string;
  reason: string;
}

export interface InboundFiles {
  files: DownloadedFile[];
  /** Attachments the platform would not hand over. Reported to the user and to the model rather
   *  than dropped: an answer written as if the picture had never been sent is worse than an
   *  answer that says the picture did not arrive. */
  failures: AttachmentFailure[];
}

/**
 * Download one message's attachments into that message's own directory under
 * `workspace/attachments/`, then settle each one's real type and name (attachments-store).
 *
 * `key` identifies the inbound message (its platform message id); reusing it means a retried
 * delivery reuses the directory instead of littering a new one.
 */
async function downloadFiles(
  files: PlatformFileRef[] | undefined,
  adapter: PlatformAdapter,
  key: string,
): Promise<InboundFiles> {
  if (!files?.length) return { files: [], failures: [] };
  const dir = await prepareInboundAttachmentDir(key);
  const results: DownloadedFile[] = [];
  const failures: AttachmentFailure[] = [];
  for (const file of files) {
    try {
      results.push(await finalizeInboundFile(await adapter.downloadFile(file, dir), dir));
    } catch (e) {
      const reason = (e as Error).message;
      log.error('Failed to download file:', file.name, reason);
      failures.push({ name: file.name || file.id, reason });
    }
  }
  return { files: results, failures };
}

/** The inbound message's own attachment directory key: conduit + platform message id. Stable, so a
 *  redelivery of the same message reuses its directory instead of littering a new one. */
export function inboundAttachmentKey(message: IncomingMessage): string {
  return `${message.ref.conduit || 'unknown'}-${message.ref.messageId || 'nomsg'}`;
}

export { downloadFiles };
