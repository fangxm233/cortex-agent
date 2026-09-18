import './../../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WaitpointRepo } from '../../../src/store/waitpoint-repo.js';
import { applySignal, createWaitpoint, type WaitpointServiceDeps } from '../../../src/domain/waitpoints/service.js';
import {
  drainLocalSpool,
  ingestSignal,
  recentSignalRejections,
  resetSignalIngressState,
  toSignalInput,
  type IngestDeps,
} from '../../../src/orchestration/waitpoint-ingress.js';
import { resetWaitpointTimers } from '../../../src/orchestration/waitpoint-notifier.js';

let tmpDir: string;
const BASE = 1_700_000_000_000;

beforeAll(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-wp-ingress-')); });
afterAll(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });
beforeEach(() => { resetSignalIngressState(); resetWaitpointTimers(); });

interface Harness {
  repo: WaitpointRepo;
  service: WaitpointServiceDeps;
  deps: IngestDeps;
  sent: string[];
  spoolDir: string;
}

async function harness(): Promise<Harness> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const repo = new WaitpointRepo({ filePath: path.join(tmpDir, `wp-${stamp}.json`) });
  const spoolDir = path.join(tmpDir, `spool-${stamp}`);
  await fs.mkdir(spoolDir, { recursive: true });
  const sent: string[] = [];
  let seq = 0;
  const service: WaitpointServiceDeps = {
    repo,
    now: () => BASE,
    maxWakesPerHour: () => 12,
    defaultTtlMs: () => 7 * 24 * 60 * 60 * 1000,
    newId: () => `wp_${String(++seq).padStart(12, '0')}`,
    newSecret: () => `secret-${seq}`,
  };
  return {
    repo,
    service,
    sent,
    spoolDir,
    deps: {
      service,
      now: () => BASE,
      notifier: { repo, now: () => BASE, deliver: async (_c, text) => { sent.push(text); } },
    },
  };
}

function owner() { return { sessionId: 'sess-1', channel: 'web:chan-1' }; }

async function writeSpool(dir: string, name: string, payload: unknown): Promise<void> {
  const tmp = path.join(dir, `${name}.tmp`);
  await fs.writeFile(tmp, typeof payload === 'string' ? payload : JSON.stringify(payload));
  await fs.rename(tmp, path.join(dir, name));
}

// ── ingest ─────────────────────────────────────────────────────

test('an accepted signal that fires is handed straight to the notifier', async () => {
  const h = await harness();
  const { waitpoint, secret } = await createWaitpoint({ label: 'arm2', intent: 'training', owner: owner() }, h.service);

  const outcome = await ingestSignal({ id: waitpoint.id, secret, message: 'done', source: 'http' }, h.deps);
  assert.equal(outcome.kind, 'accepted');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /\[Signal\]/);
});

test('unknown ids and bad secrets are recorded in the dead-letter ring', async () => {
  const h = await harness();
  const { waitpoint } = await createWaitpoint({ label: 'arm2', intent: 'training', owner: owner() }, h.service);

  assert.equal((await ingestSignal({ id: 'wp_typo', secret: 'x', source: 'http' }, h.deps)).kind, 'not-found');
  assert.equal((await ingestSignal({ id: waitpoint.id, secret: 'wrong', source: 'http' }, h.deps)).kind, 'bad-secret');
  assert.equal((await ingestSignal({ id: '', secret: 'x', source: 'http' }, h.deps)).kind, 'not-found');

  const rejects = recentSignalRejections();
  assert.equal(rejects.length, 3);
  assert.deepEqual(rejects.map((r) => r.reason), ['not-found', 'bad-secret', 'not-found']);
  assert.equal(rejects[0].id, 'wp_typo');
});

test('a flood of misses is refused before it can be used to enumerate live waitpoints', async () => {
  const h = await harness();
  let lastKind = '';
  for (let i = 0; i < 70; i += 1) {
    lastKind = (await ingestSignal({ id: `wp_scan${i}`, secret: 'x', source: 'http' }, h.deps)).kind;
  }
  assert.equal(lastKind, 'rate-limited');
  assert.equal(recentSignalRejections().some((r) => r.reason === 'rate-limited'), true);

  // A legitimate signal still lands while the miss budget is exhausted.
  const { waitpoint, secret } = await createWaitpoint({ label: 'arm2', intent: 'training', owner: owner() }, h.service);
  assert.equal((await ingestSignal({ id: waitpoint.id, secret, source: 'http' }, h.deps)).kind, 'accepted');
});

