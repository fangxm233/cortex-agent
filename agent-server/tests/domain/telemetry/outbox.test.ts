import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'vitest';
import {
  appendToOutbox, newestWithin, settleOutbox, takeOutbox, wipeOutbox,
} from '@domain/telemetry/outbox.js';
import { crashEvent } from './helpers.js';

function outboxFile(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'telemetry-outbox-')), 'telemetry', 'outbox.jsonl');
}

test('valid events append as JSON lines; invalid ones are refused', () => {
  const file = outboxFile();
  assert.equal(appendToOutbox(crashEvent(), file), true);
  assert.equal(appendToOutbox({ ...crashEvent(), message: 'x'.repeat(301) } as never, file), false);
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1);
});

test('the outbox drops its oldest lines once it passes the cap', () => {
  const file = outboxFile();
  const cap = 4_000;
  for (let i = 0; i < 40; i += 1) appendToOutbox(crashEvent({ message: `event ${i}` }), file, cap);
  assert.ok(statSync(file).size <= cap);
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.match(lines.at(-1)!, /event 39/);
  assert.doesNotMatch(lines[0], /"event 0"/);
});

test('newestWithin keeps the newest lines that fit', () => {
  assert.deepEqual(newestWithin(['aaaa', 'bb', 'cc'], 6), ['bb', 'cc']);
  assert.deepEqual(newestWithin(['aaaa'], 2), []);
});

test('take moves pending events aside, settle writes back the unsent ones', () => {
  const file = outboxFile();
  appendToOutbox(crashEvent({ message: 'one' }), file);
  appendToOutbox(crashEvent({ message: 'two' }), file);
  const taken = takeOutbox(file);
  assert.equal(taken.length, 2);
  assert.equal(existsSync(file), false);
  appendToOutbox(crashEvent({ message: 'three' }), file);
  settleOutbox([taken[1]], file);
  assert.deepEqual(takeOutbox(file).map((event) => (event as { message: string }).message), ['two', 'three']);
  settleOutbox([], file);
  assert.deepEqual(takeOutbox(file), []);
});

test('wipe removes both the outbox and the pending file', () => {
  const file = outboxFile();
  appendToOutbox(crashEvent(), file);
  takeOutbox(file);
  appendToOutbox(crashEvent(), file);
  wipeOutbox(file);
  assert.deepEqual(takeOutbox(file), []);
});
