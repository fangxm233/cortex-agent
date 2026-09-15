// input:  Node test runner + resolveOnNewProfileName helper
// output: regression tests for the onNew-hook profile lookup (registry is the sole source)
// pos:    Verifies the fix for the "Invalid signature in thinking block" bug —
//         thread-spawned sessions store their profile in session-registry. T2 made the
//         registry the single owner of session identity, so the ledger is no longer a
//         profile source at all; the hook reads the registry and nothing else.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resolveOnNewProfileName } from '../src/domain/sessions/session-hooks.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

interface MockSources {
  registry: Map<string, string | null>;  // sessionId → profileName (null = present but no profile)
  /** Spy list — every dep call appends here so tests can assert on call order. */
  calls:    string[];
}

function deps(sources: MockSources) {
  return {
    lookupRegistryProfile: async (sessionId: string) => {
      sources.calls.push(`registry:${sessionId}`);
      return sources.registry.has(sessionId) ? sources.registry.get(sessionId)! : null;
    },
  };
}

// ── (1) Registry is the source of the per-session profile — the bug scenario ────

test('resolveOnNewProfileName — returns the registry profile (bug scenario)', async () => {
  // Mirror the exact bug from cortex-a63563: session-registry says deepseek-pro (per-session truth
  // for a thread session). The fix must return deepseek-pro so the !new hook injects via the correct
  // gateway route and avoids "Invalid signature in thinking block" from the wrong API.
  const sources: MockSources = {
    registry: new Map([['sess-a63563', 'deepseek-pro']]),
    calls:    [],
  };

  const profile = await resolveOnNewProfileName('C-channel', 'sess-a63563', deps(sources));

  assert.equal(profile, 'deepseek-pro',
    'the registry is the single owner of the per-session profile');
});

// ── (2) Registry record present but no profile → null (no ledger fallback) ──────

test('resolveOnNewProfileName — returns null when the registry record has no profileName', async () => {
  const sources: MockSources = {
    registry: new Map([['sess-x', null]]),       // registry record exists but profileName=null
    calls:    [],
  };

  const profile = await resolveOnNewProfileName('C-channel', 'sess-x', deps(sources));

  assert.equal(profile, null,
    'registry profileName=null → null; the ledger is no longer consulted (T2)');
});

// ── (3) sessionId unknown to registry → null (no ledger fallback) ──────────────

test('resolveOnNewProfileName — returns null when sessionId is not in the registry', async () => {
  const sources: MockSources = {
    registry: new Map(),                          // no entry at all for this sessionId
    calls:    [],
  };

  const profile = await resolveOnNewProfileName('C-channel', 'sess-unknown', deps(sources));

  assert.equal(profile, null,
    'unknown sessionId in registry → null; the ledger is no longer consulted (T2)');
});

// ── (4) Registry empty → null (caller falls back to defaultProfile downstream) ─

test('resolveOnNewProfileName — returns null when the registry has no profile', async () => {
  const sources: MockSources = {
    registry: new Map(),
    calls:    [],
  };

  const profile = await resolveOnNewProfileName('C-channel', 'sess-none', deps(sources));

  assert.equal(profile, null,
    'no profile in the registry → null (downstream runAgent uses default profile)');
});

// ── (5) Only the registry is queried ───────────────────────────────────────────

test('resolveOnNewProfileName — queries only the registry', async () => {
  const sources: MockSources = {
    registry: new Map([['sess-a63563', 'deepseek-pro']]),
    calls:    [],
  };

  await resolveOnNewProfileName('C-channel', 'sess-a63563', deps(sources));

  assert.deepEqual(sources.calls, ['registry:sess-a63563'],
    'the registry is the only profile source');
});
