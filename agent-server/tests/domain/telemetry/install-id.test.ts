import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'vitest';
import { adoptInstallId, getInstallId, isInstallId } from '@domain/telemetry/install-id.js';

function tempFile(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'telemetry-id-')), 'telemetry', 'install-id');
}

test('the install id is created once and then stable', () => {
  const file = tempFile();
  const id = getInstallId(file);
  assert.ok(isInstallId(id));
  assert.equal(getInstallId(file), id);
  assert.equal(readFileSync(file, 'utf8').trim(), id);
});

test('a corrupt id file is replaced by a fresh UUID', () => {
  const file = tempFile();
  getInstallId(file);
  writeFileSync(file, 'not-a-uuid');
  const replaced = getInstallId(file);
  assert.ok(isInstallId(replaced));
});

test('an adopted id is used from then on and must be a UUID', () => {
  const file = tempFile();
  const adopted = '0b7c5c1e-3f7a-4d6e-9a59-2f1f3a7b9c11';
  adoptInstallId(adopted.toUpperCase(), file);
  assert.equal(getInstallId(file), adopted);
  assert.throws(() => adoptInstallId('abc', file));
});
