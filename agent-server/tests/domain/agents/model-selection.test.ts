import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

// The write side of a channel's model selection. The rules under test are the product ones:
// the profile is the base, a live conversation cannot change backend, a level must be one the
// backend accepts, and picking a provider the home already has a profile for lands on that profile.

const HOME = process.env.CORTEX_HOME!;
const PROFILES = path.join(HOME, 'config', 'profiles.json');
const STATE = path.join(HOME, 'data', 'agent-state.json');

const PROFILES_FILE = {
  defaultProfile: 'opus',
  profiles: {
    opus: { model: 'claude-opus-5', backend: 'claude', mode: 'plan', thinking: 'medium' },
    sonnet: { model: 'claude-sonnet-5', backend: 'claude', mode: 'plan' },
    ds: { model: 'deepseek-v4-flash', backend: 'pi', mode: 'deepseek', provider: 'deepseek' },
    codex: { model: 'gpt-6-astra', backend: 'pi', mode: 'openai-codex', provider: 'openai-codex' },
  },
};

/** Turns are what makes a conversation "live"; the registry write is best-effort and irrelevant here. */
let turns: Record<string, number> = {};

vi.mock('@store/conversation-ledger-repo.js', () => ({
  conversationLedger: {
    getConversation: async (channel: string) => ({ turns: Array(turns[channel] ?? 0).fill({}) }),
  },
}));

vi.mock('@store/session-registry-repo.js', () => ({
  sessionStore: {
    getActiveSessionName: async () => null,
    updateSession: async () => undefined,
  },
}));

function seed(state: Record<string, unknown> = {}) {
  mkdirSync(path.dirname(PROFILES), { recursive: true });
  mkdirSync(path.dirname(STATE), { recursive: true });
  writeFileSync(PROFILES, JSON.stringify(PROFILES_FILE));
  writeFileSync(STATE, JSON.stringify(state));
}

async function freshSelection() {
  vi.resetModules();
  return import('../../../src/domain/agents/model-selection.js');
}

function storedOverride(channel: string): unknown {
  return JSON.parse(readFileSync(STATE, 'utf8')).channelOverrides?.[channel] ?? null;
}

/** The seed a brand-new draft composer opens on. */
function storedSeed(): unknown {
  return JSON.parse(readFileSync(STATE, 'utf8')).selectionDefault ?? null;
}

beforeEach(() => { turns = {}; rmSync(STATE, { force: true }); });
afterEach(() => { rmSync(STATE, { force: true }); rmSync(PROFILES, { force: true }); });

