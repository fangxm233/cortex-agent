import { describe, expect, it } from 'vitest';
import { en, zh } from '@/i18n';
import { downloadErrorText } from './useDownloadFile';

describe('downloadErrorText', () => {
  it('words save_download codes and keeps the OS detail', () => {
    expect(downloadErrorText('download_write_failed: No space left on device (os error 28)', zh))
      .toBe('无法写入文件 (No space left on device (os error 28))');
    expect(downloadErrorText('download_dir_unavailable: unknown path', en))
      .toBe('No download folder is available (unknown path)');
  });

  it('passes other failures through raw', () => {
    expect(downloadErrorText(new Error('HTTP 404'), zh)).toBe('HTTP 404');
  });
});
