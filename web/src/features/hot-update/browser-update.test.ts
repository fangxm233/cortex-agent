import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkBrowserUpdate, readBrowserEntry, reloadBrowserPage } from './browser-update';

const pageUrl = 'https://cortex.example/session/123';
function page(js = '/assets/index-abcdefgh.js', css = '/assets/index-abcdefgh.css', valid = true) {
  const element = (attr: string, value: string) => ({ getAttribute: (key: string) => key === attr ? value : null });
  return {
    title: valid ? 'Cortex' : 'Login',
    querySelector: (selector: string) => valid && selector === '#root' ? {} : null,
    querySelectorAll: (selector: string) => selector === 'script[type="module"][src]'
      ? [element('src', js)] : [element('href', css)],
  } as unknown as Document;
}
function setup(fresh = page(), response: Partial<Response> = {}) {
  vi.stubGlobal('document', page());
  vi.stubGlobal('location', { href: pageUrl, reload: vi.fn() });
  vi.stubGlobal('DOMParser', class { parseFromString() { return fresh; } });
  const fetch = vi.fn().mockResolvedValue({ ok: true, redirected: false, url: pageUrl,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    text: async () => '<!doctype html><html></html>', ...response });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('browser page entry checks', () => {
  it('compares production module and stylesheet entries without reloading', async () => {
    const fetch = setup();
    expect(await checkBrowserUpdate()).toEqual({ status: 'current' });
    expect(fetch).toHaveBeenCalledWith(pageUrl, expect.objectContaining({
      cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: expect.any(AbortSignal),
    }));
    expect(location.reload).not.toHaveBeenCalled();
  });
  it.each([
    page('/assets/index-newhash1.js'),
    page('/assets/index-abcdefgh.js', '/assets/index-newhash1.css'),
  ])('keeps the loaded baseline across repeated changed-entry checks', async (fresh) => {
    setup(fresh);
    expect((await checkBrowserUpdate()).status).toBe('available');
    expect((await checkBrowserUpdate()).status).toBe('available');
    expect(location.reload).not.toHaveBeenCalled();
    reloadBrowserPage();
    expect(location.reload).toHaveBeenCalledOnce();
  });
  it('skips development and unsupported loaded pages without a network request', async () => {
    const fetch = setup();
    vi.stubGlobal('document', page('/src/main.tsx'));
    expect(await checkBrowserUpdate()).toEqual({ status: 'skipped', reason: 'unsupported_page' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { ok: false }, { redirected: true }, { url: 'https://login.example/' },
    { headers: new Headers({ 'content-type': 'application/json' }) },
  ])('never treats auth/error responses as current or changed: %j', async (response) => {
    setup(page(), response);
    expect((await checkBrowserUpdate()).status).toBe('error');
  });
  it.each([page('/src/main.tsx'), page(undefined, undefined, false), page('https://evil.example/assets/index-abcdefgh.js')])(
    'rejects fresh HTML without Cortex production entry evidence', async (fresh) => {
      setup(fresh);
      expect((await checkBrowserUpdate()).status).toBe('error');
    },
  );
  it('bounds network/body reads and reports failures honestly', async () => {
    vi.useFakeTimers();
    const fetch = setup();
    fetch.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('timeout')));
    }));
    const check = checkBrowserUpdate();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await check).toEqual({ status: 'error', reason: 'check_failed' });
  });
  it('skips malformed loaded entry evidence without failing the whole orchestrator', async () => {
    const fetch = setup();
    vi.stubGlobal('document', page('https://['));
    expect(await checkBrowserUpdate()).toEqual({ status: 'skipped', reason: 'unsupported_page' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('excludes unhashed theme/font styles from the production identity', () => {
    expect(readBrowserEntry(page(undefined, '/theme.css'), pageUrl)).toBeNull();
  });
});
