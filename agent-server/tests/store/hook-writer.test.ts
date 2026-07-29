// input:  hook writer API over a temp registry directory
// output: create/update/remove/setEnabled behaviour and guard tests
// pos:    Verifies the registry write side and its source guards
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'vitest';

import {
  createHookEntry,
  removeHookEntry,
  setHookEnabled,
  updateHookEntry,
} from '../../src/store/hook-writer.js';
import { loadHookRegistryRecords } from '../../src/store/hook-registry.js';

function makeRegistry(t: { onTestFinished(callback: () => void): void }): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-writer-'));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeEntry(directory: string, filename: string, entry: unknown): void {
  fs.writeFileSync(path.join(directory, filename), `${JSON.stringify(entry, null, 2)}\n`);
}

function readEntry(directory: string, filename: string): any {
  return JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
}

const USER_ENTRY = {
  id: 'my-hook',
  event: 'agent:pre-tool',
  matcher: 'Edit|Write',
  run: { script: 'my-hook.mjs', timeout: 10 },
};

const MANAGED_ENTRY = {
  id: 'shipped-hook',
  event: 'agent:post-tool',
  run: { script: 'shipped.mjs' },
  version: '2026.7.29',
};

function expectThrows(fn: () => unknown, code: string, messageMatch: RegExp): void {
  try {
    fn();
  } catch (error: any) {
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
    assert.match(error.message, messageMatch);
    return;
  }
  assert.fail('expected the call to throw');
}

// ── setHookEnabled ────────────────────────────────────────────────

test('setHookEnabled flips a user entry and reports the change', (t) => {
  const dir = makeRegistry(t);
  writeEntry(dir, '50-my-hook.json', USER_ENTRY);

  const result = setHookEnabled(dir, 'my-hook', false);

  assert.equal(result.changed, true);
  assert.equal(readEntry(dir, '50-my-hook.json').enabled, false);
});

test('setHookEnabled is idempotent and reports no change on a repeat', (t) => {
  const dir = makeRegistry(t);
  writeEntry(dir, '50-my-hook.json', { ...USER_ENTRY, enabled: false });

  const result = setHookEnabled(dir, 'my-hook', false);

  assert.equal(result.changed, false);
});

test('setHookEnabled treats an absent enabled field as true', (t) => {
  const dir = makeRegistry(t);
  writeEntry(dir, '50-my-hook.json', USER_ENTRY);

  assert.equal(setHookEnabled(dir, 'my-hook', true).changed, false);
});

test('setHookEnabled works on a managed entry and warns about resync', (t) => {
  const dir = makeRegistry(t);
  writeEntry(dir, '01-shipped.json', MANAGED_ENTRY);

  const result = setHookEnabled(dir, 'shipped-hook', false);

  assert.equal(result.changed, true);
  assert.ok(result.warning, 'disabling a managed entry must return a warning');
  assert.match(result.warning!, /sync/i);
});

test('setHookEnabled preserves every other field of the declaration', (t) => {
  const dir = makeRegistry(t);
  writeEntry(dir, '01-shipped.json', MANAGED_ENTRY);

  setHookEnabled(dir, 'shipped-hook', false);

  const written = readEntry(dir, '01-shipped.json');
  assert.equal(written.version, '2026.7.29');
  assert.deepEqual(written.run, { script: 'shipped.mjs' });
  assert.equal(written.event, 'agent:post-tool');
});

test('setHookEnabled rejects an unknown id', (t) => {
  const dir = makeRegistry(t);
  expectThrows(() => setHookEnabled(dir, 'nope', true), 'not-found', /nope/);
});

// ── createHookEntry ───────────────────────────────────────────────

test('createHookEntry writes a user declaration with a 50- prefix', (t) => {
  const dir = makeRegistry(t);

  const result = createHookEntry(dir, {
    id: 'fresh-hook',
    event: 'agent:pre-tool',
    matcher: 'Read',
    run: { script: 'fresh.mjs' },
  });

  assert.equal(path.basename(result.filePath), '50-fresh-hook.json');
  const written = readEntry(dir, '50-fresh-hook.json');
  assert.equal(written.id, 'fresh-hook');
  assert.equal(written.matcher, 'Read');
});

test('createHookEntry never stamps a version, so the entry stays user-owned', (t) => {
  const dir = makeRegistry(t);

  createHookEntry(dir, {
    id: 'fresh-hook',
    event: 'agent:pre-tool',
    run: { script: 'fresh.mjs' },
    // a caller trying to forge a managed entry
    version: '2026.7.29',
  } as any);

  assert.equal(readEntry(dir, '50-fresh-hook.json').version, undefined);
  const records = loadHookRegistryRecords(dir);
  assert.equal(records[0].source, 'user');
});

test('createHookEntry accepts a raw shell command', (t) => {
  const dir = makeRegistry(t);

  createHookEntry(dir, {
    id: 'cmd-hook',
    event: 'cc:PermissionRequest',
    run: { command: "printf '{}'", timeout: 5 },
  });

  assert.deepEqual(readEntry(dir, '50-cmd-hook.json').run, { command: "printf '{}'", timeout: 5 });
});

