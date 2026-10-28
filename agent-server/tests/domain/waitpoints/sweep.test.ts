import { test, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WaitpointRepo } from '../../../src/store/waitpoint-repo.js';
import { applySignal, createWaitpoint, type WaitpointServiceDeps } from '../../../src/domain/waitpoints/service.js';
import { resetSignalIngressState, type IngestDeps } from '../../../src/orchestration/waitpoint-ingress.js';
import { resetWaitpointTimers, type WaitpointNotifierDeps } from '../../../src/orchestration/waitpoint-notifier.js';
import { recoverWaitpoints, sweepWaitpoints, type WaitpointSweepDeps } from '../../../src/orchestration/waitpoint-sweep.js';

let tmpDir: string;
const BASE = 1_700_000_000_000;

beforeAll(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-wp-sweep-')); });
afterAll(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });
beforeEach(() => { resetSignalIngressState(); resetWaitpointTimers(); });

interface Harness {
  repo: WaitpointRepo;
  service: WaitpointServiceDeps;
  sweep: WaitpointSweepDeps;
  sent: string[];
  spoolDir: string;
  setNow: (t: number) => void;
}

async function harness(opts: { maxWakesPerHour?: number } = {}): Promise<Harness> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const repo = new WaitpointRepo({ filePath: path.join(tmpDir, `wp-${stamp}.json`) });
  const spoolDir = path.join(tmpDir, `spool-${stamp}`);
  await fs.mkdir(spoolDir, { recursive: true });
  const sent: string[] = [];
  let clock = BASE;
  let seq = 0;
  const now = () => clock;
  const service: WaitpointServiceDeps = {
    repo, now,
    maxWakesPerHour: () => opts.maxWakesPerHour ?? 12,
    defaultTtlMs: () => 7 * 24 * 60 * 60 * 1000,
    newId: () => `wp_${String(++seq).padStart(12, '0')}`,
    newSecret: () => `secret-${seq}`,
  };
  const notifier: WaitpointNotifierDeps = { repo, now, deliver: async (_c, text) => { sent.push(text); } };
  const ingest: IngestDeps = { service, notifier, now };
  return {
    repo, service, sent, spoolDir,
    setNow: (t) => { clock = t; },
    sweep: { service, notifier, ingest, spoolDir, remote: null },
  };
}

function owner() { return { sessionId: 'sess-1', channel: 'web:chan-1' }; }

test('a sweep delivers a wake left pending by a crash before it could be sent', async () => {
  const h = await harness();
  const { waitpoint, secret } = await createWaitpoint({ label: 'arm2', intent: 'training', owner: owner() }, h.service);
  await applySignal({ id: waitpoint.id, secret, message: 'done', source: 'http' }, h.service);
  // The coalesce timer / immediate delivery never ran — this is exactly the post-restart state.
  assert.equal((await h.repo.get(waitpoint.id))!.delivery.pending, true);

  const result = await sweepWaitpoints(h.sweep);
  assert.equal(result.delivered, 1);
  assert.equal(h.sent.length, 1);
  assert.equal((await h.repo.get(waitpoint.id))!.delivery.pending, false);
});

test('a second sweep is a no-op once everything has been delivered', async () => {
  const h = await harness();
  const { waitpoint, secret } = await createWaitpoint({ label: 'arm2', intent: 'training', owner: owner() }, h.service);
  await applySignal({ id: waitpoint.id, secret, source: 'http' }, h.service);

  await sweepWaitpoints(h.sweep);
  const second = await sweepWaitpoints(h.sweep);
  assert.deepEqual(second, { spooled: 0, fromDevices: 0, released: 0, expired: 0, delivered: 0, purged: 0 });
  assert.equal(h.sent.length, 1);
});

test('the sweep expires a past-due waitpoint and tells its owner nobody reported', async () => {
  const h = await harness();
  const { waitpoint } = await createWaitpoint(
    { label: 'arm2', intent: 'the run to finish', owner: owner(), ttlMs: 1000 },
    h.service,
  );
  h.setNow(BASE + 5000);

  const result = await sweepWaitpoints(h.sweep);
  assert.equal(result.expired, 1);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /expired after/);
  assert.match(h.sent[0], /No signal ever arrived/);
  assert.equal((await h.repo.get(waitpoint.id))!.state, 'expired');

  // The expiry notice is sent exactly once, however many sweeps follow.
  await sweepWaitpoints(h.sweep);
  assert.equal(h.sent.length, 1);
});

test('a signal landing just before the deadline beats the expiry notice', async () => {
  const h = await harness();
  const { waitpoint, secret } = await createWaitpoint(
    { label: 'arm2', intent: 'training', owner: owner(), ttlMs: 10_000 },
    h.service,
  );
  await applySignal({ id: waitpoint.id, secret, status: 'ok', source: 'http' }, h.service);
  h.setNow(BASE + 20_000);

  const result = await sweepWaitpoints(h.sweep);
  assert.equal(result.expired, 0, 'a fired waitpoint is no longer armed and cannot expire');
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /status=ok/);
  assert.equal(/expired/.test(h.sent[0]), false);
});

