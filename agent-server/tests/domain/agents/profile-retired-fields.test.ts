import { test } from 'vitest';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

import { validateProfilesFile, resolveProfileConfig } from '../../../src/domain/agents/profile-manager.js';
import { profileRepo, PROFILES_FILE } from '../../../src/store/profile-repo.js';

// `claudeBackend` selected the retired TUI runtime. A profiles.json written before it was removed
// still carries the key — on profiles and on their fallbacks, with any value — and must keep loading.
const LEGACY = {
  defaultProfile: 'd',
  profiles: {
    d: {
      model: 'm', backend: 'claude', claudeBackend: 'tui',
      fallback: [{ model: 'm2', backend: 'claude', claudeBackend: 'bogus' }],
    },
  },
};

test('a profiles.json that still sets claudeBackend validates', () => {
  assert.doesNotThrow(() => validateProfilesFile(LEGACY));
});

test('a profile that still sets claudeBackend resolves without it', () => {
  writeFileSync(PROFILES_FILE, JSON.stringify(LEGACY));
  profileRepo.invalidate();
  const resolved = resolveProfileConfig('d');
  assert.equal(resolved.model, 'm');
  assert.ok(!('claudeBackend' in resolved));
  assert.ok(!('claudeBackend' in resolved.fallback[0]!));
});