test('createHookEntry rejects a duplicate id', (t) => {
  const dir = makeRegistry(t);
  writeEntry(dir, '50-my-hook.json', USER_ENTRY);

  expectThrows(
    () => createHookEntry(dir, { id: 'my-hook', event: 'agent:pre-tool', run: { script: 'x.mjs' } }),
    'invalid-args',
    /already/i,
  );
});

test('createHookEntry rejects an id that is not filename safe', (t) => {
  const dir = makeRegistry(t);

  expectThrows(
    () => createHookEntry(dir, { id: '../escape', event: 'agent:pre-tool', run: { script: 'x.mjs' } }),
    'invalid-args',
    /id/i,
  );
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('createHookEntry rejects a declaration the loader would refuse', (t) => {
  const dir = makeRegistry(t);

  expectThrows(
    () => createHookEntry(dir, { id: 'bad', event: 'nonsense:event', run: { script: 'x.mjs' } } as any),
    'invalid-args',
    /event/i,
  );
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('createHookEntry rejects an illegal result mode for the event', (t) => {
  const dir = makeRegistry(t);

  expectThrows(
    () => createHookEntry(dir, {
      id: 'bad-result',
      event: 'cortex:task.completed',
      run: { script: 'x.mjs' },
      result: 'stdout-as-prompt',
    } as any),
    'invalid-args',
    /result/i,
  );
});

// ── updateHookEntry ───────────────────────────────────────────────

test('updateHookEntry replaces the declaration body and keeps the id', (t) => {
  const dir = makeRegistry(t);
  writeEntry(dir, '50-my-hook.json', USER_ENTRY);

  updateHookEntry(dir, 'my-hook', {
    event: 'agent:post-tool',
    matcher: 'Read|Grep',
    run: { script: 'my-hook.mjs', timeout: 20 },
  });

  const written = readEntry(dir, '50-my-hook.json');
  assert.equal(written.id, 'my-hook');
  assert.equal(written.event, 'agent:post-tool');
  assert.equal(written.matcher, 'Read|Grep');
  assert.equal(written.run.timeout, 20);
});

test('updateHookEntry drops fields the caller omitted', (t) => {
  const dir = makeRegistry(t);
  writeEntry(dir, '50-my-hook.json', { ...USER_ENTRY, scope: { requiresTool: 'Edit' } });

  updateHookEntry(dir, 'my-hook', { event: 'agent:pre-tool', run: { script: 'my-hook.mjs' } });

  assert.equal(readEntry(dir, '50-my-hook.json').scope, undefined);
  assert.equal(readEntry(dir, '50-my-hook.json').matcher, undefined);
});

test('updateHookEntry writes back into the original filename', (t) => {
  const dir = makeRegistry(t);
  writeEntry(dir, '07-custom-name.json', USER_ENTRY);

  updateHookEntry(dir, 'my-hook', { event: 'agent:pre-tool', run: { script: 'my-hook.mjs' } });

  assert.deepEqual(fs.readdirSync(dir), ['07-custom-name.json']);
});

test('updateHookEntry refuses a managed entry', (t) => {
  const dir = makeRegistry(t);
  writeEntry(dir, '01-shipped.json', MANAGED_ENTRY);

  expectThrows(
    () => updateHookEntry(dir, 'shipped-hook', { event: 'agent:pre-tool', run: { script: 'x.mjs' } }),
    'invalid-args',
    /managed/i,
  );
  assert.equal(readEntry(dir, '01-shipped.json').event, 'agent:post-tool');
});

test('updateHookEntry cannot promote a user entry to managed', (t) => {
  const dir = makeRegistry(t);
  writeEntry(dir, '50-my-hook.json', USER_ENTRY);

  updateHookEntry(dir, 'my-hook', {
    event: 'agent:pre-tool',
    run: { script: 'my-hook.mjs' },
    version: '2026.7.29',
  } as any);

  assert.equal(readEntry(dir, '50-my-hook.json').version, undefined);
});

// ── removeHookEntry ───────────────────────────────────────────────

test('removeHookEntry deletes a user declaration file', (t) => {
  const dir = makeRegistry(t);
  writeEntry(dir, '50-my-hook.json', USER_ENTRY);

  assert.equal(removeHookEntry(dir, 'my-hook').removed, true);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('removeHookEntry refuses a managed entry', (t) => {
  const dir = makeRegistry(t);
  writeEntry(dir, '01-shipped.json', MANAGED_ENTRY);

  expectThrows(() => removeHookEntry(dir, 'shipped-hook'), 'invalid-args', /managed/i);
  assert.equal(fs.existsSync(path.join(dir, '01-shipped.json')), true);
});

test('removeHookEntry rejects an unknown id', (t) => {
  const dir = makeRegistry(t);
  expectThrows(() => removeHookEntry(dir, 'ghost'), 'not-found', /ghost/);
});
