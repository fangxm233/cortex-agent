// input:  Node test runner + resume-registry module
// output: provider readiness, counts, dedupe, persistence tests
// pos:    Validate the rate-limit resume registry (interrupted session/thread bookkeeping)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { importFresh } from './module-loader.js';

function makePersistenceStub(initial: any = []) {
  let savedState: any = initial;
  return {
    save(state: any) { savedState = state; return Promise.resolve(); },
    load() { return Promise.resolve(savedState); },
    getSaved() { return savedState; },
    setSaved(state: any) { savedState = state; },
  };
}

async function freshModule() {
  return await importFresh('./../src/domain/costs/resume-registry.js') as typeof import('../src/domain/costs/resume-registry.js');
}

async function freshModuleWithCleanup(t: { onTestFinished: (fn: () => unknown) => void }) {
  const mod = await freshModule();
  t.onTestFinished(() => mod._testReset());
  return mod;
}

test('recordResume dedupes direct entries by channel (latest wins)', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  await mod.initResumeRegistry(makePersistenceStub() as any);

  mod.recordResume({ kind: 'direct', channel: 'C1', userMessage: 'first', recordedAt: 1 });
  mod.recordResume({ kind: 'direct', channel: 'C1', userMessage: 'second', recordedAt: 2 });

  assert.equal(mod.getResumeCount(), 1);
  const all = mod.takeAllResumes();
  assert.equal(all.length, 1);
  assert.equal((all[0] as any).userMessage, 'second');
});

test('recordResume keeps multiple thread entries by threadId', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  await mod.initResumeRegistry(makePersistenceStub() as any);

  mod.recordResume({ kind: 'thread', threadId: 'thr_a', channel: 'C1', userMessage: 'a', recordedAt: 1 });
  mod.recordResume({ kind: 'thread', threadId: 'thr_b', channel: 'C1', userMessage: 'b', recordedAt: 2 });
  mod.recordResume({ kind: 'thread', threadId: 'thr_a', channel: 'C1', userMessage: 'a2', recordedAt: 3 });

  assert.equal(mod.getResumeCount(), 2);
  const ids = mod.takeAllResumes().map((e: any) => e.threadId).sort();
  assert.deepEqual(ids, ['thr_a', 'thr_b']);
});

test('direct and thread on same channel coexist', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  await mod.initResumeRegistry(makePersistenceStub() as any);

  mod.recordResume({ kind: 'direct', channel: 'C1', userMessage: 'd', recordedAt: 1 });
  mod.recordResume({ kind: 'thread', threadId: 'thr_a', channel: 'C1', userMessage: 't', recordedAt: 2 });

  assert.equal(mod.getResumeCount(), 2);
  const kinds = mod.takeAllResumes().map((e: any) => e.kind).sort();
  assert.deepEqual(kinds, ['direct', 'thread']);
});

test('takeAllResumes drains the registry (second call is empty)', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  await mod.initResumeRegistry(makePersistenceStub() as any);

  mod.recordResume({ kind: 'direct', channel: 'C1', userMessage: 'd', recordedAt: 1 });
  assert.equal(mod.takeAllResumes().length, 1);
  assert.equal(mod.takeAllResumes().length, 0);
  assert.equal(mod.getResumeCount(), 0);
});

test('recordResume persists the full entry list', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  await mod.initResumeRegistry(persistence as any);

  mod.recordResume({ kind: 'direct', channel: 'C1', userMessage: 'd', recordedAt: 1 });
  mod.recordResume({ kind: 'thread', threadId: 'thr_a', channel: 'C2', userMessage: 't', recordedAt: 2 });

  const saved = persistence.getSaved();
  assert.equal(saved.length, 2);
});

test('takeAllResumes persists the cleared (empty) list', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  await mod.initResumeRegistry(persistence as any);

  mod.recordResume({ kind: 'direct', channel: 'C1', userMessage: 'd', recordedAt: 1 });
  mod.takeAllResumes();
  assert.deepEqual(persistence.getSaved(), []);
});

test('initResumeRegistry hydrates from persisted entries', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub([
    { kind: 'direct', channel: 'C1', userMessage: 'd', recordedAt: 1 },
    { kind: 'thread', threadId: 'thr_a', channel: 'C2', userMessage: 't', recordedAt: 2 },
  ]);
  await mod.initResumeRegistry(persistence as any);

  assert.equal(mod.getResumeCount(), 2);
  const kinds = mod.takeAllResumes().map((e: any) => e.kind).sort();
  assert.deepEqual(kinds, ['direct', 'thread']);
});

test('takeReadyResumes drains only providers that are no longer active', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  await mod.initResumeRegistry(persistence as any);

  mod.recordResume({ kind: 'direct', provider: 'provider-a', channel: 'C1', userMessage: 'a', recordedAt: 1 });
  mod.recordResume({ kind: 'thread', provider: 'provider-b', threadId: 'thr_b', channel: 'C2', userMessage: 'b', recordedAt: 2 });
  mod.recordResume({ kind: 'direct', provider: null, channel: 'legacy', userMessage: 'legacy', recordedAt: 3 });

  const first = mod.takeReadyResumes(['provider-b']);
  assert.deepEqual(first.map((entry: any) => entry.provider), ['provider-a']);
  assert.equal(mod.getResumeCount(), 2);
  assert.deepEqual(mod.getResumeCountsByProvider(), {
    'provider-b': { sessions: 0, threads: 1 },
  });

  const final = mod.takeReadyResumes([]);
  assert.deepEqual(final.map((entry: any) => entry.provider), [null, 'provider-b']);
  assert.equal(mod.getResumeCount(), 0);
});

test('resume registry publishes changes when entries are queued and drained', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  let changes = 0;
  await mod.initResumeRegistry(makePersistenceStub() as any, () => { changes++; });

  mod.recordResume({ kind: 'direct', provider: 'provider-a', channel: 'C1', userMessage: 'a', recordedAt: 1 });
  mod.takeReadyResumes([]);

  assert.equal(changes, 2);
});

test('recordResume works in-memory before init (no persistence)', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  mod.recordResume({ kind: 'direct', channel: 'C1', userMessage: 'd', recordedAt: 1 });
  assert.equal(mod.getResumeCount(), 1);
});

test('removeDirectResume cancels one channel and leaves other entries queued', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  let changes = 0;
  await mod.initResumeRegistry(persistence as any, () => { changes += 1; });

  mod.recordResume({ kind: 'direct', channel: 'C1', userMessage: 'cancel me', recordedAt: 1 });
  mod.recordResume({ kind: 'direct', channel: 'C2', userMessage: 'keep me', recordedAt: 2 });
  mod.recordResume({ kind: 'thread', threadId: 'thr_a', channel: 'C1', userMessage: 't', recordedAt: 3 });
  const changesBefore = changes;

  assert.equal(mod.removeDirectResume('C1'), true);
  assert.equal(mod.getResumeCount(), 2, 'only the cancelled channel is dropped');
  assert.ok(changes > changesBefore, 'cancellation publishes a waiting-count change');
  assert.deepEqual(
    (persistence.getSaved() as any[]).map((e) => e.channel).sort(),
    ['C1', 'C2'],
    'the surviving thread entry keeps its channel; only the direct C1 entry is gone',
  );

  assert.equal(mod.removeDirectResume('C1'), false, 'cancelling twice is a no-op');
  assert.deepEqual(
    mod.takeAllResumes().map((e: any) => e.userMessage).sort(),
    ['keep me', 't'],
  );
});
