// input:  SessionEngines over a PIAdapter backed by the fake PI runtime
// output: pool ownership regression: reuse, retirement, eviction, detached control references
// pos:    P2.2c — the pool moved out of PIAdapter, so its guarantees are asserted here
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { SessionEngines } from '../../src/domain/runs/engines.js';
import { PIAdapter } from '../../src/agent-adapter/pi/adapter.js';
import { engineSpecFixture } from '../engine-spec-fixture.js';
import { makeFakeRuntimeFactory } from '../agent-adapter/pi-fake-runtime.js';

function fixture(): { engines: SessionEngines; adapter: PIAdapter } {
  const root = mkdtempSync(path.join(tmpdir(), 'cortex-engines-'));
  const adapter = new PIAdapter(makeFakeRuntimeFactory().factory, root);
  return { engines: new SessionEngines({ pi: adapter }), adapter };
}

/** The pool dispatches on the spec's backend; this fixture wires only PI, so pin the discriminant. */
function piSpec(partial: Parameters<typeof engineSpecFixture>[0] = {}) {
  return engineSpecFixture({ ...partial, piProvider: 'anthropic' });
}

test('acquire reuses the pooled session for an unchanged spec', () => {
  const { engines } = fixture();
  const spec = piSpec({ sessionId: null, sessionKey: 'reuse', resume: false });
  const first = engines.acquire(spec);
  assert.equal(engines.acquire(spec), first, 'same spec reuses the same engine session');
  assert.deepEqual(engines.listKeys(), ['reuse']);
});

test('acquire retires the pooled session when the spec changes', () => {
  const { engines } = fixture();
  const first = engines.acquire(piSpec({ sessionId: null, sessionKey: 'k', resume: false }));
  const second = engines.acquire(piSpec({
    sessionId: null, sessionKey: 'k', resume: false, model: 'other-model',
  }));
  assert.notEqual(second, first, 'a changed spec opens a new session');
  assert.equal(engines.get('k'), second, 'the pool points at the replacement');
});

test('close drops the pool entry synchronously so the next acquire opens fresh', async () => {
  const { engines } = fixture();
  const spec = piSpec({ sessionId: null, sessionKey: 'closed', resume: false });
  const first = engines.acquire(spec);
  const closing = engines.close('closed');
  assert.equal(engines.get('closed'), undefined, 'entry is gone before the close settles');
  assert.notEqual(engines.acquire(spec), first);
  await closing;
});

test('close on an unknown key resolves instead of throwing', async () => {
  const { engines } = fixture();
  await assert.doesNotReject(engines.close('nobody'));
  assert.equal(engines.kill('nobody'), false);
});

// Regression: rewind and edit-retry pass this method around as a bare function value
// (`registerPISessionPath: engines.registerSessionPath`). An unbound class method would lose
// `this` and throw on the first restored transcript.
test('registerSessionPath survives being detached from the instance', () => {
  const { engines, adapter } = fixture();
  const register = engines.registerSessionPath;
  const target = path.join(adapter.sessionDir, 'detached.jsonl');
  assert.doesNotThrow(() => register('detached', target));
});
