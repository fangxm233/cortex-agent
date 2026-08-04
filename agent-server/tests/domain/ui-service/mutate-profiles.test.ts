// input:  isolated config home and the profiles.* writers
// output: create, update and remove tests over profiles.json
// pos:    Regression coverage for the profiles map writes and guards
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import '../../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildProfileEntry,
  createProfile,
  updateProfile,
  removeProfile,
} from '../../../src/domain/ui-service/mutate/profiles.js';
import {
  profilesCreateInput,
  profilesUpdateInput,
} from '../../../src/domain/ui-service/input-schemas.js';

const BASE = {
  defaultProfile: 'plan',
  profiles: {
    plan: { model: 'claude-opus-5', backend: 'claude', mode: 'plan', thinking: 'xhigh' },
    sol: { model: 'gpt-5-sol', backend: 'pi', mode: 'openai', provider: 'openai' },
  },
};

async function seed(extra?: Record<string, unknown>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'profiles-write-'));
  const file = { ...BASE, ...extra, profiles: { ...BASE.profiles, ...(extra?.profiles as object ?? {}) } };
  await fs.writeFile(path.join(dir, 'profiles.json'), JSON.stringify(file, null, 2) + '\n');
  return dir;
}

async function read(dir: string): Promise<any> {
  return JSON.parse(await fs.readFile(path.join(dir, 'profiles.json'), 'utf8'));
}

// ── create ──────────────────────────────────────────────────────────
test('createProfile appends an entry and leaves the rest of the file untouched', async () => {
  const dir = await seed();
  await createProfile(dir, { name: 'write', model: 'claude-opus-4-6', backend: 'claude', mode: 'plan' });
  const after = await read(dir);
  assert.deepEqual(after.profiles.write, { model: 'claude-opus-4-6', backend: 'claude', mode: 'plan' });
  assert.equal(after.defaultProfile, 'plan');
  assert.deepEqual(after.profiles.plan, BASE.profiles.plan);
  const leftovers = (await fs.readdir(dir)).filter((f) => f.includes('.tmp.'));
  assert.deepEqual(leftovers, [], 'no temp file should be left behind');
});

test('createProfile rejects a duplicate name without writing', async () => {
  const dir = await seed();
  await assert.rejects(
    () => createProfile(dir, { name: 'plan', model: 'other' }),
    (error: any) => error.code === 'invalid-args' && /already exists/.test(error.message),
  );
  assert.deepEqual((await read(dir)).profiles.plan, BASE.profiles.plan);
});

test('createProfile refuses a pi profile with no provider', async () => {
  const dir = await seed();
  await assert.rejects(
    () => createProfile(dir, { name: 'nope', model: 'gpt-5', backend: 'pi' }),
    (error: any) => error.code === 'invalid-args' && /provider/.test(error.message),
  );
  assert.equal((await read(dir)).profiles.nope, undefined);
});

test('createProfile refuses a thinking level the backend does not accept', async () => {
  const dir = await seed();
  // 'max' is a claude effort level; pi's set stops at xhigh.
  await assert.rejects(
    () => createProfile(dir, { name: 'nope', model: 'gpt-5', backend: 'pi', provider: 'openai', thinking: 'max' }),
    (error: any) => error.code === 'invalid-args' && /thinking/.test(error.message),
  );
});

test('createProfile reports a missing profiles.json as bad input, not an internal error', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'profiles-empty-'));
  await assert.rejects(
    () => createProfile(dir, { name: 'x', model: 'm' }),
    (error: any) => error.code === 'invalid-args',
  );
});

// ── update ──────────────────────────────────────────────────────────
test('updateProfile replaces the entry and reports whether anything changed', async () => {
  const dir = await seed();
  const changed = await updateProfile(dir, { name: 'plan', model: 'claude-opus-6', backend: 'claude', mode: 'plan' });
  assert.equal(changed, true);
  const after = await read(dir);
  // thinking was dropped by the draft — the draft is the complete desired state.
  assert.deepEqual(after.profiles.plan, { model: 'claude-opus-6', backend: 'claude', mode: 'plan' });
  assert.equal(await updateProfile(dir, { name: 'plan', model: 'claude-opus-6', backend: 'claude', mode: 'plan' }), false);
});

test('updateProfile preserves extraEnv and fallback, which the editor cannot express', async () => {
  const dir = await seed({
    profiles: {
      rich: {
        model: 'claude-sonnet-4-6',
        backend: 'claude',
        extraEnv: { ANTHROPIC_AUTH_TOKEN: 'secret-value' },
        fallback: [{ model: 'claude-haiku', backend: 'claude' }],
      },
    },
  });
  await updateProfile(dir, { name: 'rich', model: 'claude-opus-5', backend: 'claude', thinking: 'high' });
  const after = await read(dir);
  assert.deepEqual(after.profiles.rich.extraEnv, { ANTHROPIC_AUTH_TOKEN: 'secret-value' });
  assert.deepEqual(after.profiles.rich.fallback, [{ model: 'claude-haiku', backend: 'claude' }]);
  assert.equal(after.profiles.rich.model, 'claude-opus-5');
  assert.equal(after.profiles.rich.thinking, 'high');
});

