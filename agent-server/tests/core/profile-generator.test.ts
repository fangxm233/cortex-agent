// input:  profile-generator module
// output: verify profile generation: explicit choices, lexicographic listChoices, fallback plumb-through, no auto provider-specific profiles
// pos:    Validate profile-generator pure logic (no filesystem in generateProfiles/mergeProfilesJson)

import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  generateProfiles,
  mergeProfilesJson,
  listChoices,
  writeProfilesJson,
} from '../../src/core/profile-generator.js';
import type { DiscoveredEndpoint } from '../../src/core/gateway-generator.js';
import { validateProfilesFile } from '../../src/domain/agents/profile-manager.js';

// ─── Fixture helpers ────────────────────────────────────────────

/** Build a minimal DiscoveredEndpoint with sensible defaults for testing. */
function ep(mode: string, endpoint: string, models: string[], gatewayManaged = true): DiscoveredEndpoint {
  return {
    mode,
    endpoint,
    base_url: 'https://example.test',
    auth_style: 'bearer',
    keys: [],
    passthrough: true,
    models,
    gatewayManaged,
  };
}

const ANTHROPIC_PLAN = ep('plan', 'anthropic', ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5']);
const DEEPSEEK = ep('deepseek', 'deepseek', ['deepseek-v4-pro', 'deepseek-v4-flash']);
const OPENAI_CODEX = ep('openai-codex', 'openai-codex', ['gpt-5.4', 'gpt-5.4-mini']);

// ─── Empty endpoints → minimal fallback ─────────────────────────

test('generateProfiles: empty endpoints returns minimal plan-only profile', () => {
  const result = generateProfiles([]);
  assert.equal(result.defaultProfile, 'plan');
  assert.deepEqual(Object.keys(result.profiles), ['plan']);
  assert.equal(result.profiles.plan.backend, 'claude');
});

// ─── No auto-generated provider-specific profiles ────────────────

test('generateProfiles: never generates provider-specific tier profiles', () => {
  const result = generateProfiles([ANTHROPIC_PLAN, DEEPSEEK, OPENAI_CODEX]);
  for (const name of Object.keys(result.profiles)) {
    assert.ok(name === 'plan' || name === 'execute',
      `unexpected profile generated: ${name} — only 'plan' and 'execute' are allowed`);
  }
});

test('generateProfiles: defaultProfile is "plan"', () => {
  const result = generateProfiles([ANTHROPIC_PLAN]);
  assert.equal(result.defaultProfile, 'plan');
});

// ─── plan/execute defaults: first lexicographic choice ──────────

test('generateProfiles: plan defaults to first lexicographic (mode, model) when planChoice omitted', () => {
  // listChoices(ANTHROPIC_PLAN): mode=plan, models in order claude-haiku/opus/sonnet → first is claude-haiku-4-5
  const result = generateProfiles([ANTHROPIC_PLAN]);
  assert.equal(result.profiles.plan.mode, 'plan');
  assert.equal(result.profiles.plan.model, 'claude-haiku-4-5');
});

test('generateProfiles: execute defaults to first lexicographic when executeChoice omitted', () => {
  const result = generateProfiles([ANTHROPIC_PLAN]);
  assert.equal(result.profiles.execute.mode, 'plan');
  assert.equal(result.profiles.execute.model, 'claude-haiku-4-5');
});

// ─── Explicit planChoice / executeChoice ────────────────────────

test('generateProfiles: explicit planChoice is honored', () => {
  const result = generateProfiles([ANTHROPIC_PLAN, DEEPSEEK], {
    planChoice: { mode: 'deepseek', model: 'deepseek-v4-pro' },
  });
  assert.equal(result.profiles.plan.model, 'deepseek-v4-pro');
  assert.equal(result.profiles.plan.mode, 'deepseek');
  assert.equal(result.profiles.plan.backend, 'pi');
});

test('generateProfiles: explicit executeChoice is honored', () => {
  const result = generateProfiles([ANTHROPIC_PLAN, DEEPSEEK], {
    executeChoice: { mode: 'plan', model: 'claude-opus-4-7' },
  });
  assert.equal(result.profiles.execute.model, 'claude-opus-4-7');
  assert.equal(result.profiles.execute.mode, 'plan');
  assert.equal(result.profiles.execute.backend, 'claude');
});

test('generateProfiles: explicit choice for unknown (mode, model) throws', () => {
  assert.throws(() => {
    generateProfiles([ANTHROPIC_PLAN], {
      planChoice: { mode: 'nonexistent', model: 'fake-model' },
    });
  }, /not found/i);
});

// ─── fallback chain plumb-through ────────────────────────────────

test('generateProfiles: planFallback array is written to ProfileEntry.fallback', () => {
  const result = generateProfiles([ANTHROPIC_PLAN, DEEPSEEK], {
    planChoice: { mode: 'plan', model: 'claude-opus-4-7' },
    planFallback: [
      { mode: 'plan', model: 'claude-sonnet-4-6' },
      { mode: 'deepseek', model: 'deepseek-v4-pro' },
    ],
  });
  assert.ok(Array.isArray(result.profiles.plan.fallback));
  assert.equal(result.profiles.plan.fallback!.length, 2);
  assert.equal(result.profiles.plan.fallback![0].model, 'claude-sonnet-4-6');
  assert.equal(result.profiles.plan.fallback![0].backend, 'claude');
  assert.equal(result.profiles.plan.fallback![1].model, 'deepseek-v4-pro');
  assert.equal(result.profiles.plan.fallback![1].backend, 'pi');
});

test('generateProfiles: executeFallback array is written to ProfileEntry.fallback', () => {
  const result = generateProfiles([ANTHROPIC_PLAN, DEEPSEEK], {
    executeChoice: { mode: 'deepseek', model: 'deepseek-v4-flash' },
    executeFallback: [
      { mode: 'plan', model: 'claude-haiku-4-5' },
    ],
  });
  assert.ok(Array.isArray(result.profiles.execute.fallback));
  assert.equal(result.profiles.execute.fallback!.length, 1);
  assert.equal(result.profiles.execute.fallback![0].mode, 'plan');
});

test('generateProfiles: no fallback opts → ProfileEntry.fallback is undefined or empty', () => {
  const result = generateProfiles([ANTHROPIC_PLAN]);
  const fb = result.profiles.plan.fallback;
  assert.ok(fb === undefined || (Array.isArray(fb) && fb.length === 0));
});

test('generateProfiles: fallback referencing unknown (mode, model) throws', () => {
  assert.throws(() => {
    generateProfiles([ANTHROPIC_PLAN], {
      planFallback: [{ mode: 'nonexistent', model: 'fake' }],
    });
  }, /not found/i);
});

// ─── backend resolution ────────────────────────────────────────

test('generateProfiles: anthropic plan endpoint → backend=claude', () => {
  const result = generateProfiles([ANTHROPIC_PLAN], {
    planChoice: { mode: 'plan', model: 'claude-opus-4-7' },
  });
  assert.equal(result.profiles.plan.backend, 'claude');
});

test('generateProfiles: non-anthropic endpoint → backend=pi (e.g. deepseek)', () => {
  const result = generateProfiles([ANTHROPIC_PLAN, DEEPSEEK], {
    planChoice: { mode: 'deepseek', model: 'deepseek-v4-pro' },
  });
  assert.equal(result.profiles.plan.backend, 'pi');
});

test('generateProfiles: openai-codex endpoint → backend=pi', () => {
  const result = generateProfiles([ANTHROPIC_PLAN, OPENAI_CODEX], {
    planChoice: { mode: 'openai-codex', model: 'gpt-5.4-mini' },
  });
  assert.equal(result.profiles.plan.backend, 'pi');
  assert.equal(result.profiles.plan.mode, 'openai-codex');
});

// ─── PI backends must carry an explicit provider (new routing contract) ─────

test('generateProfiles: pi backend profile includes provider === endpoint name', () => {
  const result = generateProfiles([ANTHROPIC_PLAN, DEEPSEEK], {
    executeChoice: { mode: 'deepseek', model: 'deepseek-v4-pro' },
  });
  assert.equal(result.profiles.execute.backend, 'pi');
  assert.equal((result.profiles.execute as any).provider, 'deepseek');
});

test('generateProfiles: openai-codex pi profile includes provider=openai-codex', () => {
  const result = generateProfiles([ANTHROPIC_PLAN, OPENAI_CODEX], {
    executeChoice: { mode: 'openai-codex', model: 'gpt-5.4-mini' },
  });
  assert.equal(result.profiles.execute.backend, 'pi');
  assert.equal((result.profiles.execute as any).provider, 'openai-codex');
});

test('generateProfiles: claude backend profile does NOT carry a provider', () => {
  const result = generateProfiles([ANTHROPIC_PLAN], {
    planChoice: { mode: 'plan', model: 'claude-opus-4-7' },
  });
  assert.equal(result.profiles.plan.backend, 'claude');
  assert.equal((result.profiles.plan as any).provider, undefined);
});

test('generateProfiles: pi fallback entries also carry a provider', () => {
  const result = generateProfiles([ANTHROPIC_PLAN, DEEPSEEK], {
    planChoice: { mode: 'plan', model: 'claude-opus-4-7' },
    planFallback: [{ mode: 'deepseek', model: 'deepseek-v4-flash' }],
  });
  assert.equal((result.profiles.plan.fallback![0] as any).provider, 'deepseek');
});

test('generateProfiles: output passes profile-manager validation (pi provider required)', () => {
  // Regression guard: a fresh `cortex init` config containing a pi profile (incl. a pi fallback)
  // must be loadable by the server — validateProfilesFile now rejects pi profiles without provider.
  const result = generateProfiles([ANTHROPIC_PLAN, DEEPSEEK, OPENAI_CODEX], {
    planChoice: { mode: 'plan', model: 'claude-opus-4-7' },
    executeChoice: { mode: 'deepseek', model: 'deepseek-v4-flash' },
    executeFallback: [{ mode: 'openai-codex', model: 'gpt-5.4-mini' }],
  });
  assert.doesNotThrow(() => validateProfilesFile(result));
});

// ─── listChoices: strict lexicographic order ────────────────────

test('listChoices: sorts by (mode, model) ascending lexicographically', () => {
  const choices = listChoices([OPENAI_CODEX, ANTHROPIC_PLAN, DEEPSEEK]);
  // Expected order: deepseek/* < openai-codex/* < plan/*
  // Within each mode, models also sorted ascending
  const modes = choices.map(c => c.mode);
  // Confirm monotonic non-decreasing
  for (let i = 1; i < modes.length; i++) {
    assert.ok(modes[i - 1] <= modes[i], `modes not sorted at ${i}: ${modes[i - 1]} vs ${modes[i]}`);
  }
  // First mode is 'deepseek'
  assert.equal(choices[0].mode, 'deepseek');
  // Within deepseek, first model is deepseek-v4-flash (alphabetically before -pro)
  assert.equal(choices[0].model, 'deepseek-v4-flash');
  assert.equal(choices[1].model, 'deepseek-v4-pro');
});

test('listChoices: within same mode, models sorted ascending', () => {
  const choices = listChoices([ANTHROPIC_PLAN]);
  const models = choices.map(c => c.model);
  for (let i = 1; i < models.length; i++) {
    assert.ok(models[i - 1] <= models[i], `models not sorted at ${i}: ${models[i - 1]} vs ${models[i]}`);
  }
});

test('listChoices: each choice has {mode, model}', () => {
  const choices = listChoices([ANTHROPIC_PLAN]);
  for (const c of choices) {
    assert.equal(typeof c.mode, 'string');
    assert.equal(typeof c.model, 'string');
  }
});

test('listChoices: empty endpoints → empty array', () => {
  assert.deepEqual(listChoices([]), []);
});

// ─── Validate profile name regex compatibility with OAuth providers ─────

test('generateProfiles: mode "openai-codex" passes through to ProfileEntry (validated downstream)', () => {
  // Hyphenated mode names must survive — profile-manager allows /^[a-zA-Z0-9_-]+$/
  const result = generateProfiles([OPENAI_CODEX], {
    planChoice: { mode: 'openai-codex', model: 'gpt-5.4-mini' },
  });
  assert.equal(result.profiles.plan.mode, 'openai-codex');
});

// ─── mergeProfilesJson: overwrite behavior (preserved) ──────────

test('mergeProfilesJson: overwrite=false preserves existing plan/execute', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-profile-merge-'));
  try {
    const existing = {
      defaultProfile: 'plan',
      profiles: {
        plan: { model: 'user-custom-plan' },
        execute: { model: 'user-custom-execute' },
      },
    };
    fs.writeFileSync(path.join(tmpDir, 'profiles.json'), JSON.stringify(existing));
    const generated = {
      defaultProfile: 'plan',
      profiles: {
        plan: { model: 'claude-opus-4-7', backend: 'claude', mode: 'plan' },
        execute: { model: 'claude-sonnet-4-6', backend: 'claude', mode: 'plan' },
      },
    };
    const merged = mergeProfilesJson(generated, tmpDir, false);
    assert.equal(merged.profiles.plan.model, 'user-custom-plan');
    assert.equal(merged.profiles.execute.model, 'user-custom-execute');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('mergeProfilesJson: overwrite=true replaces plan/execute but keeps other custom profiles', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-profile-merge-'));
  try {
    const existing = {
      defaultProfile: 'plan',
      profiles: {
        plan: { model: 'user-custom-plan' },
        execute: { model: 'user-custom-execute' },
        'my-custom': { model: 'user-special' },
      },
    };
    fs.writeFileSync(path.join(tmpDir, 'profiles.json'), JSON.stringify(existing));
    const generated = {
      defaultProfile: 'plan',
      profiles: {
        plan: { model: 'claude-opus-4-7', backend: 'claude', mode: 'plan' },
        execute: { model: 'claude-sonnet-4-6', backend: 'claude', mode: 'plan' },
      },
    };
    const merged = mergeProfilesJson(generated, tmpDir, true);
    assert.equal(merged.profiles.plan.model, 'claude-opus-4-7');
    assert.equal(merged.profiles.execute.model, 'claude-sonnet-4-6');
    assert.equal(merged.profiles['my-custom'].model, 'user-special');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('mergeProfilesJson: no existing file returns generated as-is', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-profile-merge-'));
  try {
    const generated = {
      defaultProfile: 'plan',
      profiles: { plan: { model: 'm1', backend: 'claude', mode: 'plan' } },
    };
    const merged = mergeProfilesJson(generated, tmpDir, false);
    assert.deepEqual(merged, generated);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── writeProfilesJson: end-to-end ──────────────────────────────

test('writeProfilesJson: writes profiles.json containing plan and execute', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-profile-write-'));
  try {
    const outPath = writeProfilesJson([ANTHROPIC_PLAN], { outputDir: tmpDir });
    assert.equal(outPath, path.join(tmpDir, 'profiles.json'));
    const content = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    assert.ok(content.profiles.plan);
    assert.ok(content.profiles.execute);
    assert.equal(content.defaultProfile, 'plan');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('writeProfilesJson: respects explicit choices', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-profile-write-'));
  try {
    writeProfilesJson([ANTHROPIC_PLAN, DEEPSEEK], {
      outputDir: tmpDir,
      planChoice: { mode: 'plan', model: 'claude-sonnet-4-6' },
      executeChoice: { mode: 'deepseek', model: 'deepseek-v4-flash' },
    });
    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, 'profiles.json'), 'utf-8'));
    assert.equal(content.profiles.plan.model, 'claude-sonnet-4-6');
    assert.equal(content.profiles.execute.model, 'deepseek-v4-flash');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('writeProfilesJson: plumbs planFallback / executeFallback through to file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-profile-write-'));
  try {
    writeProfilesJson([ANTHROPIC_PLAN, DEEPSEEK], {
      outputDir: tmpDir,
      planChoice: { mode: 'plan', model: 'claude-opus-4-7' },
      planFallback: [{ mode: 'deepseek', model: 'deepseek-v4-flash' }],
      executeChoice: { mode: 'deepseek', model: 'deepseek-v4-pro' },
      executeFallback: [{ mode: 'plan', model: 'claude-haiku-4-5' }],
    });
    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, 'profiles.json'), 'utf-8'));
    assert.ok(Array.isArray(content.profiles.plan.fallback));
    assert.equal(content.profiles.plan.fallback[0].model, 'deepseek-v4-flash');
    assert.equal(content.profiles.plan.fallback[0].backend, 'pi');
    assert.ok(Array.isArray(content.profiles.execute.fallback));
    assert.equal(content.profiles.execute.fallback[0].model, 'claude-haiku-4-5');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('writeProfilesJson: overwrite=true forces overwrite of existing plan/execute', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-profile-write-'));
  try {
    const existing = {
      defaultProfile: 'plan',
      profiles: { plan: { model: 'old' }, execute: { model: 'old' } },
    };
    fs.writeFileSync(path.join(tmpDir, 'profiles.json'), JSON.stringify(existing));
    writeProfilesJson([ANTHROPIC_PLAN], { outputDir: tmpDir, overwrite: true });
    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, 'profiles.json'), 'utf-8'));
    assert.notEqual(content.profiles.plan.model, 'old');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── extraProfiles: additional standalone named profiles ─────────

test('generateProfiles: extraProfiles creates additional profile entries keyed by model name', () => {
  const result = generateProfiles([ANTHROPIC_PLAN, DEEPSEEK], {
    planChoice: { mode: 'plan', model: 'claude-opus-4-7' },
    extraProfiles: [
      { mode: 'deepseek', model: 'deepseek-v4-pro' },
      { mode: 'plan', model: 'claude-sonnet-4-6' },
    ],
  });
  // plan + execute + 2 extra
  assert.equal(Object.keys(result.profiles).length, 4);
  assert.ok(result.profiles['deepseek-v4-pro']);
  assert.equal(result.profiles['deepseek-v4-pro'].model, 'deepseek-v4-pro');
  assert.equal(result.profiles['deepseek-v4-pro'].mode, 'deepseek');
  assert.equal(result.profiles['deepseek-v4-pro'].backend, 'pi');
  assert.ok(result.profiles['claude-sonnet-4-6']);
  assert.equal(result.profiles['claude-sonnet-4-6'].model, 'claude-sonnet-4-6');
  assert.equal(result.profiles['claude-sonnet-4-6'].mode, 'plan');
  assert.equal(result.profiles['claude-sonnet-4-6'].backend, 'claude');
});

test('generateProfiles: extraProfiles does not overwrite plan/execute', () => {
  const result = generateProfiles([ANTHROPIC_PLAN, DEEPSEEK], {
    planChoice: { mode: 'plan', model: 'claude-opus-4-7' },
    executeChoice: { mode: 'deepseek', model: 'deepseek-v4-flash' },
    extraProfiles: [
      { mode: 'deepseek', model: 'deepseek-v4-pro' },
    ],
  });
  // plan and execute should retain their explicit choices
  assert.equal(result.profiles.plan.model, 'claude-opus-4-7');
  assert.equal(result.profiles.execute.model, 'deepseek-v4-flash');
  // extra profile exists separately
  assert.equal(result.profiles['deepseek-v4-pro'].model, 'deepseek-v4-pro');
});

test('generateProfiles: extraProfiles sanitizes dotted model names (dots → dashes) into valid profile names', () => {
  const result = generateProfiles([ANTHROPIC_PLAN, OPENAI_CODEX], {
    planChoice: { mode: 'plan', model: 'claude-opus-4-7' },
    extraProfiles: [{ mode: 'openai-codex', model: 'gpt-5.4-mini' }],
  });
  // Profile name has dots replaced with dashes so it passes the profile-name regex…
  assert.ok(result.profiles['gpt-5-4-mini'], 'expected sanitized profile name gpt-5-4-mini');
  assert.equal(result.profiles['gpt-5.4-mini'], undefined, 'dotted name must not be used as a key');
  // …but the model id itself is preserved verbatim (needed for the actual API call).
  assert.equal(result.profiles['gpt-5-4-mini'].model, 'gpt-5.4-mini');
  // And the whole result must be loadable by the server.
  assert.doesNotThrow(() => validateProfilesFile(result));
});

test('generateProfiles: extraProfiles skips names colliding with managed profile names', () => {
  // "plan" and "execute" as model names should be skipped with a warning
  const result = generateProfiles([ANTHROPIC_PLAN], {
    extraProfiles: [
      { mode: 'plan', model: 'plan' },
      { mode: 'plan', model: 'execute' },
      { mode: 'plan', model: 'claude-haiku-4-5' },
    ],
  });
  // Only claude-haiku-4-5 should be added; plan/execute are skipped (name collision)
  assert.ok(result.profiles['claude-haiku-4-5']);
  // plan and execute are managed profiles, not overwritten
  assert.equal(result.profiles.plan.model, 'claude-haiku-4-5'); // default lexicographic
});

test('writeProfilesJson: extraProfiles plumbed through to file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-profile-write-'));
  try {
    writeProfilesJson([ANTHROPIC_PLAN, DEEPSEEK], {
      outputDir: tmpDir,
      planChoice: { mode: 'plan', model: 'claude-opus-4-7' },
      extraProfiles: [
        { mode: 'deepseek', model: 'deepseek-v4-pro' },
        { mode: 'plan', model: 'claude-sonnet-4-6' },
      ],
    });
    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, 'profiles.json'), 'utf-8'));
    assert.ok(content.profiles['deepseek-v4-pro']);
    assert.equal(content.profiles['deepseek-v4-pro'].backend, 'pi');
    assert.ok(content.profiles['claude-sonnet-4-6']);
    assert.equal(content.profiles['claude-sonnet-4-6'].backend, 'claude');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
