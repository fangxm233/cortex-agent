import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeDeviceForward, openDeviceForward } from './forward';

afterEach(() => { vi.unstubAllGlobals(); });

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('device forward API', () => {
  it('surfaces the server message from the shared error shape', async () => {
    stubFetch(500, { ok: false, code: 'open-failed', message: 'too many device ports open (32)' });
    await expect(openDeviceForward('desk', 6006)).rejects.toThrow('too many device ports open (32)');
  });

  it('posts a close for one device port', async () => {
    const fetchMock = stubFetch(200, { ok: true, data: { closed: true } });
    await closeDeviceForward('desk', 6006);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/forward/device-port/close');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ device: 'desk', port: 6006 });
  });
});
