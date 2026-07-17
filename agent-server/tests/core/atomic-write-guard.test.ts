// input:  atomicWrite + NODE_TEST_CONTEXT env
// output: unit tests — test-process write-to-production tripwire
// pos:    regression for "running tests directly polluted the real ~/.cortex/threads.json".
//         atomicWrite must refuse to write under the real ~/.cortex when NODE_TEST_CONTEXT is set,
//         turning silent production corruption into a loud, immediate failure.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, rmSync, mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicWrite } from '../../src/core/atomic-write.js';

const REAL_HOME_CORTEX = path.join(os.homedir(), '.cortex');

test('blocks a test-process write under the real ~/.cortex (and writes nothing)', async () => {
  // NODE_TEST_CONTEXT is set by the node test runner — assert our premise.
  assert.ok(process.env.NODE_TEST_CONTEXT, 'precondition: running under node test runner');
  const target = path.join(REAL_HOME_CORTEX, 'data', '__guard_probe_should_never_exist.json');
  assert.equal(existsSync(target), false, 'precondition: probe file absent');

  await assert.rejects(
    () => atomicWrite(target, '{"polluted":true}'),
    /~\/\.cortex|production|_test-home|CORTEX_HOME/i,
    'must throw a guidance error mentioning the remedy',
  );
  // Critical: the guard fires BEFORE any write, so the real store is untouched.
  assert.equal(existsSync(target), false, 'no file was created under the real home');
});

test('allows writes outside the real ~/.cortex (explicit temp path)', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'atomic-guard-'));
  const target = path.join(dir, 'ok.json');
  try {
    await atomicWrite(target, '{"ok":true}');
    assert.equal(existsSync(target), true, 'temp write succeeds — guard does not over-fire');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
