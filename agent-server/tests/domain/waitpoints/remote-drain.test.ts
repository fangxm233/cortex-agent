import './../../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WaitpointRepo } from '../../../src/store/waitpoint-repo.js';
import { createWaitpoint, type WaitpointServiceDeps } from '../../../src/domain/waitpoints/service.js';
import { resetSignalIngressState, type IngestDeps } from '../../../src/orchestration/waitpoint-ingress.js';
import { resetWaitpointTimers } from '../../../src/orchestration/waitpoint-notifier.js';
import { drainDeviceSpools, parseSpoolBatch, type RemoteDrainDeps } from '../../../src/orchestration/waitpoint-remote-drain.js';

let tmpDir: string;
const BASE = 1_700_000_000_000;

beforeAll(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-wp-remote-')); });
afterAll(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });
beforeEach(() => { resetSignalIngressState(); resetWaitpointTimers(); });

interface Harness {
  repo: WaitpointRepo;
  service: WaitpointServiceDeps;
  ingest: IngestDeps;
  sent: string[];
  commands: Array<{ device: string; command: string }>;
  /** Files the fake device currently holds, by name. */
  deviceFiles: Map<string, string>;
  deps: RemoteDrainDeps;
}

function harness(opts: { devices?: string[]; online?: (d: string) => boolean } = {}): Harness {
  const repo = new WaitpointRepo({ filePath: path.join(tmpDir, `wp-${Math.random().toString(36).slice(2)}.json`) });
  const sent: string[] = [];
  const commands: Array<{ device: string; command: string }> = [];
  const deviceFiles = new Map<string, string>();
  let seq = 0;
  const now = () => BASE;
  const service: WaitpointServiceDeps = {
    repo, now,
    maxWakesPerHour: () => 12,
    defaultTtlMs: () => 7 * 24 * 60 * 60 * 1000,
    newId: () => `wp_${String(++seq).padStart(12, '0')}`,
    newSecret: () => `secret-${seq}`,
  };
  const ingest: IngestDeps = {
    service, now,
    notifier: { repo, now, deliver: async (_c, text) => { sent.push(text); } },
  };
  return {
    repo, service, ingest, sent, commands, deviceFiles,
    deps: {
      ingest,
      listDeviceTargets: async () => opts.devices ?? ['cluster'],
      isDeviceOnline: opts.online ?? (() => true),
      runBash: async (device, command) => {
        commands.push({ device, command });
        if (command.startsWith('cd ')) {
          for (const name of [...deviceFiles.keys()]) {
            if (command.includes(`'${name}'`)) deviceFiles.delete(name);
          }
          return { stdout: '' };
        }
        let stdout = '';
        for (const [name, body] of deviceFiles) stdout += `===CORTEX-SIGNAL:${name}\n${body}\n`;
        return { stdout };
      },
    },
  };
}

function owner() { return { sessionId: 'sess-1', channel: 'web:chan-1' }; }

// ── batch parsing ──────────────────────────────────────────────

test('the batch parser splits files apart and refuses names it would have to quote', () => {
  const parsed = parseSpoolBatch(
    '===CORTEX-SIGNAL:a.json\n{"id":"wp_1"}\n'
    + "===CORTEX-SIGNAL:evil'; rm -rf ~; '.json\n{\"id\":\"wp_2\"}\n"
    + '===CORTEX-SIGNAL:../../escape.json\n{"id":"wp_3"}\n'
    + '===CORTEX-SIGNAL:b.json\n{"id":"wp_4"}\n',
  );
  assert.deepEqual(parsed.map((p) => p.name), ['a.json', 'b.json']);
  assert.equal(JSON.parse(parsed[0].body).id, 'wp_1');
});

test('an empty device returns nothing rather than an empty-named entry', () => {
  assert.deepEqual(parseSpoolBatch(''), []);
  assert.deepEqual(parseSpoolBatch('\n\n'), []);
});

// ── drain ──────────────────────────────────────────────────────

test('a device signal is applied, wakes the session, and is then cleared from the device', async () => {
  const h = harness();
  const { waitpoint, secret } = await createWaitpoint(
    { label: 'arm2', intent: 'training', owner: owner(), emitFrom: { kind: 'device', device: 'cluster' } },
    h.service,
  );
  h.deviceFiles.set('123.json', JSON.stringify({ id: waitpoint.id, secret, status: 'ok', message: 'exit=0' }));

  assert.equal(await drainDeviceSpools(h.deps), 1);
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /exit=0/);
  assert.equal(h.deviceFiles.size, 0, 'a drained file must be removed from the device');
  assert.equal(h.commands.length, 2, 'one read, one remove');
  assert.match(h.commands[1].command, /rm -f -- '123\.json'/);
});

