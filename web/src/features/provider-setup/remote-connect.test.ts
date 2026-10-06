import { expect, it, vi } from 'vitest';
import { normalizeServerUrl, probeServer } from './remote-connect';

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
