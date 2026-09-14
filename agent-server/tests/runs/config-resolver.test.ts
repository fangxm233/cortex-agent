import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const HOME = process.env.CORTEX_HOME!;
const PROFILES = path.join(HOME, 'config', 'profiles.json');
const STATE = path.join(HOME, 'data', 'agent-state.json');

const PROFILES_FILE = {
  defaultProfile: 'fallback',
  profiles: {
    fallback: { model: 'opus', backend: 'claude', mode: 'plan' },
    global: { model: 'sonnet', backend: 'claude', mode: 'api' },
    chan: { model: 'haiku', backend: 'claude', mode: 'api' },
    sess: { model: 'gpt', backend: 'pi', mode: 'openai-codex', provider: 'openai-codex' },
    explicit: { model: 'fable', backend: 'claude', mode: 'plan' },
  },
};

function seed(state: Record<string, unknown>) {
  mkdirSync(path.dirname(PROFILES), { recursive: true });
  mkdirSync(path.dirname(STATE), { recursive: true });
  writeFileSync(PROFILES, JSON.stringify(PROFILES_FILE));
  writeFileSync(STATE, JSON.stringify(state));
}

/** The resolver reads through module-level caches in config.ts (activeProfile, channelProfiles,
 *  channelOverrides), all filled at import — so each case needs its own registry. */
async function freshResolver() {
  vi.resetModules();
  return import('../../src/domain/runs/config-resolver.js');
}

beforeEach(() => { rmSync(STATE, { force: true }); });
afterEach(() => { rmSync(STATE, { force: true }); rmSync(PROFILES, { force: true }); });

test('layer 5 — nothing selected falls through to profiles.defaultProfile', async () => {
  seed({});
  const { resolveRunConfig } = await freshResolver();
  const cfg = resolveRunConfig({ channel: 'web:a' });
  assert.equal(cfg.profileName, 'fallback');
  assert.equal(cfg.profile.model, 'opus');
  assert.equal(cfg.resolved, true);
});

test('layer 4 — the global activeProfile beats the default', async () => {
  seed({ activeProfile: 'global' });
  const { resolveRunConfig } = await freshResolver();
  assert.equal(resolveRunConfig({ channel: 'web:a' }).profileName, 'global');
});

test('layer 3 — the channel profile beats the global one, for that channel only', async () => {
  seed({ activeProfile: 'global', channelProfiles: { 'web:a': 'chan' } });
  const { resolveRunConfig } = await freshResolver();
  assert.equal(resolveRunConfig({ channel: 'web:a' }).profileName, 'chan');
  assert.equal(resolveRunConfig({ channel: 'web:b' }).profileName, 'global');
  assert.equal(resolveRunConfig({}).profileName, 'global', 'no channel means the global one');
});

test('layer 2 — the session keeps the profile it was started under', async () => {
  seed({ activeProfile: 'global', channelProfiles: { 'web:a': 'chan' } });
  const { resolveRunConfig } = await freshResolver();
  const cfg = resolveRunConfig({ channel: 'web:a', session: { profileName: 'sess' } });
  assert.equal(cfg.profileName, 'sess');
  assert.equal(cfg.profile.backend, 'pi', 'and its backend comes with it');
});

test('layer 1 — an explicit override beats everything', async () => {
  seed({ activeProfile: 'global', channelProfiles: { 'web:a': 'chan' } });
  const { resolveRunConfig } = await freshResolver();
  const cfg = resolveRunConfig({
    channel: 'web:a', session: { profileName: 'sess' }, override: 'explicit',
  });
  assert.equal(cfg.profileName, 'explicit');
  assert.equal(cfg.profile.model, 'fable');
});

test('empty-string and null selections are skipped, not honoured', async () => {
  seed({ activeProfile: 'global' });
  const { resolveRunConfig } = await freshResolver();
  assert.equal(resolveRunConfig({ channel: 'web:a', override: '' }).profileName, 'global');
  assert.equal(
    resolveRunConfig({ channel: 'web:a', session: { profileName: null } }).profileName, 'global',
  );
});

test("init's '__active__' placeholder resolves to the default profile", async () => {
  seed({ activeProfile: '__active__' });
  const { resolveRunConfig } = await freshResolver();
  assert.equal(resolveRunConfig({ channel: 'web:a' }).profileName, 'fallback');
});

test('an unknown name survives, and borrows the channel backend it would have used', async () => {
  seed({ activeProfile: 'global', channelProfiles: { 'web:pi': 'sess' } });
  const { resolveRunConfig } = await freshResolver();

  const onClaude = resolveRunConfig({ channel: 'web:a', override: 'ghost' });
  assert.equal(onClaude.resolved, false);
  assert.equal(onClaude.profileName, 'ghost', 'the bad name must reach the run, which rejects it');
  assert.equal(onClaude.profile.backend, 'claude');
  assert.equal(onClaude.profile.mode, 'api', "the channel's own profile, not a global");
  assert.equal(onClaude.profile.model, '', 'nothing is invented for the model');

  // The point of borrowing per channel: a PI channel no longer gets a Claude execution record.
  const onPi = resolveRunConfig({ channel: 'web:pi', override: 'ghost' });
  assert.equal(onPi.profile.backend, 'pi');
});

test('a channel model override is reported beside the profile, never folded into it', async () => {
  seed({ activeProfile: 'global', channelOverrides: { 'web:a': { model: 'haiku' } } });
  const { resolveRunConfig } = await freshResolver();
  const cfg = resolveRunConfig({ channel: 'web:a' });
  assert.equal(cfg.modelOverride, 'haiku');
  assert.equal(cfg.profile.model, 'sonnet', 'the profile still says what the profile says');
  assert.equal(resolveRunConfig({ channel: 'web:b' }).modelOverride, null);
  assert.equal(resolveRunConfig({}).modelOverride, null, 'an override is channel-scoped');
});

test('resolveRunBackend is the resolved profile backend', async () => {
  seed({ activeProfile: 'global', channelProfiles: { 'web:pi': 'sess' } });
  const { resolveRunBackend } = await freshResolver();
  assert.equal(resolveRunBackend({ channel: 'web:a' }), 'claude');
  assert.equal(resolveRunBackend({ channel: 'web:pi' }), 'pi');
});

test('a corrupt profiles.json yields the documented floor instead of throwing', async () => {
  seed({ activeProfile: 'global' });
  writeFileSync(PROFILES, '{ broken');
  const { resolveRunConfig } = await freshResolver();
  const cfg = resolveRunConfig({ channel: 'web:a' });
  assert.equal(cfg.resolved, false);
  assert.equal(cfg.profile.backend, 'claude');
  assert.equal(cfg.profile.mode, 'plan');
});
