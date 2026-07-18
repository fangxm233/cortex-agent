// input:  Node test runner + domain/agents/profile-manager + domain/agents/facade
// output: Lock down the optional `thinking` profile field — per-backend value validation
//         (claude → --effort levels, pi → --thinking levels, codex unsupported),
//         resolution to ResolvedProfileConfig, and propagation into AgentSpawnConfig.
// pos:    profile thinking-level passthrough regression tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

import {
  validateProfilesFile,
  resolveProfileConfig,
} from '../../../src/domain/agents/profile-manager.js';
import { profileRepo, PROFILES_FILE } from '../../../src/store/profile-repo.js';
import { _test as facadeTest } from '../../../src/domain/agents/facade.js';

function withProfiles(data: unknown): void {
  writeFileSync(PROFILES_FILE, JSON.stringify(data));
  profileRepo.invalidate();
}

// --- validation: claude backend accepts --effort levels ---

for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
  test(`validateProfilesFile accepts claude profile with thinking=${level}`, () => {
    assert.doesNotThrow(() => validateProfilesFile({
      defaultProfile: 'd',
      profiles: { d: { model: 'm', backend: 'claude', thinking: level } },
    }));
  });
}

// --- validation: pi backend accepts --thinking levels ---

for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
  test(`validateProfilesFile accepts pi profile with thinking=${level}`, () => {
    assert.doesNotThrow(() => validateProfilesFile({
      defaultProfile: 'd',
      profiles: { d: { model: 'm', backend: 'pi', provider: 'anthropic', thinking: level } },
    }));
  });
}

// --- validation: per-backend value-set mismatches are rejected ---

test('validateProfilesFile rejects claude profile with pi-only thinking=off', () => {
  assert.throws(() => validateProfilesFile({
    defaultProfile: 'd',
    profiles: { d: { model: 'm', backend: 'claude', thinking: 'off' } },
  }), /thinking/);
});

test('validateProfilesFile rejects pi profile with claude-only thinking=max', () => {
  assert.throws(() => validateProfilesFile({
    defaultProfile: 'd',
    profiles: { d: { model: 'm', backend: 'pi', provider: 'anthropic', thinking: 'max' } },
  }), /thinking/);
});

test('validateProfilesFile rejects codex profile with thinking (unsupported backend)', () => {
  assert.throws(() => validateProfilesFile({
    defaultProfile: 'd',
    profiles: { d: { model: 'm', backend: 'codex', thinking: 'high' } },
  }), /thinking/);
});

test('validateProfilesFile rejects non-string thinking', () => {
  assert.throws(() => validateProfilesFile({
    defaultProfile: 'd',
    profiles: { d: { model: 'm', backend: 'claude', thinking: 3 as any } },
  }), /thinking/);
});

test('validateProfilesFile accepts profile without thinking (backward compat)', () => {
  assert.doesNotThrow(() => validateProfilesFile({
    defaultProfile: 'd',
    profiles: { d: { model: 'm', backend: 'claude' } },
  }));
});

test('validateProfilesFile validates fallback thinking against the fallback effective backend', () => {
  // Fallback inherits backend 'claude' from the primary — 'off' is pi-only, must be rejected.
  assert.throws(() => validateProfilesFile({
    defaultProfile: 'd',
    profiles: {
      d: {
        model: 'm', backend: 'claude', thinking: 'high',
        fallback: [{ model: 'm2', thinking: 'off' }],
      },
    },
  }), /thinking/);
});

test('validateProfilesFile accepts fallback with its own valid thinking', () => {
  assert.doesNotThrow(() => validateProfilesFile({
    defaultProfile: 'd',
    profiles: {
      d: {
        model: 'm', backend: 'claude',
        fallback: [{ model: 'm2', backend: 'pi', provider: 'anthropic', thinking: 'minimal' }],
      },
    },
  }));
});

// --- resolveProfileConfig: propagation + no inheritance ---

test('resolveProfileConfig surfaces primary thinking; absent → null', () => {
  withProfiles({
    defaultProfile: 'a',
    profiles: {
      a: { model: 'm', backend: 'claude', thinking: 'high' },
      b: { model: 'm', backend: 'claude' },
    },
  });
  assert.equal(resolveProfileConfig('a').thinking, 'high');
  assert.equal(resolveProfileConfig('b').thinking, null);
});

test('resolveProfileConfig: fallback thinking is explicit-only (no inheritance from primary)', () => {
  withProfiles({
    defaultProfile: 'a',
    profiles: {
      a: {
        model: 'm', backend: 'claude', thinking: 'max',
        fallback: [
          { model: 'f1' },
          { model: 'f2', thinking: 'low' },
        ],
      },
    },
  });
  const cfg = resolveProfileConfig('a');
  assert.equal(cfg.fallback[0].thinking, null, 'undeclared fallback thinking must stay null');
  assert.equal(cfg.fallback[1].thinking, 'low');
});

// --- facade: thinking reaches AgentSpawnConfig ---

test('buildSpawnConfig passes thinking through to the spawn config', () => {
  const spawn = facadeTest.buildSpawnConfig(
    { sessionKey: 'k' },
    { model: 'm', backend: 'claude', mode: null, thinking: 'high' },
    undefined,
  );
  assert.equal(spawn.thinking, 'high');
});

test('buildSpawnConfig omits thinking when unset (backward compat)', () => {
  const spawn = facadeTest.buildSpawnConfig(
    { sessionKey: 'k' },
    { model: 'm', backend: 'claude', mode: null },
    undefined,
  );
  assert.equal(spawn.thinking, undefined);
});