test('a wake held by the hourly cap is delivered by a later sweep with no further signal', async () => {
  const h = await harness({ maxWakesPerHour: 1 });
  const { waitpoint, secret } = await createWaitpoint(
    { label: 'monitor', intent: 'each report', owner: owner(), maxSignals: 5 },
    h.service,
  );
  await applySignal({ id: waitpoint.id, secret, message: 'first', source: 'http' }, h.service);
  await sweepWaitpoints(h.sweep);
  await applySignal({ id: waitpoint.id, secret, message: 'second', source: 'http' }, h.service);
  await applySignal({ id: waitpoint.id, secret, message: 'third', source: 'http' }, h.service);

  assert.equal((await sweepWaitpoints(h.sweep)).released, 0, 'still inside the hour');
  assert.equal(h.sent.length, 1);

  h.setNow(BASE + 61 * 60 * 1000);
  const result = await sweepWaitpoints(h.sweep);
  assert.equal(result.released, 1);
  assert.equal(result.delivered, 1);
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1], /second/);
  assert.match(h.sent[1], /third/);
  assert.match(h.sent[1], /held back by the hourly wake cap/);
  assert.equal(/first/.test(h.sent[1]), false);
});

test('expiry carries a mailbox fire that was still waiting for delivery', async () => {
  const h = await harness();
  let up = false;
  h.sweep.notifier = {
    repo: h.repo,
    now: () => BASE + 20_000,
    deliver: async (_c, text) => { if (!up) throw new Error('adapter down'); h.sent.push(text); },
  };
  const { waitpoint, secret } = await createWaitpoint(
    { label: 'monitor', intent: 'each epoch', owner: owner(), maxSignals: 5, ttlMs: 10_000 },
    h.service,
  );
  await applySignal({ id: waitpoint.id, secret, status: 'progress', message: 'step 100', source: 'http' }, h.service);
  await applySignal({ id: waitpoint.id, secret, message: 'epoch 7 done', data: 'loss 0.3', source: 'http' }, h.service);
  await sweepWaitpoints(h.sweep);
  assert.equal((await h.repo.get(waitpoint.id))!.delivery.pending, true);

  up = true;
  h.setNow(BASE + 20_000);
  await sweepWaitpoints(h.sweep);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /expired after/);
  assert.match(h.sent[0], /woke you 1 time\(s\) \(of 5 allowed\)/);
  assert.match(h.sent[0], /epoch 7 done/, 'the pending fire must not be lost to the expiry notice');
  assert.match(h.sent[0], /loss 0\.3/);
  assert.equal(/never finished or never reported/.test(h.sent[0]), false);
});

test('a delivery failure is retried by the next sweep rather than lost', async () => {
  const h = await harness();
  let fail = true;
  h.sweep.notifier = {
    repo: h.repo,
    now: () => BASE,
    deliver: async (_c, text) => {
      if (fail) { fail = false; throw new Error('adapter down'); }
      h.sent.push(text);
    },
  };
  const { waitpoint, secret } = await createWaitpoint({ label: 'arm2', intent: 'training', owner: owner() }, h.service);
  await applySignal({ id: waitpoint.id, secret, source: 'http' }, h.service);

  assert.equal((await sweepWaitpoints(h.sweep)).delivered, 0);
  assert.equal((await h.repo.get(waitpoint.id))!.delivery.pending, true);
  assert.equal((await sweepWaitpoints(h.sweep)).delivered, 1);
  assert.equal(h.sent.length, 1);
});

test('settled waitpoints are purged once past the retention window', async () => {
  const h = await harness();
  const { waitpoint, secret } = await createWaitpoint({ label: 'arm2', intent: 'training', owner: owner() }, h.service);
  await applySignal({ id: waitpoint.id, secret, source: 'http' }, h.service);
  await sweepWaitpoints(h.sweep);

  h.setNow(BASE + 4 * 24 * 60 * 60 * 1000);
  const result = await sweepWaitpoints(h.sweep);
  assert.equal(result.purged, 1);
  assert.equal(await h.repo.get(waitpoint.id), null);
});

test('the sweep picks up a spool file written while nothing was listening', async () => {
  const h = await harness();
  const { waitpoint, secret } = await createWaitpoint({ label: 'arm2', intent: 'training', owner: owner() }, h.service);
  const tmp = path.join(h.spoolDir, 'from-the-box.json.tmp');
  await fs.writeFile(tmp, JSON.stringify({ id: waitpoint.id, secret, status: 'ok', message: 'exit=0' }));
  await fs.rename(tmp, path.join(h.spoolDir, 'from-the-box.json'));

  const result = await sweepWaitpoints(h.sweep);
  await vi.waitFor(() => assert.ok(h.sent.length > 0, 'the wake is delivered'));

  assert.equal(result.spooled, 1);
  // The wake is sent by the ingest path as the file is applied, so the sweep's pending pass finds
  // nothing left to flush. What matters is that it went out exactly once, not which pass sent it.
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /exit=0/);
  assert.deepEqual((await fs.readdir(h.spoolDir)).filter((f) => f.endsWith('.json')), []);

  await sweepWaitpoints(h.sweep);
  assert.equal(h.sent.length, 1, 'a later sweep must not re-send an already-delivered wake');
});

for (const state of ['fired', 'expired'] as const) {
  test(`boot recovers a claimed ${state} notice before retention can purge it`, async () => {
    const h = await harness();
    const { waitpoint } = await createWaitpoint({ label: 'job', intent: 'finish', owner: owner() }, h.service);
    await h.repo.update(waitpoint.id, wp => {
      wp.state = state;
      wp.resolvedAt = BASE;
      wp.delivery = { pending: false, inFlight: true, attempts: 1 };
      return { next: wp, result: undefined };
    });
    h.setNow(BASE + 4 * 24 * 60 * 60 * 1000);
    const result = await recoverWaitpoints(h.sweep);
    assert.equal(result.delivered, 1);
    assert.equal(result.purged, 0);
    assert.equal(h.sent.length, 1);
    const recovered = (await h.repo.get(waitpoint.id))!;
    assert.equal(recovered.delivery.inFlight, false);
    assert.equal(recovered.delivery.pending, false);
    await recoverWaitpoints(h.sweep);
    assert.equal(h.sent.length, 1);
  });
}
