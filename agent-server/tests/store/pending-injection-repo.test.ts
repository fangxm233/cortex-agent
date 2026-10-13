import { test } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  PendingInjectionRepo,
  type PendingInjectionRecord,
} from '../../src/store/pending-injection-repo.js';

function file(name: string): string {
  return path.join(process.env.CORTEX_HOME!, 'data', `pending-${name}.json`);
}

function record(id: string, sessionId = 'sess-1'): PendingInjectionRecord {
  return {
    id,
    sessionId,
    channel: `web:${sessionId}`,
    messageId: `web-${id}`,
    backend: 'claude',
    profileName: 'default',
    text: `message ${id}`,
    createdAt: `2026-07-26T00:00:0${id.slice(-1)}.000Z`,
  };
}

test('legacy pending sessionName is ignored in memory without migrating disk', async () => {
  const storeFile = file('legacy');
  const legacy = JSON.stringify({ records: {
    'pin-legacy': { ...record('pin-legacy'), sessionName: 'cortex-legacy' },
  } });
  await fs.mkdir(path.dirname(storeFile), { recursive: true });
  await fs.writeFile(storeFile, legacy);
  const repo = new PendingInjectionRepo(storeFile);
  const [loaded] = await repo.listAll();
  assert.equal((loaded as any).sessionName, undefined);
  assert.equal(loaded.sessionId, 'sess-1');
  assert.equal(await fs.readFile(storeFile, 'utf8'), legacy);
});

test('pending injection survives a fresh repo instance and remains session-scoped', async () => {
  const storeFile = file('reopen');
  const first = new PendingInjectionRepo(storeFile);
  await first.add(record('pin-1', 'sess-1'));
  await first.add(record('pin-2', 'sess-2'));
  await first.flush();

  const reopened = new PendingInjectionRepo(storeFile);
  assert.deepEqual((await reopened.listBySession('sess-1')).map((r) => r.id), ['pin-1']);
  assert.deepEqual((await reopened.listBySession('sess-2')).map((r) => r.id), ['pin-2']);
  assert.equal((await reopened.listAll()).length, 2);
});

test('remove is idempotent and a removed pending injection stays removed after reopen', async () => {
  const storeFile = file('remove');
  const repo = new PendingInjectionRepo(storeFile);
  await repo.add(record('pin-remove'));
  assert.equal(await repo.remove('pin-remove'), true);
  assert.equal(await repo.remove('pin-remove'), false);
  await repo.flush();

  assert.deepEqual(await new PendingInjectionRepo(storeFile).listAll(), []);
});

test('concurrent adds do not lose records', async () => {
  const repo = new PendingInjectionRepo(file('concurrent'));
  await Promise.all(Array.from({ length: 12 }, (_, i) => repo.add(record(`pin-${i}`))));
  const ids = (await repo.listAll()).map((r) => r.id).sort();
  assert.equal(ids.length, 12);
  assert.equal(new Set(ids).size, 12);
});

test('returned records are copies, not mutable references into the repo cache', async () => {
  const repo = new PendingInjectionRepo(file('copy'));
  await repo.add(record('pin-copy'));
  const listed = await repo.listAll();
  listed[0].text = 'mutated by caller';
  assert.equal((await repo.listAll())[0].text, 'message pin-copy');
});