test('read happens before remove, so a crash between them replays instead of losing the signal', async () => {
  const h = harness();
  const { waitpoint, secret } = await createWaitpoint(
    { label: 'arm2', intent: 'training', owner: owner(), emitFrom: { kind: 'device', device: 'cluster' } },
    h.service,
  );
  const body = JSON.stringify({ id: waitpoint.id, secret, status: 'ok' });
  h.deviceFiles.set('123.json', body);

  // Simulate the crash: the remove never lands, so the file is still there next tick.
  const noRemove: RemoteDrainDeps = {
    ...h.deps,
    runBash: async (device, command) => {
      if (command.startsWith('cd ')) throw new Error('daemon died before the rm');
      return h.deps.runBash(device, command, 0);
    },
  };
  assert.equal(await drainDeviceSpools(noRemove), 1);
  assert.equal(h.deviceFiles.size, 1);

  // Next tick re-reads it; the filename is the dedupe key, so nothing is applied twice.
  assert.equal(await drainDeviceSpools(h.deps), 0);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.sent.length, 1, 'the replay must not produce a second wake');
  assert.equal((await h.repo.get(waitpoint.id))!.signals.length, 1);
});

test('offline devices are skipped and their files keep until they reconnect', async () => {
  const h = harness({ online: () => false });
  h.deviceFiles.set('123.json', '{"id":"wp_x","secret":"s"}');
  assert.equal(await drainDeviceSpools(h.deps), 0);
  assert.equal(h.commands.length, 0, 'an offline device must not be dialled');
  assert.equal(h.deviceFiles.size, 1);
});

test('a malformed or unauthorised entry is left on the device and does not stop the batch', async () => {
  const h = harness();
  const { waitpoint, secret } = await createWaitpoint(
    { label: 'arm2', intent: 'training', owner: owner(), emitFrom: { kind: 'device', device: 'cluster' } },
    h.service,
  );
  h.deviceFiles.set('broken.json', '{not json');
  h.deviceFiles.set('wrong-secret.json', JSON.stringify({ id: waitpoint.id, secret: 'nope' }));
  h.deviceFiles.set('good.json', JSON.stringify({ id: waitpoint.id, secret, status: 'ok' }));

  assert.equal(await drainDeviceSpools(h.deps), 1);
  assert.deepEqual([...h.deviceFiles.keys()].sort(), ['broken.json', 'wrong-secret.json']);
});

test('an unknown waitpoint is cleared rather than left to be re-read forever', async () => {
  const h = harness();
  h.deviceFiles.set('stranger.json', JSON.stringify({ id: 'wp_gone', secret: 'x' }));
  assert.equal(await drainDeviceSpools(h.deps), 0);
  assert.equal(h.deviceFiles.size, 0);
});

test('a device failing outright does not stop the other devices in the same pass', async () => {
  const h = harness({ devices: ['broken-box', 'cluster'] });
  const { waitpoint, secret } = await createWaitpoint(
    { label: 'arm2', intent: 'training', owner: owner(), emitFrom: { kind: 'device', device: 'cluster' } },
    h.service,
  );
  h.deviceFiles.set('123.json', JSON.stringify({ id: waitpoint.id, secret, status: 'ok' }));

  const flaky: RemoteDrainDeps = {
    ...h.deps,
    runBash: async (device, command, timeout) => {
      if (device === 'broken-box') throw new Error('socket closed');
      return h.deps.runBash(device, command, timeout);
    },
  };
  assert.equal(await drainDeviceSpools(flaky), 1);
});

test('every named device is checked for liveness before any command is sent', async () => {
  const h = harness({ devices: ['cluster', 'brev-1'] });
  const seen: string[] = [];
  await drainDeviceSpools({ ...h.deps, isDeviceOnline: (d) => { seen.push(d); return false; } });
  assert.deepEqual(seen, ['cluster', 'brev-1']);
  assert.equal(h.commands.length, 0);
});

test('the device list is derived from armed waitpoints, not from the device registry', async () => {
  const h = harness();
  await createWaitpoint({ label: 'local', intent: 'x', owner: owner() }, h.service);
  await createWaitpoint(
    { label: 'remote', intent: 'x', owner: owner(), emitFrom: { kind: 'device', device: 'cluster' } },
    h.service,
  );
  const armed = await h.repo.listArmed();
  const devices = [...new Set(armed.flatMap((wp) => (wp.emitFrom.kind === 'device' ? [wp.emitFrom.device] : [])))];
  assert.deepEqual(devices, ['cluster'], 'a local waitpoint must never cause a device round trip');
});
