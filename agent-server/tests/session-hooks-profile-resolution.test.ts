// input:  Node test runner + resolveOnNewProfileName helper
// output: regression tests for the onNew-hook profile lookup priority (registry > ledger)
// pos:    Verifies the fix for the "Invalid signature in thinking block" bug —
//         thread-spawned sessions store their profile in session-registry, NOT in the
//         channel-level conversation-ledger; the hook must prefer the registry source.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resolveOnNewProfileName } from '../src/domain/sessions/session-hooks.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

interface MockSources {
  registry: Map<string, string | null>;  // sessionId → profileName (null = present but no profile)
  ledger:   Map<string, string | null>;  // channel   → profileName
  /** Spy list — every dep call appends here so tests can assert on call order. */
  calls:    string[];
}

function deps(sources: MockSources) {
  return {
    lookupRegistryProfile: async (sessionId: string) => {
      sources.calls.push(`registry:${sessionId}`);
      return sources.registry.has(sessionId) ? sources.registry.get(sessionId)! : null;
    },
    lookupLedgerProfile: async (channel: string) => {
      sources.calls.push(`ledger:${channel}`);
      return sources.ledger.has(channel) ? sources.ledger.get(channel)! : null;
    },
  };
}

// ── (1) Registry wins when both sources disagree — the bug scenario ────────────

test('resolveOnNewProfileName — registry profile wins over ledger profile (bug scenario)', async () => {
  // Mirror the exact bug from cortex-a63563:
  //   session-registry says deepseek-pro (per-session truth — thread session)
  //   conversation-ledger says plan      (stale channel-level data)
  // The fix must return deepseek-pro so the !new hook injects via the correct gateway
  // route and avoids "Invalid signature in thinking block" from the wrong API.
  const sources: MockSources = {
    registry: new Map([['sess-a63563', 'deepseek-pro']]),
    ledger:   new Map([['C-channel',   'plan']]),
    calls:    [],
  };

  const profile = await resolveOnNewProfileName('C-channel', 'sess-a63563', deps(sources));

  assert.equal(profile, 'deepseek-pro',
    'registry must override ledger when both are present — per-session truth takes priority');
});

// ── (2) Ledger fallback when registry has no profile ───────────────────────────

test('resolveOnNewProfileName — falls back to ledger when registry has no profileName', async () => {
  const sources: MockSources = {
    registry: new Map([['sess-x', null]]),       // registry record exists but profileName=null
    ledger:   new Map([['C-channel', 'plan']]),
    calls:    [],
  };

  const profile = await resolveOnNewProfileName('C-channel', 'sess-x', deps(sources));

  assert.equal(profile, 'plan',
    'when registry lookup returns null, the ledger value must be used as fallback');
});

// ── (3) Ledger fallback when sessionId is unknown to registry ──────────────────

test('resolveOnNewProfileName — falls back to ledger when sessionId is not in registry', async () => {
  const sources: MockSources = {
    registry: new Map(),                          // no entry at all for this sessionId
    ledger:   new Map([['C-channel', 'execute']]),
    calls:    [],
  };

  const profile = await resolveOnNewProfileName('C-channel', 'sess-unknown', deps(sources));

  assert.equal(profile, 'execute',
    'unknown sessionId in registry must fall through to ledger');
});

// ── (4) Both empty → null (caller falls back to defaultProfile downstream) ─────

test('resolveOnNewProfileName — returns null when neither source has a profile', async () => {
  const sources: MockSources = {
    registry: new Map(),
    ledger:   new Map(),
    calls:    [],
  };

  const profile = await resolveOnNewProfileName('C-channel', 'sess-none', deps(sources));

  assert.equal(profile, null,
    'no profile in either source → null (downstream runAgent uses default profile)');
});

// ── (5) Registry has profile → ledger MUST NOT be queried (perf + correctness) ─

test('resolveOnNewProfileName — does not query ledger when registry already returned a profile', async () => {
  // The bug was rooted in querying the ledger even when registry had the truth.
  // Beyond returning the right value, the helper should also short-circuit so we don't
  // accidentally write logic that depends on a particular ledger state when the registry
  // already answered.
  const sources: MockSources = {
    registry: new Map([['sess-a63563', 'deepseek-pro']]),
    ledger:   new Map([['C-channel',   'plan']]),
    calls:    [],
  };

  await resolveOnNewProfileName('C-channel', 'sess-a63563', deps(sources));

  assert.deepEqual(sources.calls, ['registry:sess-a63563'],
    'ledger lookup must be skipped when registry already provided a profile');
});
