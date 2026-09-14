import { createLogger } from '@core/log.js';
import type { PlatformAdapter } from '@platform/adapter.js';
import type { PlatformFileRef, DownloadedFile } from '@platform/types.js';

const log = createLogger('file-handler');


async function downloadFiles(
  files: PlatformFileRef[] | undefined,
  adapter: PlatformAdapter,
  tempDir: string,
): Promise<DownloadedFile[]> {
  if (!files?.length) return [];
  const results: DownloadedFile[] = [];
  for (const file of files) {
    try {
      results.push(await adapter.downloadFile(file, tempDir));
    } catch (e) {
      log.error('Failed to download file:', file.name, (e as Error).message);
    }
  }
  return results;
}

export { downloadFiles };
