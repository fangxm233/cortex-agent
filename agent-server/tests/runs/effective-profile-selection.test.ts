import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

// What `effectiveProfile` owes the selection feature: the channel's chosen model / provider /
// thinking reach the primary attempt, the gateway route follows the provider, nothing the profile
// declares can silently out-rank the choice — and the fallback chain stays the profile's own.

const HOME = process.env.CORTEX_HOME!;
const PROFILES = path.join(HOME, 'config', 'profiles.json');
const STATE = path.join(HOME, 'data', 'agent-state.json');

const PROFILES_FILE = {
  defaultProfile: 'opus',
  profiles: {
    opus: {
      model: 'claude-opus-5', backend: 'claude', mode: 'plan', thinking: 'medium',
      extraOption: { '--effort': 'low', '--verbose': '1' },
      fallback: [{ model: 'claude-haiku-4-5', mode: 'api' }],
    },
    ds: {
      model: 'deepseek-v4-flash', backend: 'pi', mode: 'deepseek', provider: 'deepseek',
      maxOutputTokens: 8192, extraOption: { '--thinking': 'off' },
    },
    codex: { model: 'gpt-6-astra', backend: 'pi', mode: 'openai-codex', provider: 'openai-codex' },
  },
};

function seed(state: Record<string, unknown>) {
  mkdirSync(path.dirname(PROFILES), { recursive: true });
  mkdirSync(path.dirname(STATE), { recursive: true });
  writeFileSync(PROFILES, JSON.stringify(PROFILES_FILE));
  writeFileSync(STATE, JSON.stringify(state));
}

/** config.ts caches the channel overrides at import, so each case needs its own registry. */
async function freshResolver() {
  vi.resetModules();
  return import('../../src/domain/runs/config-resolver.js');
}

beforeEach(() => { rmSync(STATE, { force: true }); });
afterEach(() => { rmSync(STATE, { force: true }); rmSync(PROFILES, { force: true }); });

test('no selection leaves the profile exactly as declared', async () => {
  seed({ activeProfile: 'opus' });
  const { resolveRunConfig, effectiveProfile } = await freshResolver();
  const config = resolveRunConfig({ channel: 'web:a' });
  assert.equal(effectiveProfile(config), config.profile, 'the same object, not a copy');
});

test('a model selection replaces the primary model and leaves the fallback chain alone', async () => {
  seed({ activeProfile: 'opus', channelOverrides: { 'web:a': { model: 'claude-sonnet-5' } } });
  const { resolveRunConfig, effectiveProfile } = await freshResolver();
  const profile = effectiveProfile(resolveRunConfig({ channel: 'web:a' }));
  assert.equal(profile.model, 'claude-sonnet-5');
  assert.deepEqual(profile.fallback.map((entry) => entry.model), ['claude-haiku-4-5'],
    'the profile keeps its stated recovery path');
});

test('a thinking selection wins, and the extraOption that would out-rank it is dropped', async () => {
  seed({ activeProfile: 'opus', channelOverrides: { 'web:a': { thinking: 'xhigh' } } });
  const { resolveRunConfig, effectiveProfile } = await freshResolver();
  const profile = effectiveProfile(resolveRunConfig({ channel: 'web:a' }));
  assert.equal(profile.thinking, 'xhigh');
  assert.equal('--effort' in profile.extraOption, false, 'claude appends extraOption after --effort');
  assert.equal(profile.extraOption['--verbose'], '1', 'unrelated flags survive');
});

test("the profile's own extraOption is not mutated by the selection", async () => {
  seed({ activeProfile: 'opus', channelOverrides: { 'web:a': { thinking: 'xhigh' } } });
  const { resolveRunConfig, effectiveProfile } = await freshResolver();
  const config = resolveRunConfig({ channel: 'web:a' });
  effectiveProfile(config);
  assert.equal(config.profile.extraOption['--effort'], 'low');
});

test("pi's own thinking flag is the one dropped on a pi profile", async () => {
  seed({ activeProfile: 'ds', channelOverrides: { 'web:a': { thinking: 'high' } } });
  const { resolveRunConfig, effectiveProfile } = await freshResolver();
  const profile = effectiveProfile(resolveRunConfig({ channel: 'web:a' }));
  assert.equal(profile.thinking, 'high');
  assert.deepEqual(profile.extraOption, {});
});

test('a provider selection re-routes through the profile that already uses that provider', async () => {
  seed({
    activeProfile: 'ds',
    channelOverrides: { 'web:a': { provider: 'openai-codex', model: 'gpt-5.6-sol' } },
  });
  const { resolveRunConfig, effectiveProfile } = await freshResolver();
  const profile = effectiveProfile(resolveRunConfig({ channel: 'web:a' }));
  assert.equal(profile.provider, 'openai-codex');
  assert.equal(profile.mode, 'openai-codex', "codex's own profile states the route");
  assert.equal(profile.model, 'gpt-5.6-sol');
  assert.equal(profile.maxOutputTokens, null, "the base profile's cap described its own model");
});

test('an unprofiled provider falls back to the gateway naming convention (mode = provider)', async () => {
  seed({ activeProfile: 'ds', channelOverrides: { 'web:a': { provider: 'zai', model: 'glm-5' } } });
  const { resolveRunConfig, effectiveProfile } = await freshResolver();
  const profile = effectiveProfile(resolveRunConfig({ channel: 'web:a' }));
  assert.equal(profile.provider, 'zai');
  assert.equal(profile.mode, 'zai');
});

test('a provider left over on a claude profile is ignored, not applied', async () => {
  seed({ activeProfile: 'opus', channelOverrides: { 'web:a': { provider: 'deepseek' } } });
  const { resolveRunConfig, effectiveProfile } = await freshResolver();
  const profile = effectiveProfile(resolveRunConfig({ channel: 'web:a' }));
  assert.equal(profile.provider, null, 'a claude run must not be re-labelled with a pi provider');
  assert.equal(profile.mode, 'plan');
});

test('the selection is channel-scoped and reported beside the profile', async () => {
  seed({
    activeProfile: 'opus',
    channelOverrides: { 'web:a': { model: 'claude-sonnet-5', thinking: 'high' } },
  });
  const { resolveRunConfig } = await freshResolver();
  const mine = resolveRunConfig({ channel: 'web:a' });
  assert.deepEqual(mine.override, { model: 'claude-sonnet-5', thinking: 'high' });
  assert.equal(mine.modelOverride, 'claude-sonnet-5', 'the model keeps its own display field');
  assert.equal(mine.profile.model, 'claude-opus-5', 'the profile still says what the profile says');
  assert.equal(resolveRunConfig({ channel: 'web:b' }).override, null);
});
