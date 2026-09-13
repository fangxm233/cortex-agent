// input:  profile manager and the run-layer engine-spec builder
// output: thinking and output-cap validation and propagation
// pos:    Profile execution-control regressions
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

import {
  validateProfilesFile,
  resolveProfileConfig,
} from '../../../src/domain/agents/profile-manager.js';
import { profileRepo, PROFILES_FILE } from '../../../src/store/profile-repo.js';
import { specFromFixture } from '../../run-request-fixture.js';

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

test('validateProfilesFile rejects the removed codex backend', () => {
  assert.throws(() => validateProfilesFile({
    defaultProfile: 'd',
    profiles: { d: { model: 'm', backend: 'codex' } },
  }), /invalid backend: codex/);
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

// --- thinking reaches EngineSpec ---

test('buildEngineSpec passes thinking through to the engine spec', () => {
  const spec = specFromFixture({ sessionKey: 'k' }, { model: 'm', backend: 'claude', thinking: 'high' });
  assert.equal(spec.model.thinking, 'high');
});

test('buildEngineSpec omits thinking when unset (backward compat)', () => {
  const spec = specFromFixture({ sessionKey: 'k' }, { model: 'm', backend: 'claude' });
  assert.equal(spec.model.thinking, undefined);
});

test('PI maxOutputTokens is validated and propagated into the resolved spawn', () => {
  assert.throws(() => validateProfilesFile({
    defaultProfile: 'd',
    profiles: { d: { model: 'm', backend: 'pi', provider: 'deepseek', maxOutputTokens: 0 } },
  }), /maxOutputTokens/);
  withProfiles({
    defaultProfile: 'd',
    profiles: { d: { model: 'm', backend: 'pi', provider: 'deepseek', maxOutputTokens: 4096 } },
  });
  const resolved = resolveProfileConfig('d');
  assert.equal(resolved.maxOutputTokens, 4096);
  const spec = specFromFixture({ sessionKey: 'k' }, resolved);
  assert.equal(spec.model.maxOutputTokens, 4096);
});

test('buildEngineSpec preserves the openai-codex provider for a PI profile', () => {
  const spec = specFromFixture(
    { sessionKey: 'k' },
    { model: 'gpt-5.4-mini', backend: 'pi', provider: 'openai-codex', mode: 'openai-codex' },
  );
  assert.equal(spec.model.provider, 'openai-codex');
  assert.equal(spec.route.gatewayPath, '/m/openai-codex/openai-codex');
});
