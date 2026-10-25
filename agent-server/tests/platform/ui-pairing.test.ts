import { describe, test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createPairingStore,
  normalizePairingCode,
  PAIRING_CODE_TTL_MS,
  PAIRING_MAX_FAILURES,
} from '@platform/ui-http/ui-pairing.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-pairing-'));
  file = path.join(dir, 'ui-pairing.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('normalizePairingCode', () => {
  test('accepts the displayed form, lowercase, spaces and look-alike letters', () => {
    assert.equal(normalizePairingCode('ABCD-EFGH'), 'ABCDEFGH');
    assert.equal(normalizePairingCode(' abcd efgh '), 'ABCDEFGH');
    assert.equal(normalizePairingCode('O1IL-2345'), '01112345');
  });

  test('rejects anything that is not eight code characters', () => {
    assert.equal(normalizePairingCode('ABCD-EFG'), null);
    assert.equal(normalizePairingCode('ABCD-EFGHJ'), null);
    assert.equal(normalizePairingCode('ABCD-EFGU'), null); // U is not in the alphabet
    assert.equal(normalizePairingCode('a'.repeat(64)), null); // a full token is not a code
  });
});

describe('createPairingStore', () => {
  test('a created code redeems exactly once, in any accepted spelling', () => {
    const store = createPairingStore({ file });
    const { code } = store.create();
    assert.match(code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    assert.equal(store.redeem(code.toLowerCase().replace('-', ' ')), true);
    assert.equal(store.redeem(code), false);
  });

  test('a code expires after the TTL', () => {
    let t = 1_000;
    const store = createPairingStore({ file, now: () => t });
    const { code, expiresAt } = store.create();
    assert.equal(expiresAt, 1_000 + PAIRING_CODE_TTL_MS);
    t = expiresAt;
    assert.equal(store.redeem(code), false);
  });

  test('a code created by another process (the CLI) is redeemable here', () => {
    const cli = createPairingStore({ file });
    const server = createPairingStore({ file });
    const { code } = cli.create();
    assert.equal(server.redeem(code), true);
  });

  test('too many wrong guesses void every outstanding code', () => {
    const store = createPairingStore({ file });
    const { code } = store.create();
    for (let i = 0; i < PAIRING_MAX_FAILURES; i += 1) assert.equal(store.redeem('ZZZZ-ZZZZ'), false);
    assert.equal(store.redeem(code), false);
    const fresh = store.create();
    assert.equal(store.redeem(fresh.code), true);
  });

  test('the file is private and a corrupt file reads as empty', () => {
    const store = createPairingStore({ file });
    store.create();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.writeFileSync(file, '{not json');
    assert.equal(store.redeem('ABCD-EFGH'), false);
    assert.equal(store.redeem(store.create().code), true);
  });
});
