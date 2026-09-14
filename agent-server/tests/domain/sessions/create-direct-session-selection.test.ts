import '../../_test-home.js';
import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

// What a draft composer carries into the session it creates. Two things happen, and they are the
// same rule the live picker runs (`applyChannelSelection`): the stated selection lands on the new
// channel, and it becomes the seed the NEXT new conversation opens on.
//
// The case under guard is the EMPTY selection — "follow the profile". That is how a user takes a
// model back in a draft, and it used to be dropped on the floor: the seed kept the model that had
// just been abandoned, so every later draft re-opened on it, however many times it was cleared.

const HOME = process.env.CORTEX_HOME!;
const PROFILES = path.join(HOME, 'config', 'profiles.json');
const STATE = path.join(HOME, 'data', 'agent-state.json');

const PROFILES_FILE = {
  defaultProfile: 'opus',
  profiles: {
    opus: { model: 'claude-opus-5', backend: 'claude', mode: 'plan', thinking: 'xhigh' },
    sonnet: { model: 'claude-sonnet-5', backend: 'claude', mode: 'plan' },
  },
};

function seed(state: Record<string, unknown> = {}): void {
  mkdirSync(path.dirname(PROFILES), { recursive: true });
  mkdirSync(path.dirname(STATE), { recursive: true });
  writeFileSync(PROFILES, JSON.stringify(PROFILES_FILE));
  writeFileSync(STATE, JSON.stringify(state));
}

/** Re-import with the state file as written: config.ts reads agent-state.json at import time. */
async function freshLifecycle() {
  vi.resetModules();
  return import('../../../src/domain/sessions/session-lifecycle.js');
}

function deps(): any {
  return {
    sessionStore: { generateSessionName: async () => 'cortex-new', registerSession: async () => {} },
    setChannelSession: async () => {},
    initConversation: async () => {},
    resolveBackend: () => 'claude',
  };
}

function storedOverride(channel: string): unknown {
  return JSON.parse(readFileSync(STATE, 'utf8')).channelOverrides?.[channel] ?? null;
}

/** The seed a brand-new draft composer opens on. */
function storedSeed(): unknown {
  return JSON.parse(readFileSync(STATE, 'utf8')).selectionDefault ?? null;
}

beforeEach(() => { rmSync(STATE, { force: true }); });
afterEach(() => { rmSync(STATE, { force: true }); rmSync(PROFILES, { force: true }); });

test('a stated selection lands on the new channel and seeds the next conversation', async () => {
  seed({ activeProfile: 'opus' });
  const { createDirectSession } = await freshLifecycle();

  const { sessionId } = await createDirectSession(deps(), {
    projectId: 'p', profileName: 'opus', selection: { model: 'claude-sonnet-5', thinking: 'low' },
  });

  assert.deepEqual(storedOverride(`web:${sessionId}`), { model: 'claude-sonnet-5', thinking: 'low' },
    'the first turn already runs what the draft picked');
  assert.deepEqual(storedSeed(), { profileName: 'opus', model: 'claude-sonnet-5', thinking: 'low' },
    'and the next new conversation opens on it');
});

test('a draft cleared back to its profile drops the model from the seed', async () => {
  // The state a user is left in after picking a model once: the seed carries it, so every new
  // conversation opens on it until something says otherwise.
  seed({
    activeProfile: 'opus',
    selectionDefault: { profileName: 'opus', model: 'claude-haiku-4-5', thinking: 'low' },
  });
  const { createDirectSession } = await freshLifecycle();

  // "Follow the profile" in the draft: a selection with nothing in it. It is a statement, not
  // silence — the composer said to run the profile as declared.
  const { sessionId } = await createDirectSession(deps(), {
    projectId: 'p', profileName: 'opus', selection: {},
  });

  assert.equal(storedOverride(`web:${sessionId}`), null, 'the session runs its profile as declared');
  assert.deepEqual(storedSeed(), { profileName: 'opus' },
    'and the next new conversation no longer opens on the model that was taken back');
});

test('an empty selection still records the profile the draft chose', async () => {
  seed({
    activeProfile: 'opus',
    selectionDefault: { profileName: 'opus', model: 'claude-haiku-4-5' },
  });
  const { createDirectSession } = await freshLifecycle();

  await createDirectSession(deps(), { projectId: 'p', profileName: 'sonnet', selection: {} });

  assert.deepEqual(storedSeed(), { profileName: 'sonnet' },
    'the seed follows the profile the composer moved to, with no override left hanging on it');
});

test('a create with no composer behind it leaves the seed alone', async () => {
  const untouched = { profileName: 'opus', model: 'claude-haiku-4-5', thinking: 'low' };
  seed({ activeProfile: 'opus', selectionDefault: untouched });
  const { createDirectSession } = await freshLifecycle();

  // sessions.create / an issue's session: no draft composer, so nothing was stated and the seed is
  // not a statement of theirs to make.
  await createDirectSession(deps(), { projectId: 'p' });

  assert.deepEqual(storedSeed(), untouched, 'the last composer pick still stands');
});
