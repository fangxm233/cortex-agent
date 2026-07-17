// input:  Node test runner + agent-adapter/claude/spawn-args + domain/agents/profile-manager
// output: Lock down claudeBackend field validation + propagation through ResolvedProfileConfig
// pos:    DR-0012 Phase 4 — profile schema regression tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import {
  validateProfilesFile,
  resolveClaudeBackend,
  type ProfileEntry,
} from '../../../src/domain/agents/profile-manager.js';

// --- resolveClaudeBackend (pure) ---

test('resolveClaudeBackend defaults to print when field is absent', () => {
  const p: ProfileEntry = { model: 'm', backend: 'claude' };
  assert.equal(resolveClaudeBackend(p), 'print');
});

test('resolveClaudeBackend returns tui when explicitly set', () => {
  const p: ProfileEntry = { model: 'm', backend: 'claude', claudeBackend: 'tui' };
  assert.equal(resolveClaudeBackend(p), 'tui');
});

test('resolveClaudeBackend returns print when explicitly set to print', () => {
  const p: ProfileEntry = { model: 'm', backend: 'claude', claudeBackend: 'print' };
  assert.equal(resolveClaudeBackend(p), 'print');
});

test('resolveClaudeBackend treats unknown string as print (conservative fallback)', () => {
  const p: ProfileEntry = { model: 'm', backend: 'claude', claudeBackend: 'whatever' as any };
  assert.equal(resolveClaudeBackend(p), 'print');
});

// --- validateProfilesFile accepts claudeBackend ---

test('validateProfilesFile accepts profile with claudeBackend=tui', () => {
  assert.doesNotThrow(() => validateProfilesFile({
    defaultProfile: 'd',
    profiles: { d: { model: 'm', backend: 'claude', claudeBackend: 'tui' } },
  }));
});

test('validateProfilesFile accepts profile with claudeBackend=print', () => {
  assert.doesNotThrow(() => validateProfilesFile({
    defaultProfile: 'd',
    profiles: { d: { model: 'm', backend: 'claude', claudeBackend: 'print' } },
  }));
});

test('validateProfilesFile rejects profile with invalid claudeBackend value', () => {
  assert.throws(() => validateProfilesFile({
    defaultProfile: 'd',
    profiles: { d: { model: 'm', backend: 'claude', claudeBackend: 'foo' } },
  }), /claudeBackend/);
});

test('validateProfilesFile rejects profile with non-string claudeBackend', () => {
  assert.throws(() => validateProfilesFile({
    defaultProfile: 'd',
    profiles: { d: { model: 'm', backend: 'claude', claudeBackend: 1 as any } },
  }), /claudeBackend/);
});

test('validateProfilesFile validates fallback entries claudeBackend too', () => {
  assert.throws(() => validateProfilesFile({
    defaultProfile: 'd',
    profiles: {
      d: {
        model: 'm', backend: 'claude',
        fallback: [{ model: 'm2', backend: 'claude', claudeBackend: 'bogus' as any }],
      },
    },
  }), /claudeBackend/);
});
