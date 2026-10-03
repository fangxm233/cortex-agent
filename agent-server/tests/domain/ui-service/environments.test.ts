import { test, describe, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CONFIG_DIR } from '../../../src/core/paths.js';
import {
  handleEnvironmentsDelete,
  handleEnvironmentsSave,
  handleEnvironmentsValidate,
} from '../../../src/domain/ui-service/mutate/environments.js';
import {
  handleEnvironmentsGet,
  readEnvironmentEntries,
} from '../../../src/domain/ui-service/query/environments.js';
import { makeUiDeps } from './ui-deps-fixture.js';

// The handlers bind CONFIG_DIR, which the vitest setup file has already pointed at an isolated temp home.
const ENV_DIR = path.join(CONFIG_DIR, 'environments');

function environmentBody(name: string) {
  return { name, description: `${name} environment`, profile: 'plan', persistSession: true, tools: 'Read' };
}

function seedEnvironment(name: string, body: unknown): void {
  mkdirSync(ENV_DIR, { recursive: true });
  writeFileSync(path.join(ENV_DIR, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

const deps = () => makeUiDeps();

beforeEach(() => {
  rmSync(ENV_DIR, { recursive: true, force: true });
  mkdirSync(ENV_DIR, { recursive: true });
});

describe('environments.validate', () => {
  test('reports a clean body as ok without writing anything', async () => {
    const result = await handleEnvironmentsValidate(deps(), { name: 'c', body: environmentBody('c') });
    assert.ok(result.ok);
    assert.equal(result.data.ok, true);
    assert.deepEqual(result.data.errors, []);
    assert.equal(existsSync(path.join(ENV_DIR, 'c.json')), false, 'validate must not write');
  });

  test('reports errors with field anchors', async () => {
    const result = await handleEnvironmentsValidate(deps(), { name: 'c', body: environmentBody('other') });
    assert.ok(result.ok);
    assert.equal(result.data.ok, false);
    assert.ok(result.data.errors.some((e) => e.path === 'name'), JSON.stringify(result.data.errors));
  });
});

describe('environments.save', () => {
  test('creates, then updates with the returned hash', async () => {
    const created = await handleEnvironmentsSave(deps(), { name: 'c', body: environmentBody('c') });
    assert.ok(created.ok, JSON.stringify(created));
    assert.equal(created.data.changed, true);

    const updated = await handleEnvironmentsSave(deps(), {
      name: 'c',
      body: { ...environmentBody('c'), tools: 'Read,Grep' },
      baseHash: created.data.sha256,
    });
    assert.ok(updated.ok, JSON.stringify(updated));
    assert.equal(JSON.parse(readFileSync(path.join(ENV_DIR, 'c.json'), 'utf8')).tools, 'Read,Grep');
  });

  test('an invalid body is rejected as invalid-args and never lands', async () => {
    const result = await handleEnvironmentsSave(deps(), { name: 'c', body: environmentBody('other') });
    assert.equal(result.ok, false);
    assert.equal((result as { code: string }).code, 'invalid-args');
    assert.match((result as { message: string }).message, /^Environment 'c' is not valid: /);
    assert.equal(existsSync(path.join(ENV_DIR, 'c.json')), false);
  });

  test('a stale hash surfaces as a conflict code, so the UI can offer a reload', async () => {
    const created = await handleEnvironmentsSave(deps(), { name: 'c', body: environmentBody('c') });
    assert.ok(created.ok);
    await handleEnvironmentsSave(deps(), {
      name: 'c',
      body: { ...environmentBody('c'), tools: 'Read,Grep' },
      baseHash: created.data.sha256,
    });

    const stale = await handleEnvironmentsSave(deps(), {
      name: 'c',
      body: { ...environmentBody('c'), tools: 'Read,Glob' },
      baseHash: created.data.sha256,
    });
    assert.equal(stale.ok, false);
    assert.equal((stale as { code: string }).code, 'conflict');
    assert.match((stale as { message: string }).message, /^Environment 'c' changed on disk/);
  });
});

describe('environments.delete', () => {
  test('removes the file', async () => {
    seedEnvironment('c', environmentBody('c'));
    const result = await handleEnvironmentsDelete(deps(), { name: 'c' });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(existsSync(path.join(ENV_DIR, 'c.json')), false);
  });

  test('refuses to delete the default environment', async () => {
    seedEnvironment('main', environmentBody('main'));
    const result = await handleEnvironmentsDelete(deps(), { name: 'main' });
    assert.equal(result.ok, false);
    assert.equal((result as { code: string }).code, 'invalid-args');
    assert.match((result as { message: string }).message, /main/);
    assert.equal(existsSync(path.join(ENV_DIR, 'main.json')), true);
  });

  test('a missing environment is not-found', async () => {
    const result = await handleEnvironmentsDelete(deps(), { name: 'ghost' });
    assert.equal(result.ok, false);
    assert.equal((result as { code: string }).code, 'not-found');
    assert.equal((result as { message: string }).message, "Unknown environment: 'ghost'");
  });
});

describe('environments.get', () => {
  test('returns the raw body, hash and validation verdict', async () => {
    seedEnvironment('a', environmentBody('a'));
    const detail = await handleEnvironmentsGet(deps(), { name: 'a' });

    assert.equal(detail.name, 'a');
    assert.equal(detail.body?.name, 'a');
    assert.equal(detail.filePath, path.join(ENV_DIR, 'a.json'));
    assert.deepEqual(detail.errors, []);
    assert.equal(detail.origin, 'custom', 'a test-only environment has no shipped default');
    assert.equal(detail.sha256.length, 64);
  });

  test('a `file:` prompt ref survives the round trip, so an edit cannot inline the prompt', async () => {
    seedEnvironment('c', { ...environmentBody('c'), systemPrompt: 'file:c.md' });
    const detail = await handleEnvironmentsGet(deps(), { name: 'c' });
    assert.equal(detail.body?.systemPrompt, 'file:c.md');
  });
});

describe('environments.list', () => {
  test('flags a broken environment and counts its errors', async () => {
    seedEnvironment('a', environmentBody('a'));
    seedEnvironment('broken', environmentBody('someone-else'));
    const entries = await readEnvironmentEntries(CONFIG_DIR);

    assert.deepEqual(entries.map((e) => e.name), ['a', 'broken']);
    const broken = entries.find((e) => e.name === 'broken');
    assert.equal(broken?.valid, false);
    assert.ok((broken?.errorCount ?? 0) > 0);
    const healthy = entries.find((e) => e.name === 'a');
    assert.equal(healthy?.valid, true);
    assert.equal(healthy?.description, 'a environment');
  });

  test('sets body=null for malformed JSON', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'env-bad-'));
    mkdirSync(path.join(root, 'environments'), { recursive: true });
    writeFileSync(path.join(root, 'environments', 'bad.json'), 'not-json{{{');
    const entries = await readEnvironmentEntries(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'bad');
    assert.equal(entries[0].body, null);
    rmSync(root, { recursive: true, force: true });
  });
});