test('a model and a level land on the channel and are reported back as effective', async () => {
  seed({ activeProfile: 'opus' });
  const { applyChannelSelection } = await freshSelection();
  const result = await applyChannelSelection({
    channel: 'web:a', model: 'claude-sonnet-5', thinking: 'xhigh',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    { model: result.model, thinking: result.thinking, profile: result.profileName },
    { model: 'claude-sonnet-5', thinking: 'xhigh', profile: 'opus' },
  );
  assert.deepEqual(storedOverride('web:a'), { model: 'claude-sonnet-5', thinking: 'xhigh' });
});

test('null clears one field and leaves the other standing', async () => {
  seed({ activeProfile: 'opus', channelOverrides: { 'web:a': { model: 'claude-sonnet-5', thinking: 'xhigh' } } });
  const { applyChannelSelection } = await freshSelection();
  const result = await applyChannelSelection({ channel: 'web:a', model: null });
  assert.equal(result.model, 'claude-opus-5', 'back to what the profile says');
  assert.equal(result.thinking, 'xhigh');
  assert.deepEqual(storedOverride('web:a'), { thinking: 'xhigh' });
});

test('picking a profile runs it as declared — the old selection is dropped', async () => {
  seed({ activeProfile: 'opus', channelOverrides: { 'web:a': { model: 'claude-haiku-4-5', thinking: 'max' } } });
  const { applyChannelSelection } = await freshSelection();
  const result = await applyChannelSelection({ channel: 'web:a', profileName: 'sonnet' });
  assert.equal(result.profileName, 'sonnet');
  assert.equal(result.model, 'claude-sonnet-5');
  assert.equal(result.thinking, null);
  assert.equal(storedOverride('web:a'), null);
});

test('a profile and a selection in ONE call keep the selection', async () => {
  seed({ activeProfile: 'opus' });
  const { applyChannelSelection } = await freshSelection();
  const result = await applyChannelSelection({
    channel: 'web:a', profileName: 'sonnet', model: 'claude-haiku-4-5', thinking: 'low',
  });
  assert.equal(result.profileName, 'sonnet');
  assert.equal(result.model, 'claude-haiku-4-5');
  assert.deepEqual(storedOverride('web:a'), { model: 'claude-haiku-4-5', thinking: 'low' });
});

test('a live conversation cannot move to another backend', async () => {
  seed({ activeProfile: 'opus' });
  turns['web:a'] = 3;
  const { applyChannelSelection } = await freshSelection();
  const result = await applyChannelSelection({ channel: 'web:a', profileName: 'ds' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'cross-backend-live-session');
  assert.equal(result.currentBackend, 'claude');
  assert.equal(result.targetBackend, 'pi');
});

test('a fresh session may move to another backend', async () => {
  seed({ activeProfile: 'opus' });
  const { applyChannelSelection } = await freshSelection();
  const result = await applyChannelSelection({ channel: 'web:a', profileName: 'ds' });
  assert.equal(result.backend, 'pi');
  assert.equal(result.backendChanged, true);
});

test("a level the target backend does not accept is refused, and nothing is written", async () => {
  seed({ activeProfile: 'opus' });
  const { applyChannelSelection } = await freshSelection();
  // 'max' is claude-only; the request also switches to a pi profile, so the whole call must fail
  // BEFORE the switch rather than leave the channel half-moved.
  const result = await applyChannelSelection({ channel: 'web:a', profileName: 'ds', thinking: 'max' });
  assert.equal(result.reason, 'invalid-thinking');
  assert.deepEqual(result.allowed, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  const { readChannelSelection } = await freshSelection();
  assert.equal(readChannelSelection('web:a').profileName, 'opus', 'the channel never moved');
});

test('a provider on a claude channel is refused', async () => {
  seed({ activeProfile: 'opus' });
  const { applyChannelSelection } = await freshSelection();
  const result = await applyChannelSelection({ channel: 'web:a', provider: 'deepseek', model: 'x' });
  assert.equal(result.reason, 'provider-not-supported');
});

test('choosing a provider the home has a profile for moves the channel to that profile', async () => {
  seed({ activeProfile: 'ds' });
  const { applyChannelSelection } = await freshSelection();
  const result = await applyChannelSelection({
    channel: 'web:a', provider: 'openai-codex', model: 'gpt-5.6-sol',
  });
  assert.equal(result.profileName, 'codex', 'its route and env are the configured ones');
  assert.equal(result.provider, 'openai-codex');
  assert.equal(result.model, 'gpt-5.6-sol');
  assert.deepEqual(storedOverride('web:a'), { model: 'gpt-5.6-sol' }, 'no provider override needed');
});

test('a provider with no profile of its own is carried as an override', async () => {
  seed({ activeProfile: 'ds' });
  const { applyChannelSelection } = await freshSelection();
  const result = await applyChannelSelection({ channel: 'web:a', provider: 'zai', model: 'glm-5' });
  assert.equal(result.profileName, 'ds', 'the base profile stays');
  assert.equal(result.provider, 'zai');
  assert.deepEqual(storedOverride('web:a'), { model: 'glm-5', provider: 'zai' });
});

test('an unknown profile is refused', async () => {
  seed({ activeProfile: 'opus' });
  const { applyChannelSelection } = await freshSelection();
  const result = await applyChannelSelection({ channel: 'web:a', profileName: 'ghost' });
  assert.equal(result.reason, 'unknown-profile');
});

test('readChannelSelection reports the profile when the channel selected nothing', async () => {
  seed({ activeProfile: 'opus' });
  const { readChannelSelection } = await freshSelection();
  assert.deepEqual(readChannelSelection('web:a'), {
    profileName: 'opus', backend: 'claude', model: 'claude-opus-5', provider: null,
    thinking: 'medium', mode: 'plan', override: null,
  });
});

// ── The billing route (anthropic plan vs api) ────────────────────────────────────────────────────

/** A gateway.yaml the rule can read without the host owning one. */
const GATEWAY = { endpoints: { anthropic: { plan: {}, api: {} }, deepseek: { deepseek: {} } } } as never;

test('a route the gateway declares for the endpoint is accepted and stored', async () => {
  seed({ activeProfile: 'opus' });
  const { applyChannelSelection } = await freshSelection();
  const result = await applyChannelSelection({ channel: 'web:a', mode: 'api', readGateway: () => GATEWAY });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'api', 'the next turn bills to the metered key');
  assert.deepEqual(storedOverride('web:a'), { mode: 'api' });
});

test('a route the endpoint does not declare is refused, and says what it does have', async () => {
  seed({ activeProfile: 'opus' });
  const { applyChannelSelection } = await freshSelection();
  const result = await applyChannelSelection({ channel: 'web:a', mode: 'bedrock', readGateway: () => GATEWAY });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid-mode');
  assert.deepEqual(result.allowed, ['plan', 'api']);
  assert.equal(storedOverride('web:a'), null, 'a refused route leaves the channel untouched');
});

test('an unreadable gateway.yaml cannot refuse a route — the run falls back to a direct connection', async () => {
  seed({ activeProfile: 'opus' });
  const { applyChannelSelection } = await freshSelection();
  const result = await applyChannelSelection({ channel: 'web:a', mode: 'api', readGateway: () => null });
  assert.equal(result.ok, true);
});

test('moving to another provider drops the route that belonged to the old endpoint', async () => {
  seed({ activeProfile: 'ds' });
  const { applyChannelSelection } = await freshSelection();
  await applyChannelSelection({ channel: 'web:a', mode: 'deepseek', readGateway: () => GATEWAY });
  assert.deepEqual(storedOverride('web:a'), { mode: 'deepseek' });

  // 'codex' has a profile of its own, so the channel moves there and the stale route must not ride along.
  const moved = await applyChannelSelection({ channel: 'web:a', provider: 'openai-codex', readGateway: () => GATEWAY });
  assert.equal(moved.ok, true);
  assert.equal(moved.profileName, 'codex');
  assert.equal(moved.mode, 'openai-codex', 'the route is re-derived from the new endpoint');
});

test('a second model from an override-only provider keeps the provider pointed where it was', async () => {
  // 'glm' has no profile of its own, so the provider can only live as an override.
  seed({ activeProfile: 'ds' });
  const { applyChannelSelection } = await freshSelection();

  const first = await applyChannelSelection({ channel: 'web:a', provider: 'glm', model: 'glm-5' });
  assert.equal(first.ok, true);
  assert.deepEqual(storedOverride('web:a'), { provider: 'glm', model: 'glm-5' });

  // Picking another model from the SAME provider must not read the override as "already the
  // profile's provider" and drop it — that would route a glm model through deepseek.
  const second = await applyChannelSelection({ channel: 'web:a', provider: 'glm', model: 'glm-6' });
  assert.equal(second.ok, true);
  assert.equal(second.provider, 'glm');
  assert.deepEqual(storedOverride('web:a'), { provider: 'glm', model: 'glm-6' });
});

test('picking the profile\'s own provider carries no override', async () => {
  seed({ activeProfile: 'ds' });
  const { applyChannelSelection } = await freshSelection();
  const result = await applyChannelSelection({ channel: 'web:a', provider: 'deepseek', model: 'deepseek-v4' });
  assert.equal(result.ok, true);
  assert.deepEqual(storedOverride('web:a'), { model: 'deepseek-v4' });
});

test('a pick in the app becomes what the next new conversation opens on', async () => {
  seed({ activeProfile: 'opus' });
  const { applyChannelSelection } = await freshSelection();

  await applyChannelSelection({ channel: 'web:a', model: 'claude-sonnet-5', thinking: 'xhigh' });
  // Always with the profile it was made on: a set of overrides with no base is not an engine.
  assert.deepEqual(storedSeed(), { profileName: 'opus', model: 'claude-sonnet-5', thinking: 'xhigh' });

  // Taking the choice back is itself a statement — the next draft follows the profile too.
  await applyChannelSelection({ channel: 'web:a', model: null, thinking: null });
  assert.deepEqual(storedSeed(), { profileName: 'opus' });
});

test('a platform channel does not decide what the desktop composer opens on', async () => {
  seed({ activeProfile: 'opus' });
  const { applyChannelSelection } = await freshSelection();

  await applyChannelSelection({ channel: 'web:a', model: 'claude-sonnet-5' });
  // `!thinking` in Slack changes that channel and nothing else: its profile was chosen for it.
  const result = await applyChannelSelection({ channel: 'slack:C1', thinking: 'max' });
  assert.equal(result.ok, true);
  assert.equal(result.thinking, 'max', 'the platform channel still got its level');
  assert.deepEqual(storedSeed(), { profileName: 'opus', model: 'claude-sonnet-5' });
});