test('toSignalInput drops fields it does not recognise and defaults the status', () => {
  const input = toSignalInput(
    { id: 'wp_1', secret: 's', status: 'bogus', message: 42, member: 'arm2', data: { a: 1 }, extra: 'ignored' },
    'spool:x.json',
    'spool',
  );
  assert.equal(input.status, undefined);
  assert.equal(input.message, null, 'a non-string message must not reach the notice');
  assert.equal(input.member, 'arm2');
  assert.deepEqual(input.data, { a: 1 });
  assert.equal(input.dedupeKey, 'spool:x.json');
});

// ── spool ──────────────────────────────────────────────────────

test('a spool file is applied, wakes the session, and is then removed', async () => {
  const h = await harness();
  const { waitpoint, secret } = await createWaitpoint({ label: 'arm2', intent: 'training', owner: owner() }, h.service);
  await writeSpool(h.spoolDir, 'a.json', { id: waitpoint.id, secret, status: 'ok', message: 'from the box' });

  assert.equal(await drainLocalSpool(h.deps, h.spoolDir), 1);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /from the box/);
  assert.deepEqual((await fs.readdir(h.spoolDir)).filter((f) => f.endsWith('.json')), []);
});

test('re-reading a spool file whose delete was lost does not wake twice', async () => {
  const h = await harness();
  const { waitpoint, secret } = await createWaitpoint(
    { label: 'ladder', intent: 'arms', owner: owner(), quorum: { need: 2 } },
    h.service,
  );
  await writeSpool(h.spoolDir, 'a.json', { id: waitpoint.id, secret, member: 'arm2' });
  await drainLocalSpool(h.deps, h.spoolDir);

  // The delete was "lost": put the same file back and drain again.
  await writeSpool(h.spoolDir, 'a.json', { id: waitpoint.id, secret, member: 'arm2' });
  await drainLocalSpool(h.deps, h.spoolDir);

  const stored = (await h.repo.get(waitpoint.id))!;
  assert.equal(stored.signals.length, 1, 'the filename is the dedupe key; a replay must be dropped');
  assert.equal(stored.state, 'armed');
});

test('an unusable spool entry is parked under bad/ and never blocks the rest of the batch', async () => {
  const h = await harness();
  const { waitpoint, secret } = await createWaitpoint({ label: 'arm2', intent: 'training', owner: owner() }, h.service);

  await writeSpool(h.spoolDir, 'broken.json', '{not json');
  await writeSpool(h.spoolDir, 'stranger.json', { id: 'wp_gone', secret: 'x' });
  await writeSpool(h.spoolDir, 'huge.json', { id: waitpoint.id, secret, message: 'x'.repeat(70 * 1024) });
  await writeSpool(h.spoolDir, 'good.json', { id: waitpoint.id, secret, status: 'ok' });

  assert.equal(await drainLocalSpool(h.deps, h.spoolDir), 1);
  assert.deepEqual((await fs.readdir(h.spoolDir)).filter((f) => f.endsWith('.json')), []);
  const parked = await fs.readdir(path.join(h.spoolDir, 'bad'));
  assert.equal(parked.length, 3, `broken, stranger and huge must be parked, got ${parked.join(', ')}`);
  assert.equal(parked.some((f) => f.endsWith('good.json')), false);
});

test('a spool file for an already-resolved waitpoint is cleared, not parked', async () => {
  const h = await harness();
  const { waitpoint, secret } = await createWaitpoint({ label: 'arm2', intent: 'training', owner: owner() }, h.service);
  await applySignal({ id: waitpoint.id, secret, source: 'http' }, h.service);

  await writeSpool(h.spoolDir, 'late.json', { id: waitpoint.id, secret, status: 'ok' });
  assert.equal(await drainLocalSpool(h.deps, h.spoolDir), 0);
  assert.deepEqual(await fs.readdir(h.spoolDir).then((f) => f.filter((n) => n.endsWith('.json'))), []);
  const badDir = path.join(h.spoolDir, 'bad');
  const parked = await fs.readdir(badDir).catch(() => []);
  assert.equal(parked.length, 0, 'a late-but-authentic signal is not a bad file');
});

test('draining an absent spool directory is a no-op', async () => {
  const h = await harness();
  assert.equal(await drainLocalSpool(h.deps, path.join(tmpDir, 'no-such-dir')), 0);
});
