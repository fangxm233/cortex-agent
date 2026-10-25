import { describe, test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createUiDeviceStore, DEVICE_SEEN_PERSIST_MS } from '@platform/ui-http/ui-devices.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-devices-'));
  file = path.join(dir, 'ui-devices.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('createUiDeviceStore', () => {
  test('an issued token identifies its device; anything else matches nothing', () => {
    const store = createUiDeviceStore({ file });
    const { device, token } = store.issue('Desktop · Windows');
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(store.match(token)?.id, device.id);
    assert.equal(store.match(`${token.slice(0, -1)}0`), undefined);
    assert.equal(store.match(''), undefined);
    assert.equal(store.match(undefined), undefined);
  });

  test('only a hash of the token reaches disk, and the file is private', () => {
    const store = createUiDeviceStore({ file });
    const { token } = store.issue('Android');
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(raw.includes(token), false);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  test('devices survive a restart and revoke takes effect at once', () => {
    const first = createUiDeviceStore({ file });
    const a = first.issue('A');
    const b = first.issue('B');
    const second = createUiDeviceStore({ file });
    assert.deepEqual(second.list().map((d) => d.name), ['A', 'B']);
    assert.equal(second.revoke(a.device.id), true);
    assert.equal(second.revoke(a.device.id), false);
    assert.equal(second.match(a.token), undefined);
    assert.equal(second.match(b.token)?.name, 'B');
    assert.deepEqual(createUiDeviceStore({ file }).list().map((d) => d.name), ['B']);
  });

  test('use updates lastSeenAt, persisted at most once per interval', () => {
    let t = 1_000;
    const store = createUiDeviceStore({ file, now: () => t });
    const { token } = store.issue('A');
    t += 1_000;
    assert.equal(store.match(token)?.lastSeenAt, 2_000);
    assert.equal(createUiDeviceStore({ file }).list()[0].lastSeenAt, 1_000);
    t += DEVICE_SEEN_PERSIST_MS;
    store.match(token);
    assert.equal(createUiDeviceStore({ file }).list()[0].lastSeenAt, t);
  });

  test('names are trimmed and capped, with a fallback', () => {
    const store = createUiDeviceStore({ file });
    assert.equal(store.issue('   ').device.name, 'App');
    assert.equal(store.issue('x'.repeat(200)).device.name.length, 60);
  });

  test('a corrupt file reads as empty', () => {
    fs.writeFileSync(file, '[oops');
    assert.deepEqual(createUiDeviceStore({ file }).list(), []);
  });
});
