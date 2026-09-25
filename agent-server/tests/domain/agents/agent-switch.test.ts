import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

// The write side of a channel's AGENT selection — which execution environment a conversation runs
// in. The rules under test are the product ones: an unknown agent is refused, a switch takes effect
// on the next turn without resetting anything, and an agent that pins a profile on the other
// backend is a backend move — which a live conversation may not make, exactly as `!profile` may not.

const HOME = process.env.CORTEX_HOME!;
const PROFILES = path.join(HOME, 'config', 'profiles.json');
const STATE = path.join(HOME, 'data', 'agent-state.json');

const PROFILES_FILE = {
  defaultProfile: 'opus',
  profiles: {
    opus: { model: 'claude-opus-5', backend: 'claude', mode: 'plan' },
    sonnet: { model: 'claude-sonnet-5', backend: 'claude', mode: 'plan' },
    ds: { model: 'deepseek-v4-flash', backend: 'pi', mode: 'deepseek', provider: 'deepseek' },
  },
};

const AGENTS: Record<string, { name: string; profile: string }> = {
  main: { name: 'main', profile: '__active__' },
  nimbus: { name: 'nimbus', profile: '__active__' },
  orchard: { name: 'orchard', profile: 'sonnet' },
  atlas: { name: 'atlas', profile: 'ds' },
};

/** Turns are what makes a conversation "live" — the same control the profile-switch tests use. */
let turns: Record<string, number> = {};
/** Every `updateSession` the rule performed, so the record sync can be asserted. */
let recordPatches: Array<{ name: string; updates: Record<string, unknown> }> = [];

vi.mock('@store/session-registry-repo.js', () => ({
  sessionStore: {
    getTurns: async (channel: string) => Array(turns[channel] ?? 0).fill({}),
    getActiveSessionName: async () => 'session-1',
    updateSession: async (name: string, updates: Record<string, unknown>) => {
      recordPatches.push({ name, updates });
    },
  },
}));

vi.mock('../../../src/domain/threads/template-loader.js', () => ({
  getAgent: (name: string) => AGENTS[name] ?? null,
}));

function seed(state: Record<string, unknown> = {}) {
  mkdirSync(path.dirname(PROFILES), { recursive: true });
  mkdirSync(path.dirname(STATE), { recursive: true });
  writeFileSync(PROFILES, JSON.stringify(PROFILES_FILE));
  writeFileSync(STATE, JSON.stringify(state));
}

async function freshSwitch() {
  vi.resetModules();
  return import('../../../src/domain/agents/agent-switch.js');
}

function stored(): Record<string, any> {
  return JSON.parse(readFileSync(STATE, 'utf8'));
}

beforeEach(() => { turns = {}; recordPatches = []; rmSync(STATE, { force: true }); });
afterEach(() => { rmSync(STATE, { force: true }); rmSync(PROFILES, { force: true }); });

test('an unknown agent is refused and writes nothing', async () => {
  seed();
  const { switchChannelAgent } = await freshSwitch();
  const res = await switchChannelAgent({ channel: 'web:a', name: 'nosuch' });
  assert.deepEqual(res, { ok: false, reason: 'unknown-agent' });
  assert.equal(stored().channelAgents, undefined);
  assert.deepEqual(recordPatches, []);
});

test('a live conversation may switch to an agent on its own backend', async () => {
  seed({ activeProfile: 'opus' });
  turns['web:a'] = 4;
  const { switchChannelAgent } = await freshSwitch();
  const res = await switchChannelAgent({ channel: 'web:a', name: 'orchard' });
  assert.deepEqual(res, {
    ok: true, agentName: 'orchard', effectiveProfile: 'sonnet', backendChanged: false,
  });
  assert.deepEqual(stored().channelAgents, { 'web:a': 'orchard' });
  // The agent's pinned profile is an override on the run path, never a write to the channel's own.
  assert.equal(stored().channelProfiles, undefined);
  assert.deepEqual(recordPatches, [{ name: 'session-1', updates: { agentName: 'orchard' } }]);
});

test('a live conversation may NOT switch to an agent pinned on the other backend', async () => {
  seed({ activeProfile: 'opus' });
  turns['web:a'] = 1;
  const { switchChannelAgent } = await freshSwitch();
  const res = await switchChannelAgent({ channel: 'web:a', name: 'atlas' });
  assert.deepEqual(res, {
    ok: false, reason: 'cross-backend-live-session', currentBackend: 'claude', targetBackend: 'pi',
  });
  assert.equal(stored().channelAgents, undefined);
  assert.deepEqual(recordPatches, []);
});

test('a fresh conversation may take that same cross-backend agent', async () => {
  seed({ activeProfile: 'opus' });
  const { switchChannelAgent } = await freshSwitch();
  const res = await switchChannelAgent({ channel: 'web:a', name: 'atlas' });
  assert.deepEqual(res, {
    ok: true, agentName: 'atlas', effectiveProfile: 'ds', backendChanged: true,
  });
  assert.deepEqual(stored().channelAgents, { 'web:a': 'atlas' });
});

test('an `__active__` agent follows the channel and can never move its backend', async () => {
  // The channel runs a PI profile; an agent that pins nothing must not be read as a claude move.
  seed({ activeProfile: 'opus', channelProfiles: { 'web:a': 'ds' } });
  turns['web:a'] = 9;
  const { switchChannelAgent } = await freshSwitch();
  const res = await switchChannelAgent({ channel: 'web:a', name: 'nimbus' });
  assert.deepEqual(res, {
    ok: true, agentName: 'nimbus', effectiveProfile: 'ds', backendChanged: false,
  });
});

test('clearing hands the channel back to the global default and clears the record', async () => {
  seed({ defaultAgent: 'main', channelAgents: { 'web:a': 'orchard' } });
  const { clearChannelAgentSelection } = await freshSwitch();
  await clearChannelAgentSelection('web:a');
  assert.equal(stored().channelAgents, undefined, 'an empty map is omitted, like the others');
  assert.deepEqual(recordPatches, [{ name: 'session-1', updates: { agentName: null } }]);
});

test('a pick in the app seeds the next conversation; a pick in a platform channel does not', async () => {
  seed({ activeProfile: 'opus' });
  const { switchChannelAgent } = await freshSwitch();
  await switchChannelAgent({ channel: 'web:a', name: 'orchard' });
  assert.deepEqual(stored().selectionDefault, { agentName: 'orchard' });

  await switchChannelAgent({ channel: 'slack:C1', name: 'nimbus' });
  assert.deepEqual(stored().selectionDefault, { agentName: 'orchard' }, 'unchanged by the Slack pick');
});
