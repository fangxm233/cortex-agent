import { describe, expect, it, vi } from 'vitest';
import {
  looksLikePairingCode, pairingDeviceName, pairingLink, redeemPairingCode, splitPairingLink, takePairingCodeFromHash,
} from './pairing';

describe('looksLikePairingCode', () => {
  it('accepts the displayed form and loose spellings, never a full token', () => {
    expect(looksLikePairingCode('ABCD-EFGH')).toBe(true);
    expect(looksLikePairingCode(' abcd efgh ')).toBe(true);
    expect(looksLikePairingCode('O1IL2345')).toBe(true);
    expect(looksLikePairingCode('ABCD-EFGU')).toBe(false);
    expect(looksLikePairingCode('f'.repeat(64))).toBe(false);
    expect(looksLikePairingCode('')).toBe(false);
  });
});

describe('pairing links', () => {
  it('round-trips a server address and code', () => {
    const link = pairingLink('https://app.example.com', 'ABCD-EFGH');
    expect(link).toBe('https://app.example.com/#pair=ABCD-EFGH');
    expect(splitPairingLink(link)).toEqual({ serverUrl: 'https://app.example.com', code: 'ABCD-EFGH' });
  });

  it('keeps a path prefix and ignores anything that is not a pairing link', () => {
    expect(splitPairingLink('https://host/cortex/#pair=abcd-efgh')).toEqual({ serverUrl: 'https://host/cortex', code: 'abcd-efgh' });
    expect(splitPairingLink('https://host')).toBeNull();
    expect(splitPairingLink('https://host/#pair=nope')).toBeNull();
    expect(splitPairingLink('not a url')).toBeNull();
  });

  it('takes the code out of a page hash', () => {
    expect(takePairingCodeFromHash('#pair=ABCD-EFGH')).toBe('ABCD-EFGH');
    expect(takePairingCodeFromHash('#/sessions')).toBeNull();
    expect(takePairingCodeFromHash('')).toBeNull();
  });
});

describe('redeemPairingCode', () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });

  it('posts the code and name and returns the device token', async () => {
    const fetchImpl = vi.fn(async () => json(200, { ok: true, data: { token: 'tok' } }));
    await expect(redeemPairingCode('https://h', 'ABCD-EFGH', 'Android', fetchImpl)).resolves.toEqual({ ok: true, token: 'tok' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://h/api/ui/pair');
    expect(JSON.parse(String(init.body))).toEqual({ code: 'ABCD-EFGH', name: 'Android' });
  });

  it('tells a refused code from an unreachable server', async () => {
    await expect(redeemPairingCode('https://h', 'c', 'n', async () => json(401, { ok: false })))
      .resolves.toEqual({ ok: false, reason: 'rejected' });
    await expect(redeemPairingCode('https://h', 'c', 'n', async () => { throw new TypeError('down'); }))
      .resolves.toEqual({ ok: false, reason: 'unreachable' });
    // An older server answers its SPA page: not a pairing server, so the code was not accepted.
    await expect(redeemPairingCode('https://h', 'c', 'n', async () => new Response('<html>', { status: 200 })))
      .resolves.toEqual({ ok: false, reason: 'rejected' });
  });
});

describe('pairingDeviceName', () => {
  it('names the operating system', () => {
    expect(pairingDeviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', false)).toBe('Windows');
    expect(pairingDeviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', false)).toBe('macOS');
    expect(pairingDeviceName('Mozilla/5.0 (X11; Linux x86_64)', false)).toBe('Linux');
    expect(pairingDeviceName('Mozilla/5.0 (Linux; Android 15; Pixel 9)', true)).toBe('Android');
  });
});
