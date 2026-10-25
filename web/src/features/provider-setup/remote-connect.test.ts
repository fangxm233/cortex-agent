import { describe, expect, it, vi } from 'vitest';
import { en } from '@/i18n/vocab';
import { checkConnection, normalizeServerUrl, probeServer } from './remote-connect';

it('trims the address and its trailing slashes', () => {
  expect(normalizeServerUrl('  https://cortex.example.com//  ')).toBe('https://cortex.example.com');
});

it('treats only a 401 as a rejected token, and a failed request as unreachable', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({ status: 200 });
  expect(await probeServer('https://cortex.example.com', 't', fetchImpl)).toBe('ok');
  expect(fetchImpl).toHaveBeenCalledWith('https://cortex.example.com/trpc/',
    expect.objectContaining({ headers: { 'x-cortex-token': 't' } }));
  fetchImpl.mockResolvedValue({ status: 404 });
  expect(await probeServer('https://cortex.example.com', 't', fetchImpl)).toBe('ok');
  fetchImpl.mockResolvedValue({ status: 401 });
  expect(await probeServer('https://cortex.example.com', 't', fetchImpl)).toBe('rejected');
  fetchImpl.mockRejectedValue(new TypeError('Failed to fetch'));
  expect(await probeServer('https://cortex.example.com', 't', fetchImpl)).toBe('unreachable');
});

describe('checkConnection', () => {
  const json = (status: number, body: unknown) => ({ status, ok: status < 300, json: async () => body });

  it('verifies a client token as before', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200 });
    expect(await checkConnection('https://h', 'tok', true, en, { deviceName: 'Windows', fetchImpl }))
      .toEqual({ ok: true, token: 'tok', text: en.onbVerified });
    fetchImpl.mockResolvedValue({ status: 401 });
    expect(await checkConnection('https://h', 'tok', true, en, { deviceName: 'Windows', fetchImpl }))
      .toEqual({ ok: false, text: en.onbTokenRejected });
  });

  it('only checks reachability when testing a pairing code, so the code is not spent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 401 });
    expect(await checkConnection('https://h', 'abcd-efgh', false, en, { deviceName: 'Windows', fetchImpl }))
      .toEqual({ ok: true, token: '', text: en.onbReachable });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://h/trpc/');
  });

  it('trades a pairing code for this app’s token when connecting', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { ok: true, data: { token: 'device-token' } }));
    expect(await checkConnection('https://h', 'ABCD-EFGH', true, en, { deviceName: 'Android', fetchImpl }))
      .toEqual({ ok: true, token: 'device-token', text: en.onbVerified });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ code: 'ABCD-EFGH', name: 'Android' });
    fetchImpl.mockResolvedValue(json(401, { ok: false }));
    expect(await checkConnection('https://h', 'ABCD-EFGH', true, en, { deviceName: 'Android', fetchImpl }))
      .toEqual({ ok: false, text: en.onbCodeRejected });
  });
});
