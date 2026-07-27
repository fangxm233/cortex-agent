// input:  pending injection record plus injected ledger/history/store seams
// output: idempotent commit and startup orphan-recovery regression coverage
// pos:    pending injection cross-store recovery specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  commitPendingInjection,
  recoverPendingInjections,
  type PendingInjectionCommitDeps,
} from '../../src/orchestration/pending-injection-recovery.js';
import type { PendingInjectionRecord } from '../../src/store/pending-injection-repo.js';

function record(id = 'pin-1'): PendingInjectionRecord {
  return {
    id,
    sessionId: 'sess-1',
    channel: 'web:sess-1',
    messageId: `web-${id}`,
    sessionName: 'cortex-nimbus',
    backend: 'claude',
    profileName: 'default',
    text: 'change direction',
    attachments: [{ name: 'note.txt', path: 'workspace/attachments/note.txt', size: 4, mimeType: 'text/plain', type: 'file' }],
    agentMessage: '[context]\nchange direction',
    createdAt: '2026-07-26T00:00:00.000Z',
  };
}

function recorder(opts: { ledgerExists?: boolean; historyExists?: boolean; records?: PendingInjectionRecord[] } = {}) {
  const calls: string[] = [];
  const removed: string[] = [];
  const appended: any[] = [];
  const deps: PendingInjectionCommitDeps = {
    pendingRepo: {
      listAll: async () => opts.records ?? [record()],
      remove: async (id) => { calls.push(`remove:${id}`); removed.push(id); return true; },
    },
    history: {
      hasUserSourceId: async (_sessionId, id) => {
        calls.push(`history-check:${id}`);
        return !!opts.historyExists;
      },
      appendUser: async (sessionId, input) => {
        calls.push(`history-append:${input.sourceId}`);
        appended.push({ sessionId, ...input });
      },
    },
    ledger: {
      findTurn: async (_channel, messageId) => {
        calls.push(`ledger-check:${messageId}`);
        return opts.ledgerExists ? ({} as any) : null;
      },
      initAndBeginTurn: async (_channel, input) => {
        calls.push(`ledger-begin:${input.userMessageTs}`);
        return {} as any;
      },
    },
    now: () => '2026-07-26T00:00:09.000Z',
  };
  return { deps, calls, removed, appended };
}

test('commit orders ledger ensure before history ensure, then removes the active record', async () => {
  const r = recorder();
  const out = await commitPendingInjection(record(), r.deps);

  assert.equal(out.committedTs, '2026-07-26T00:00:09.000Z');
  assert.deepEqual(r.calls, [
    'ledger-check:web-pin-1',
    'ledger-begin:web-pin-1',
    'history-check:pin-1',
    'history-append:pin-1',
    'remove:pin-1',
  ]);
  assert.equal(r.appended[0].ts, out.committedTs);
  assert.equal(r.appended[0].text, 'change direction');
  assert.equal(r.appended[0].agentMessage, '[context]\nchange direction');
  assert.deepEqual(r.appended[0].attachments, record().attachments);
});

test('replay after a ledger-only crash does not create a duplicate ledger turn', async () => {
  const r = recorder({ ledgerExists: true });
  await commitPendingInjection(record(), r.deps);
  assert.ok(!r.calls.some((c) => c.startsWith('ledger-begin:')));
  assert.equal(r.appended.length, 1);
  assert.deepEqual(r.removed, ['pin-1']);
});

test('replay after a history-only crash does not append a duplicate user row', async () => {
  const r = recorder({ historyExists: true });
  await commitPendingInjection(record(), r.deps);
  assert.ok(!r.calls.some((c) => c.startsWith('history-append:')));
  assert.ok(r.calls.some((c) => c.startsWith('ledger-begin:')));
  assert.deepEqual(r.removed, ['pin-1']);
});

test('concurrent commits on one channel preserve ledger and history order', async () => {
  const calls: string[] = [];
  const deps: PendingInjectionCommitDeps = {
    pendingRepo: {
      listAll: async () => [],
      remove: async (id) => { calls.push(`remove:${id}`); return true; },
    },
    history: {
      hasUserSourceId: async (_sessionId, sourceId) => {
        if (sourceId === 'pin-1') await new Promise((resolve) => setTimeout(resolve, 10));
        return false;
      },
      appendUser: async (_sessionId, input) => { calls.push(`history:${input.sourceId}`); },
    },
    ledger: {
      findTurn: async () => null,
      initAndBeginTurn: async (_channel, input) => {
        calls.push(`ledger:${input.userMessageTs}`);
        return {};
      },
    },
    now: () => '2026-07-26T00:00:09.000Z',
  };

  await Promise.all([
    commitPendingInjection(record('pin-1'), deps),
    commitPendingInjection(record('pin-2'), deps),
  ]);

  assert.deepEqual(calls, [
    'ledger:web-pin-1', 'history:pin-1', 'remove:pin-1',
    'ledger:web-pin-2', 'history:pin-2', 'remove:pin-2',
  ]);
});

test('startup recovery drains every active record through the same idempotent commit', async () => {
  const records = [record('pin-1'), record('pin-2')];
  const r = recorder({ records });
  assert.equal(await recoverPendingInjections(r.deps), 2);
  assert.deepEqual(r.removed, ['pin-1', 'pin-2']);
  assert.deepEqual(r.appended.map((x) => x.sourceId), ['pin-1', 'pin-2']);
});
