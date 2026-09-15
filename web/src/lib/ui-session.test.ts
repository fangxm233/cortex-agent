import { describe, expect, it, vi, afterEach } from 'vitest';
import { probeUiSession, uiLogin, uiLogout, UI_LOGIN_PATH, UI_SESSION_PATH } from './ui-session';

function mockFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(impl(String(input), init)));
  vi.stubGlobal('fetch', spy);
  return spy;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('probeUiSession', () => {
  it('reads both booleans out of the envelope', async () => {
    mockFetch(() => json({ ok: true, data: { authenticated: true, tokenLogin: true } }));
    expect(await probeUiSession()).toEqual({ authenticated: true, tokenLogin: true });
  });

  it('treats anything not exactly true as false (a truthy string must not sign you in)', async () => {
    mockFetch(() => json({ ok: true, data: { authenticated: 'yes', tokenLogin: 1 } }));
    expect(await probeUiSession()).toEqual({ authenticated: false, tokenLogin: false });
  });

  it('throws on a non-OK response so the caller can say "cannot reach the server"', async () => {
    mockFetch(() => json({ ok: false }, 502));
    await expect(probeUiSession()).rejects.toThrow(/502/);
  });

  it('sends cookies (the session lives in one) and bypasses the cache', async () => {
    const spy = mockFetch(() => json({ ok: true, data: { authenticated: false, tokenLogin: true } }));
    await probeUiSession();
    expect(spy).toHaveBeenCalledWith(UI_SESSION_PATH, expect.objectContaining({
      credentials: 'same-origin',
      cache: 'no-store',
    }));
  });
});

describe('uiLogin', () => {
  it('posts the token as JSON, same-origin', async () => {
    const spy = mockFetch(() => json({ ok: true }));
    expect(await uiLogin('secret-token')).toEqual({ ok: true });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(UI_LOGIN_PATH);
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(JSON.parse(String(init!.body))).toEqual({ token: 'secret-token' });
  });

  it('reports a rejected token as a result, not an exception', async () => {
    mockFetch(() => json({ ok: false }, 401));
    expect(await uiLogin('wrong')).toEqual({ ok: false, status: 401 });
  });

  it('lets a transport failure propagate (that is not "wrong password")', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    await expect(uiLogin('x')).rejects.toThrow('offline');
  });
});

describe('uiLogout', () => {
  it('posts same-origin so the server can revoke the session it sees', async () => {
    const spy = mockFetch(() => json({ ok: true }));
    await uiLogout();
    expect(spy.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'same-origin' });
  });
});
