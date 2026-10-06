import { test } from 'vitest';
import assert from 'node:assert/strict';
import { importFresh } from './module-loader.js';

function makePersistenceStub(initial: any = []) {
  let savedState: any = initial;
  return {
    save(state: any) { savedState = state; return Promise.resolve(); },
    load() { return Promise.resolve(savedState); },
    getSaved() { return savedState; },
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
  const all = mod.takeReadyResumes([]);
  assert.equal(all.length, 1);
  assert.equal((all[0] as any).userMessage, 'second');
});

test('init drops a leftover thread entry and keeps the direct resumes', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub([
    { kind: 'direct', channel: 'untracked', userMessage: 'untracked', recordedAt: 1 },
    { kind: 'direct', channel: 'tracked', trackSessionId: 'track-1', userMessage: 'tracked', recordedAt: 2 },
    { kind: 'thread', threadId: 'thr-a', channel: 'thread', userMessage: 'thread', recordedAt: 3 },
  ]);
  await mod.initResumeRegistry(persistence as any);

  assert.deepEqual(mod.pendingDirectTrackSessionIds(), ['track-1']);
  assert.deepEqual(persistence.getSaved().map((e: any) => e.channel), ['untracked', 'tracked']);
  assert.equal(mod.getResumeCount(), 2);
});

test('takeReadyResumes([]) drains the registry (second call is empty)', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  await mod.initResumeRegistry(makePersistenceStub() as any);

  mod.recordResume({ kind: 'direct', channel: 'C1', userMessage: 'd', recordedAt: 1 });
  assert.equal(mod.takeReadyResumes([]).length, 1);
  assert.equal(mod.takeReadyResumes([]).length, 0);
  assert.equal(mod.getResumeCount(), 0);
});

test('recordResume persists the full entry list', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  await mod.initResumeRegistry(persistence as any);

  mod.recordResume({ kind: 'direct', channel: 'C1', userMessage: 'd', recordedAt: 1 });
  mod.recordResume({ kind: 'direct', channel: 'C2', userMessage: 'd2', recordedAt: 2 });

  const saved = persistence.getSaved();
  assert.equal(saved.length, 2);
});

test('takeReadyResumes([]) persists the cleared (empty) list', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  await mod.initResumeRegistry(persistence as any);

  mod.recordResume({ kind: 'direct', channel: 'C1', userMessage: 'd', recordedAt: 1 });
  mod.takeReadyResumes([]);
  assert.deepEqual(persistence.getSaved(), []);
});

test('initResumeRegistry hydrates from persisted entries', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub([
    { kind: 'direct', channel: 'C1', userMessage: 'd', recordedAt: 1 },
    { kind: 'direct', channel: 'C2', userMessage: 'd2', recordedAt: 2 },
  ]);
  await mod.initResumeRegistry(persistence as any);

  assert.equal(mod.getResumeCount(), 2);
  const channels = mod.takeReadyResumes([]).map((e: any) => e.channel).sort();
  assert.deepEqual(channels, ['C1', 'C2']);
});

test('takeReadyResumes drains only providers that are no longer active', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  await mod.initResumeRegistry(persistence as any);

  mod.recordResume({ kind: 'direct', provider: 'provider-a', channel: 'C1', userMessage: 'a', recordedAt: 1 });
  mod.recordResume({ kind: 'direct', provider: 'provider-b', channel: 'C2', userMessage: 'b', recordedAt: 2 });
  mod.recordResume({ kind: 'direct', provider: null, channel: 'legacy', userMessage: 'legacy', recordedAt: 3 });

  const first = mod.takeReadyResumes(['provider-b']);
  assert.deepEqual(first.map((entry: any) => entry.provider), ['provider-a']);
  assert.equal(mod.getResumeCount(), 2);
  assert.deepEqual(mod.getResumeCountsByProvider(), {
    'provider-b': { sessions: 1 },
  });

  const final = mod.takeReadyResumes([]);
  assert.deepEqual(final.map((entry: any) => entry.provider), ['provider-b', null]);
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

test('removeDirectResume cancels one channel and leaves other entries queued', async (t) => {
  const mod = await freshModuleWithCleanup(t);
  const persistence = makePersistenceStub();
  let changes = 0;
  await mod.initResumeRegistry(persistence as any, () => { changes += 1; });

  mod.recordResume({ kind: 'direct', channel: 'C1', userMessage: 'cancel me', recordedAt: 1 });
  mod.recordResume({ kind: 'direct', channel: 'C2', userMessage: 'keep me', recordedAt: 2 });
  mod.recordResume({ kind: 'direct', channel: 'C3', userMessage: 't', recordedAt: 3 });
  const changesBefore = changes;

  assert.equal(mod.removeDirectResume('C1'), true);
  assert.equal(mod.getResumeCount(), 2, 'only the cancelled channel is dropped');
  assert.ok(changes > changesBefore, 'cancellation publishes a waiting-count change');
  assert.deepEqual(
    (persistence.getSaved() as any[]).map((e) => e.channel).sort(),
    ['C2', 'C3'],
    'only the C1 entry is gone',
  );

  assert.equal(mod.removeDirectResume('C1'), false, 'cancelling twice is a no-op');
  assert.deepEqual(
    mod.takeReadyResumes([]).map((e: any) => e.userMessage).sort(),
    ['keep me', 't'],
  );
});
