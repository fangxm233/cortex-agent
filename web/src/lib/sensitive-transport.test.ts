// input:  credential transport policy and mocked fetch
// output: HTTPS, loopback and native remote transport regressions
// pos:    Verify platform secrets never use remote plaintext HTTP
// >>> Once updated, update this header and parent CORTEX.md <<<

import { afterEach, expect, test, vi } from 'vitest';
import { credentialSafeFetch, safeCredentialTransport } from './sensitive-transport';

afterEach(() => vi.unstubAllGlobals());

test('checks actual server URL instead of the local Tauri asset URL', () => {
  expect(safeCredentialTransport('http://192.168.1.10:3004', 'http://localhost')).toBe(false);
  expect(safeCredentialTransport('https://cortex.example', 'cortexui://localhost')).toBe(true);
  expect(safeCredentialTransport('', 'http://localhost:5174')).toBe(true);
  expect(safeCredentialTransport('', 'http://[::1]:3004')).toBe(true);
  expect(safeCredentialTransport('', 'http://public.example')).toBe(false);
  expect(safeCredentialTransport('', 'cortexui://localhost')).toBe(false);
});

test('blocks even direct client submissions on insecure transport and refuses redirects', async () => {
  const fetch = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  await expect(credentialSafeFetch('http://remote.example')('http://remote.example/trpc/config.setPlatform', { method: 'POST' }))
    .rejects.toThrow('HTTPS');
  await expect(credentialSafeFetch('https://safe.example')('http://remote.example/trpc/config.setPlatform', { method: 'POST' }))
    .rejects.toThrow('HTTPS');
  expect(fetch).not.toHaveBeenCalled();
  await credentialSafeFetch('https://remote.example')('https://remote.example/trpc/config.setPlatform', { method: 'POST' });
  expect(fetch).toHaveBeenLastCalledWith('https://remote.example/trpc/config.setPlatform', { method: 'POST', redirect: 'error' });
});
