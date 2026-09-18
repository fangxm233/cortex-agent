import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WaitpointRepo, type Waitpoint } from '../../../src/store/waitpoint-repo.js';
import {
  applySignal,
  cancelWaitpoint,
  createWaitpoint,
  expireDueWaitpoints,
  hashSecret,
  listWaitpointsForSession,
  publicView,
  DATA_MAX_CHARS,
  MAX_TTL_MS,
  MESSAGE_MAX_CHARS,
  RESOLVED_RETENTION_MS,
  type WaitpointServiceDeps,
} from '../../../src/domain/waitpoints/service.js';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-waitpoint-test-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Harness ────────────────────────────────────────────────────

interface Harness {
  deps: WaitpointServiceDeps;
  repo: WaitpointRepo;
  setNow: (t: number) => void;
  filePath: string;
}

function harness(opts: { maxWakesPerHour?: number } = {}): Harness {
  const filePath = path.join(tmpDir, `wp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const repo = new WaitpointRepo({ filePath });
  let clock = 1_700_000_000_000;
  let idSeq = 0;
  let secretSeq = 0;
  const deps: WaitpointServiceDeps = {
    repo,
    now: () => clock,
    maxWakesPerHour: () => opts.maxWakesPerHour ?? 12,
    newId: () => `wp_${String(++idSeq).padStart(12, '0')}`,
    newSecret: () => `secret-${++secretSeq}`,
  };
  return { deps, repo, filePath, setNow: (t: number) => { clock = t; } };
}

function owner() {
  return { sessionId: 'sess-1', channel: 'web:chan-1', project: 'demo' };
}

async function makeOne(h: Harness, over: Partial<Parameters<typeof createWaitpoint>[0]> = {}) {
  return createWaitpoint({ label: 'arm2', intent: 'wait for training', owner: owner(), ...over }, h.deps);
}

// ── create ─────────────────────────────────────────────────────

test('create mints an id + secret, stores only the hash, and defaults to a one-shot armed point', async () => {
  const h = harness();
  const { waitpoint, secret } = await makeOne(h);

  assert.match(waitpoint.id, /^wp_\d{12}$/);
  assert.equal(waitpoint.state, 'armed');
  assert.equal(waitpoint.maxSignals, 1);
  assert.equal(waitpoint.quorum.need, 1);
  assert.equal(waitpoint.failFast, true);
  assert.equal(waitpoint.secretHash, hashSecret(secret));
  assert.equal(JSON.stringify(waitpoint).includes(secret), false, 'plaintext secret must never be persisted');

  const stored = await h.repo.get(waitpoint.id);
  assert.equal(stored?.secretHash, hashSecret(secret));
});

test('ttl defaults to 7d and is clamped to the 30d ceiling', async () => {
  const h = harness();
  const base = 1_700_000_000_000;
  const { waitpoint: dflt } = await makeOne(h);
  assert.equal(dflt.expiresAt - base, 7 * 24 * 60 * 60 * 1000);

  const { waitpoint: huge } = await makeOne(h, { ttlMs: 365 * 24 * 60 * 60 * 1000 });
  assert.equal(huge.expiresAt - base, MAX_TTL_MS);

  const { waitpoint: bad } = await makeOne(h, { ttlMs: -5 });
  assert.equal(bad.expiresAt - base, 7 * 24 * 60 * 60 * 1000);
});

test("quorum 'all' collapses to the member count and coalescing turns on for multi-member points", async () => {
  const h = harness();
  const { waitpoint } = await makeOne(h, { quorum: { need: 'all', members: ['arm2', 'arm6', 'arm8'] } });
  assert.equal(waitpoint.quorum.need, 3);
  assert.deepEqual(waitpoint.quorum.members, ['arm2', 'arm6', 'arm8']);
  assert.equal(waitpoint.coalesceMs > 0, true);

  const { waitpoint: single } = await makeOne(h);
  assert.equal(single.coalesceMs, 0);
});

// ── signal: auth + idempotency ─────────────────────────────────

test('an unknown id is not-found and a wrong secret is bad-secret', async () => {
  const h = harness();
  const { waitpoint, secret } = await makeOne(h);

  assert.deepEqual(await applySignal({ id: 'wp_nope', secret, source: 'http' }, h.deps), { kind: 'not-found' });
  assert.deepEqual(
    await applySignal({ id: waitpoint.id, secret: 'wrong', source: 'http' }, h.deps),
    { kind: 'bad-secret' },
  );
  assert.deepEqual(
    await applySignal({ id: waitpoint.id, secret: '', source: 'http' }, h.deps),
    { kind: 'bad-secret' },
    'an empty secret must never match',
  );

  const stored = await h.repo.get(waitpoint.id);
  assert.equal(stored?.signals.length, 0, 'rejected signals must not be recorded');
});

test('a one-shot point fires once; the second signal is already-resolved and cannot re-fire it', async () => {
  const h = harness();
  const { waitpoint, secret } = await makeOne(h);

  const first = await applySignal({ id: waitpoint.id, secret, status: 'ok', message: 'done', source: 'http' }, h.deps);
  assert.equal(first.kind, 'accepted');
  assert.equal(first.kind === 'accepted' && first.fired, true);

  const stored = await h.repo.get(waitpoint.id);
  assert.equal(stored?.state, 'fired');
  assert.equal(stored?.fires, 1);
  assert.equal(stored?.delivery.pending, true);

  const second = await applySignal({ id: waitpoint.id, secret, status: 'ok', source: 'http' }, h.deps);
  assert.equal(second.kind, 'already-resolved');
  assert.equal(second.kind === 'already-resolved' && second.state, 'fired');

  const after = await h.repo.get(waitpoint.id);
  assert.equal(after?.fires, 1, 'a late signal must not bump the fire count');
  assert.equal(after?.signals.length, 1);
});

test('a repeated dedupeKey is dropped without recording a second signal', async () => {
  const h = harness();
  const { waitpoint, secret } = await makeOne(h, { quorum: { need: 3 } });

  await applySignal({ id: waitpoint.id, secret, source: 'spool', dedupeKey: 'spool:a.json' }, h.deps);
  const dup = await applySignal({ id: waitpoint.id, secret, source: 'spool', dedupeKey: 'spool:a.json' }, h.deps);

  assert.equal(dup.kind, 'duplicate');
  const stored = await h.repo.get(waitpoint.id);
  assert.equal(stored?.signals.length, 1);
  assert.equal(stored?.quorum.got.length, 1);
});

// ── quorum + failFast ──────────────────────────────────────────

test('a 3-member quorum only fires once all three report', async () => {
  const h = harness();
  const { waitpoint, secret } = await makeOne(h, { quorum: { need: 'all', members: ['arm2', 'arm6', 'arm8'] } });

  for (const member of ['arm2', 'arm6']) {
    const res = await applySignal({ id: waitpoint.id, secret, status: 'ok', member, source: 'http' }, h.deps);
    assert.equal(res.kind === 'accepted' && res.fired, false, `${member} must not fire the quorum alone`);
  }
  const last = await applySignal({ id: waitpoint.id, secret, status: 'ok', member: 'arm8', source: 'http' }, h.deps);
  assert.equal(last.kind === 'accepted' && last.fired, true);
  assert.equal((await h.repo.get(waitpoint.id))?.state, 'fired');
});

test('the same member reporting twice does not satisfy a quorum of two', async () => {
  const h = harness();
  const { waitpoint, secret } = await makeOne(h, { quorum: { need: 2, members: ['arm2', 'arm6'] } });

  await applySignal({ id: waitpoint.id, secret, member: 'arm2', source: 'http' }, h.deps);
  const again = await applySignal({ id: waitpoint.id, secret, member: 'arm2', source: 'http' }, h.deps);

  assert.equal(again.kind === 'accepted' && again.fired, false);
  assert.deepEqual((await h.repo.get(waitpoint.id))?.quorum.got, ['arm2']);
});

test('failFast wakes on the first failure even with the quorum unmet, and can be turned off', async () => {
  const h = harness();
  const { waitpoint, secret } = await makeOne(h, { quorum: { need: 'all', members: ['a', 'b', 'c'] } });
  const res = await applySignal({ id: waitpoint.id, secret, status: 'fail', member: 'b', source: 'http' }, h.deps);
  assert.equal(res.kind === 'accepted' && res.fired, true);

  const h2 = harness();
  const { waitpoint: patient, secret: s2 } = await makeOne(h2, {
    quorum: { need: 'all', members: ['a', 'b', 'c'] },
    failFast: false,
  });
  const quiet = await applySignal({ id: patient.id, secret: s2, status: 'fail', member: 'b', source: 'http' }, h2.deps);
  assert.equal(quiet.kind === 'accepted' && quiet.fired, false);
});

test('progress signals are recorded but never count toward the quorum and never wake', async () => {
  const h = harness();
  const { waitpoint, secret } = await makeOne(h);
  const res = await applySignal({ id: waitpoint.id, secret, status: 'progress', message: 'step 200', source: 'http' }, h.deps);

  assert.equal(res.kind === 'accepted' && res.fired, false);
  const stored = await h.repo.get(waitpoint.id);
  assert.equal(stored?.state, 'armed');
  assert.equal(stored?.signals.length, 1);
  assert.equal(stored?.quorum.got.length, 0);
});

// ── mailbox + rate limit ───────────────────────────────────────

test('a mailbox point stays armed across fires and resets its quorum each round', async () => {
  const h = harness();
  const { waitpoint, secret } = await makeOne(h, { maxSignals: 3 });

  for (let i = 0; i < 2; i += 1) {
    const res = await applySignal({ id: waitpoint.id, secret, source: 'http' }, h.deps);
    assert.equal(res.kind === 'accepted' && res.fired, true);
    const mid = await h.repo.get(waitpoint.id);
    assert.equal(mid?.state, 'armed');
    assert.deepEqual(mid?.quorum.got, []);
  }
  await applySignal({ id: waitpoint.id, secret, source: 'http' }, h.deps);
  const closed = await h.repo.get(waitpoint.id);
  assert.equal(closed?.state, 'fired');
  assert.equal(closed?.fires, 3);
});

test('the sliding wake cap delivers one warning wake then withholds the rest', async () => {
  const h = harness({ maxWakesPerHour: 2 });
  const { waitpoint, secret } = await makeOne(h, { maxSignals: 10 });

  assert.equal((await applySignal({ id: waitpoint.id, secret, source: 'http' }, h.deps)).kind, 'accepted');
  assert.equal((await applySignal({ id: waitpoint.id, secret, source: 'http' }, h.deps)).kind, 'accepted');
  // Third trips the cap — still delivered once, carrying the warning.
  const warned = await applySignal({ id: waitpoint.id, secret, source: 'http' }, h.deps);
  assert.equal(warned.kind === 'accepted' && warned.fired, true);
  assert.equal((await h.repo.get(waitpoint.id))?.rateLimitNotified, true);
  // Fourth is withheld.
  assert.equal((await applySignal({ id: waitpoint.id, secret, source: 'http' }, h.deps)).kind, 'rate-limited');

  // An hour later the window has slid and wakes resume.
  h.setNow(1_700_000_000_000 + 61 * 60 * 1000);
  const resumed = await applySignal({ id: waitpoint.id, secret, source: 'http' }, h.deps);
  assert.equal(resumed.kind === 'accepted' && resumed.fired, true);
});

// ── truncation ─────────────────────────────────────────────────

test('oversized message and data are truncated before they can reach a prompt', async () => {
  const h = harness();
  const { waitpoint, secret } = await makeOne(h);
  await applySignal(
    { id: waitpoint.id, secret, message: 'm'.repeat(MESSAGE_MAX_CHARS + 500), data: 'd'.repeat(DATA_MAX_CHARS + 500), source: 'http' },
    h.deps,
  );
  const signal = (await h.repo.get(waitpoint.id))!.signals[0];
  assert.equal(signal.message!.startsWith('m'.repeat(100)), true);
  assert.equal(signal.message!.length < MESSAGE_MAX_CHARS + 200, true);
  assert.equal(String(signal.data).length < DATA_MAX_CHARS + 200, true);
});

// ── expiry / cancel ────────────────────────────────────────────

test('a signal landing after expiry flips the record to expired and is refused', async () => {
  const h = harness();
  const { waitpoint, secret } = await makeOne(h, { ttlMs: 1000 });
  h.setNow(1_700_000_000_000 + 5000);

  const res = await applySignal({ id: waitpoint.id, secret, source: 'http' }, h.deps);
  assert.equal(res.kind, 'already-resolved');
  assert.equal(res.kind === 'already-resolved' && res.state, 'expired');
  assert.equal((await h.repo.get(waitpoint.id))?.delivery.pending, false);
});

test('the sweep expires due points and purges settled ones past the retention window', async () => {
  const h = harness();
  const { waitpoint: due } = await makeOne(h, { ttlMs: 1000 });
  const { waitpoint: live } = await makeOne(h, { ttlMs: 60 * 60 * 1000 });

  h.setNow(1_700_000_000_000 + 5000);
  const first = await expireDueWaitpoints(h.deps);
  assert.deepEqual(first.expired.map((w) => w.id), [due.id]);
  assert.equal(first.purged, 0);
  assert.equal((await h.repo.get(live.id))?.state, 'armed');

  h.setNow(1_700_000_000_000 + 5000 + RESOLVED_RETENTION_MS + 1000);
  const second = await expireDueWaitpoints(h.deps);
  assert.equal(second.purged >= 1, true);
  assert.equal(await h.repo.get(due.id), null);
});

test('cancel disarms an armed point once and is a no-op afterwards', async () => {
  const h = harness();
  const { waitpoint, secret } = await makeOne(h);

  assert.deepEqual(await cancelWaitpoint(waitpoint.id, h.deps), { cancelled: true, state: 'cancelled' });
  assert.deepEqual(await cancelWaitpoint(waitpoint.id, h.deps), { cancelled: false, state: 'cancelled' });
  assert.deepEqual(await cancelWaitpoint('wp_missing', h.deps), { cancelled: false });

  const res = await applySignal({ id: waitpoint.id, secret, source: 'http' }, h.deps);
  assert.equal(res.kind, 'already-resolved');
});

// ── queries / views ────────────────────────────────────────────

test('listWaitpointsForSession scopes by owner and publicView never leaks the secret hash', async () => {
  const h = harness();
  const { waitpoint } = await makeOne(h);
  await createWaitpoint(
    { label: 'other', intent: 'x', owner: { sessionId: 'sess-2', channel: 'web:other' } },
    h.deps,
  );

  const mine = await listWaitpointsForSession('sess-1', h.deps);
  assert.deepEqual(mine.map((w) => w.id), [waitpoint.id]);

  const view = publicView((await h.repo.get(waitpoint.id))!);
  assert.equal('secretHash' in view, false);
  assert.equal(JSON.stringify(view).includes(waitpoint.secretHash), false);
  assert.equal(view.id, waitpoint.id);
});

// ── persistence ────────────────────────────────────────────────

test('records survive a reopen and the shape guard is idempotent across cold reads', async () => {
  const h = harness();
  const { waitpoint, secret } = await makeOne(h);
  await applySignal({ id: waitpoint.id, secret, message: 'done', source: 'http' }, h.deps);

  const reopened = new WaitpointRepo({ filePath: h.filePath });
  const loaded = await reopened.get(waitpoint.id);
  assert.equal(loaded?.state, 'fired');
  assert.equal(loaded?.signals[0].message, 'done');

  const before = await fs.readFile(h.filePath, 'utf8');
  const again = new WaitpointRepo({ filePath: h.filePath });
  await again.list();
  assert.equal(await fs.readFile(h.filePath, 'utf8'), before, 'migrate must not rewrite an already-valid file');
});

test('the shape guard drops junk entries instead of failing the read', async () => {
  const h = harness();
  const { waitpoint } = await makeOne(h);
  const raw = JSON.parse(await fs.readFile(h.filePath, 'utf8')) as Record<string, unknown>;
  raw['wp_junk'] = { nope: true };
  raw['wp_null'] = null;
  await fs.writeFile(h.filePath, JSON.stringify(raw, null, 2));

  const reopened = new WaitpointRepo({ filePath: h.filePath });
  const all = await reopened.list();
  assert.deepEqual(all.map((w: Waitpoint) => w.id), [waitpoint.id]);
});
