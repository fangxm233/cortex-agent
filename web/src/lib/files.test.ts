import { describe, it, expect, afterEach } from 'vitest';
import { fileDownloadUrl } from './files';

// readDesktopConfig() reads globalThis.__CORTEX_DESKTOP_CONFIG — set/clear it to switch modes.
const g = globalThis as unknown as { __CORTEX_DESKTOP_CONFIG?: { serverUrl?: string; token?: string } };

afterEach(() => { delete g.__CORTEX_DESKTOP_CONFIG; });

describe('fileDownloadUrl', () => {
  it('browser/ui-http mode: same-origin relative path, url-encoded', () => {
    const url = fileDownloadUrl('workspace/outputs/s1/a b.txt');
    expect(url.startsWith('/api/files/download?')).toBe(true);
    expect(url).toContain('path=workspace%2Foutputs%2Fs1%2Fa+b.txt');
    expect(url).toContain('disposition=attachment');
  });

  it('inline disposition is carried', () => {
    expect(fileDownloadUrl('workspace/outputs/s1/p.png', 'inline')).toContain('disposition=inline');
  });

  it('desktop/remote mode: absolute server URL base', () => {
    g.__CORTEX_DESKTOP_CONFIG = { serverUrl: 'https://cortex.example.com', token: 'tok' };
    const url = fileDownloadUrl('workspace/outputs/s1/a.txt');
    expect(url.startsWith('https://cortex.example.com/api/files/download?')).toBe(true);
  });
});
