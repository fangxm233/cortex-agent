// input:  synthetic bundles, hello events and update results
// output: assertions on push decisions, convergence and failure containment
// pos:    Covers the hello-driven client bundle publisher
import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  shouldPush,
  loadBundleFromDir,
  _onHelloForTesting as onHello,
  _onUpdateResultForTesting as onUpdateResult,
  _setBundleForTesting,
  _setSendForTesting,
  _setNotifyForTesting,
  _testReset,
  type ClientBundle,
} from '../src/domain/remote/client-hot-reload.js';

afterEach(() => {
  _testReset();
});

function makeBundle(tag: string): ClientBundle {
  const files = ['client.mjs', 'cortex-run-watcher.mjs'].map((name) => ({
    name,
    data: Buffer.from(`// ${name} ${tag}\n`).toString('base64'),
  }));
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(Buffer.from(f.data, 'base64'));
  return { version: `1.0.0-${tag}`, hash: h.digest('hex'), files };
}

// --- shouldPush: the pure decision table ---

test('shouldPush pushes a diverged device and skips a converged one', () => {
  assert.equal(shouldPush('other-hash', 'target', undefined, 1000), true);
  assert.equal(shouldPush(null, 'target', undefined, 1000), true);
  assert.equal(shouldPush('target', 'target', undefined, 1000), false);
});

test('shouldPush holds off while a push is in flight, then retries', () => {
  const last = { hash: 'target', at: 1000, ok: null };
  assert.equal(shouldPush('old', 'target', last, 1000 + 60_000), false);
  assert.equal(shouldPush('old', 'target', last, 1000 + 3 * 60_000), true);
});

test('shouldPush cools down after a failed install, then retries', () => {
  const last = { hash: 'target', at: 1000, ok: false };
  assert.equal(shouldPush('old', 'target', last, 1000 + 5 * 60_000), false);
  assert.equal(shouldPush('old', 'target', last, 1000 + 11 * 60_000), true);
});

test('shouldPush ignores stale attempts for a different bundle', () => {
  const last = { hash: 'previous-target', at: 1000, ok: false };
  assert.equal(shouldPush('old', 'target', last, 1001), true);
});

// --- hello-driven push flow ---

test('a diverged hello gets exactly one update push with the full artifact', () => {
  const bundle = makeBundle('v1');
  _setBundleForTesting(bundle);
  const sent: Array<{ device: string; message: Record<string, unknown> }> = [];
  _setSendForTesting((device, message) => sent.push({ device, message }));

  onHello('lab', 'entry-abc');
  onHello('lab', 'entry-abc'); // reconnect during flight — no second push

  assert.equal(sent.length, 1);
  assert.equal(sent[0].device, 'lab');
  assert.equal(sent[0].message.type, 'update');
  assert.equal(sent[0].message.hash, bundle.hash);
  assert.deepEqual(sent[0].message.files, bundle.files);
});

test('a converged hello after a push notifies and clears the attempt', () => {
  const bundle = makeBundle('v1');
  _setBundleForTesting(bundle);
  const sent: string[] = [];
  const notices: string[] = [];
  _setSendForTesting((device) => sent.push(device));
  _setNotifyForTesting((text) => notices.push(text));

  onHello('lab', 'old-hash');
  onUpdateResult('lab', { ok: true, hash: bundle.hash });
  onHello('lab', bundle.hash); // reconnect on the new binary

  assert.equal(sent.length, 1);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /lab/);
  assert.match(notices[0], new RegExp(bundle.hash.slice(0, 12)));
});

test('a failed install notifies and is not re-pushed within the cooldown', () => {
  const bundle = makeBundle('v1');
  _setBundleForTesting(bundle);
  const sent: string[] = [];
  const notices: string[] = [];
  _setSendForTesting((device) => sent.push(device));
  _setNotifyForTesting((text) => notices.push(text));

  onHello('lab', 'old-hash');
  onUpdateResult('lab', { ok: false, error: 'read-only file system' });
  onHello('lab', 'old-hash'); // reconnect — still diverged, but cooling down

  assert.equal(sent.length, 1);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /read-only file system/);
});

test('a converged hello with no pending attempt stays silent', () => {
  const bundle = makeBundle('v1');
  _setBundleForTesting(bundle);
  const sent: string[] = [];
  const notices: string[] = [];
  _setSendForTesting((device) => sent.push(device));
  _setNotifyForTesting((text) => notices.push(text));

  onHello('lab', bundle.hash);

  assert.equal(sent.length, 0);
  assert.equal(notices.length, 0);
});

test('hellos before the bundle is resolved are ignored without error', () => {
  const sent: string[] = [];
  _setSendForTesting((device) => sent.push(device));
  onHello('lab', 'anything');
  assert.equal(sent.length, 0);
});

// --- bundle loading ---

test('loadBundleFromDir hashes the artifact set and rejects incomplete dirs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hot-reload-'));
  try {
    fs.writeFileSync(path.join(dir, 'client.mjs'), '// client');
    assert.equal(loadBundleFromDir(dir, '1.0.0'), null);

    fs.writeFileSync(path.join(dir, 'cortex-run-watcher.mjs'), '// watcher');
    const bundle = loadBundleFromDir(dir, '1.0.0');
    assert.ok(bundle);
    assert.equal(bundle!.version, '1.0.0');
    assert.equal(bundle!.files.length, 2);

    const h = crypto.createHash('sha256');
    h.update(Buffer.from('// client'));
    h.update(Buffer.from('// watcher'));
    assert.equal(bundle!.hash, h.digest('hex'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