test('updateProfile refuses a backend switch that invalidates the preserved fallback chain', async () => {
  const dir = await seed({
    profiles: {
      chained: { model: 'claude-opus-5', backend: 'claude', fallback: [{ model: 'claude-haiku' }] },
    },
  });
  // The fallback entry inherits the primary backend; under pi it would need its own provider.
  await assert.rejects(
    () => updateProfile(dir, { name: 'chained', model: 'gpt-5', backend: 'pi', provider: 'openai' }),
    (error: any) => error.code === 'invalid-args' && /fallback\[0\]/.test(error.message),
  );
  assert.equal((await read(dir)).profiles.chained.backend, 'claude');
});

test('updateProfile rejects an unknown name as not-found', async () => {
  const dir = await seed();
  await assert.rejects(
    () => updateProfile(dir, { name: 'ghost', model: 'm' }),
    (error: any) => error.code === 'not-found',
  );
});

test('updateProfile of one entry is not blocked by a broken neighbour', async () => {
  // A hand-edited file can hold an entry the validator rejects; that must not freeze the whole panel.
  const dir = await seed({ profiles: { broken: { backend: 'pi', model: 'x' } } });
  await updateProfile(dir, { name: 'plan', model: 'claude-opus-6', backend: 'claude' });
  const after = await read(dir);
  assert.equal(after.profiles.plan.model, 'claude-opus-6');
  assert.deepEqual(after.profiles.broken, { backend: 'pi', model: 'x' }, 'the broken entry is left as-is');
});

// ── remove ──────────────────────────────────────────────────────────
test('removeProfile deletes one entry and keeps the others', async () => {
  const dir = await seed();
  await removeProfile(dir, { name: 'sol' });
  const after = await read(dir);
  assert.deepEqual(Object.keys(after.profiles), ['plan']);
  assert.equal(after.defaultProfile, 'plan');
});

test('removeProfile refuses to delete the default profile', async () => {
  const dir = await seed();
  await assert.rejects(
    () => removeProfile(dir, { name: 'plan' }),
    (error: any) => error.code === 'invalid-args' && /default profile/.test(error.message),
  );
  assert.ok((await read(dir)).profiles.plan);
});

test('removeProfile refuses to empty the profiles map', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'profiles-one-'));
  await fs.writeFile(
    path.join(dir, 'profiles.json'),
    JSON.stringify({ defaultProfile: 'other', profiles: { only: { model: 'm' } } }, null, 2),
  );
  await assert.rejects(
    () => removeProfile(dir, { name: 'only' }),
    (error: any) => error.code === 'invalid-args' && /last profile/.test(error.message),
  );
});

test('removeProfile rejects an unknown name as not-found', async () => {
  const dir = await seed();
  await assert.rejects(
    () => removeProfile(dir, { name: 'ghost' }),
    (error: any) => error.code === 'not-found',
  );
});

// ── entry assembly ──────────────────────────────────────────────────
test('buildProfileEntry drops omitted fields and an empty extraOption map', () => {
  assert.deepEqual(buildProfileEntry({ model: 'm' }), { model: 'm' });
  assert.deepEqual(buildProfileEntry({ model: 'm', extraOption: {} }), { model: 'm' });
  assert.deepEqual(
    buildProfileEntry({ model: 'm', backend: 'pi', provider: 'deepseek', extraOption: { '--thinking': 'xhigh' } }),
    { model: 'm', backend: 'pi', provider: 'deepseek', extraOption: { '--thinking': 'xhigh' } },
  );
});

// ── schema shape gate ───────────────────────────────────────────────
test('profilesCreateInput rejects an unsafe name, an unknown backend and a bare flag key', () => {
  assert.equal(profilesCreateInput.safeParse({ name: 'a b', model: 'm' }).success, false);
  assert.equal(profilesCreateInput.safeParse({ name: '../etc', model: 'm' }).success, false);
  assert.equal(profilesCreateInput.safeParse({ name: 'ok', model: 'm', backend: 'gemini' }).success, false);
  assert.equal(profilesCreateInput.safeParse({ name: 'ok', model: '' }).success, false);
  assert.equal(
    profilesCreateInput.safeParse({ name: 'ok', model: 'm', extraOption: { thinking: 'x' } }).success,
    false,
  );
  assert.equal(
    profilesUpdateInput.safeParse({ name: 'ok', model: 'm', extraOption: { '--thinking': 'x' } }).success,
    true,
  );
});
