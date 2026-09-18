import { test } from 'vitest';
import assert from 'node:assert/strict';

import {
  validateProfilesFile,
  resolveClaudeBackend,
  type ProfileEntry,
} from '../../../src/domain/agents/profile-manager.js';

// --- resolveClaudeBackend (pure) ---

test('resolveClaudeBackend treats unknown string as print (conservative fallback)', () => {
  const p: ProfileEntry = { model: 'm', backend: 'claude', claudeBackend: 'whatever' as any };
  assert.equal(resolveClaudeBackend(p), 'print');
});

// --- validateProfilesFile accepts claudeBackend ---

test('validateProfilesFile rejects profile with invalid claudeBackend value', () => {
  assert.throws(() => validateProfilesFile({
    defaultProfile: 'd',
    profiles: { d: { model: 'm', backend: 'claude', claudeBackend: 'foo' } },
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
