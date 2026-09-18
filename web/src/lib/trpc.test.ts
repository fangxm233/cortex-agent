// input:  helpers exported from trpc.ts (trpcUrl, buildBatchHeaders)
// output: unit tests for two transport modes — browser/same-origin (no config) and
//         desktop/remote (injected RemoteConfig with serverUrl + token)
// pos:    Regression guard for the conditional tRPC transport (task 1b60, desktop-app.md).
//         Pure-logic tests only — no real network connections made.

import { describe, it, expect } from 'vitest';
import { trpcUrl, buildBatchHeaders, type RemoteConfig } from './trpc';

const REMOTE: RemoteConfig = {
  serverUrl: 'https://cortex.example.com',
  token: 'test-bearer-token-xyz',
};

// ── trpcUrl ──────────────────────────────────────────────────────────────────

describe('trpcUrl', () => {
  it('returns relative /trpc when no config is provided (browser / same-origin mode)', () => {
    expect(trpcUrl()).toBe('/trpc');
    expect(trpcUrl(undefined)).toBe('/trpc');
  });

  it('returns absolute URL with /trpc suffix when config is injected (desktop / remote mode)', () => {
    expect(trpcUrl(REMOTE)).toBe('https://cortex.example.com/trpc');
  });

  it('constructs the URL from serverUrl regardless of path or port', () => {
    expect(trpcUrl({ serverUrl: 'http://localhost:3004', token: 'x' })).toBe(
      'http://localhost:3004/trpc',
    );
    expect(trpcUrl({ serverUrl: 'https://my.server.internal', token: 'x' })).toBe(
      'https://my.server.internal/trpc',
    );
  });
});

// ── buildBatchHeaders ─────────────────────────────────────────────────────────

describe('buildBatchHeaders', () => {
  it('returns an empty object when no config is provided (browser mode — proxy handles auth)', () => {
    expect(buildBatchHeaders()).toEqual({});
    expect(buildBatchHeaders(undefined)).toEqual({});
  });

  it('returns x-cortex-token header when config is provided (desktop mode)', () => {
    expect(buildBatchHeaders(REMOTE)).toEqual({ 'x-cortex-token': 'test-bearer-token-xyz' });
  });

  it('carries the exact token from config', () => {
    const headers = buildBatchHeaders({ serverUrl: 'https://x.example.com', token: 'my-secret-42' });
    expect(headers['x-cortex-token']).toBe('my-secret-42');
  });
});
