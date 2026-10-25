import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from './random-id';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => { vi.unstubAllGlobals(); });

describe('randomUUID', () => {
  it('uses crypto.randomUUID when available', () => {
    expect(randomUUID()).toMatch(UUID_V4);
  });

  it('falls back to getRandomValues in an insecure context', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });
    const ids = new Set(Array.from({ length: 50 }, () => randomUUID()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });
});
