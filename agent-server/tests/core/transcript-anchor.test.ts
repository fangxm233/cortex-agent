import { afterEach, beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  anchorAtEnd,
  lastEntryId,
  ownsTranscript,
  truncateToAnchor,
} from '../../src/core/transcript-anchor.js';
import { toTurnAnchor } from '../../src/core/types/transcript-anchor.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'transcript-anchor-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function jsonl(rows: object[]): string {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join('');
}

const PI_ROWS = [
  { type: 'session', id: 'sess-1', cwd: '/w' },
  { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'hi' } },
  { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'a1x' }] } },
  { type: 'message', id: 'u2', parentId: 'a1', message: { role: 'user', content: 'again' } },
  { type: 'message', id: 'a2', parentId: 'u2', message: { role: 'assistant', content: 'done' } },
];

const CLAUDE_ROWS = [
  { type: 'queue-operation', operation: 'enqueue', content: 'hi' },
  { type: 'user', uuid: 'c-u1', parentUuid: null, message: { role: 'user', content: 'hi' } },
  { type: 'assistant', uuid: 'c-a1', parentUuid: 'c-u1', message: { role: 'assistant', content: 'yo' } },
  { type: 'last-prompt', lastPrompt: 'hi' },
  { type: 'cost-state' },
  { type: 'queue-operation', operation: 'enqueue', content: 'next' },
  { type: 'user', uuid: 'c-u2', parentUuid: 'c-a1', message: { role: 'user', content: 'next' } },
  { type: 'assistant', uuid: 'c-a2', parentUuid: 'c-u2', message: { role: 'assistant', content: 'ok' } },
];

function write(name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, body);
  return file;
}

test('lastEntryId reads the newest PI id and the newest Claude uuid past trailing metadata', async () => {
  assert.equal(await lastEntryId(write('pi.jsonl', jsonl(PI_ROWS))), 'a2');
  assert.equal(await lastEntryId(write('claude.jsonl', jsonl(CLAUDE_ROWS.slice(0, 5)))), 'c-a1');
});

test('lastEntryId finds an entry that spans many tail chunks, multibyte text included', async () => {
  const big = { type: 'message', id: 'big', parentId: 'a2', message: { content: '触觉'.repeat(80_000) } };
  const file = write('big.jsonl', jsonl([...PI_ROWS, big, { type: 'cost-state' }]));
  assert.equal(await lastEntryId(file), 'big');
});

test('anchorAtEnd is null for a missing file and for one with no entries', async () => {
  assert.equal(await anchorAtEnd(path.join(dir, 'missing.jsonl')), null);
  assert.equal(await anchorAtEnd(write('meta.jsonl', jsonl([{ type: 'cost-state' }]))), null);
  const file = write('pi.jsonl', jsonl(PI_ROWS));
  assert.deepEqual(await anchorAtEnd(file), { file, after: 'a2' });
});

test('truncating after an entry keeps it and the id-less lines up to the next entry', async () => {
  const file = write('claude.jsonl', jsonl(CLAUDE_ROWS));
  assert.equal(await truncateToAnchor({ file, after: 'c-a1' }), true);
  assert.equal(readFileSync(file, 'utf8'), jsonl(CLAUDE_ROWS.slice(0, 6)));
});

test('truncating before an entry keeps only what precedes it', async () => {
  const file = write('claude.jsonl', jsonl(CLAUDE_ROWS));
  assert.equal(await truncateToAnchor({ file, before: 'c-u2' }), true);
  assert.equal(readFileSync(file, 'utf8'), jsonl(CLAUDE_ROWS.slice(0, 6)));
});

test('an id that only appears as a parent or nested id is not an entry', async () => {
  const file = write('pi.jsonl', jsonl(PI_ROWS));
  assert.equal(await truncateToAnchor({ file, after: 'a1x' }), false);
  assert.equal(await truncateToAnchor({ file, after: 'u2' }), true);
  assert.equal(readFileSync(file, 'utf8'), jsonl(PI_ROWS.slice(0, 4)));
});

test('a missing file or entry leaves the transcript untouched', async () => {
  const file = write('pi.jsonl', jsonl(PI_ROWS));
  assert.equal(await truncateToAnchor({ file, before: 'nope' }), false);
  assert.equal(await truncateToAnchor({ file: path.join(dir, 'gone.jsonl'), after: 'a1' }), false);
  assert.equal(readFileSync(file, 'utf8'), jsonl(PI_ROWS));
});

test('ownsTranscript matches PI prefixed, PI canonical and Claude names to their backend id', () => {
  assert.equal(ownsTranscript('/s/2026-10-26T05-37-05-933Z_01a1-b6.jsonl', '01a1-b6'), true);
  assert.equal(ownsTranscript('/s/01a1-b6.jsonl', '01a1-b6'), true);
  assert.equal(ownsTranscript('/s/2026-10-26T05-37-05-933Z_01a1-b6.jsonl', 'other'), false);
  assert.equal(ownsTranscript('/s/01a1-b6.jsonl.turn-2.bak', '01a1-b6'), false);
});

test('toTurnAnchor accepts the two shapes and rejects anything else', () => {
  assert.deepEqual(toTurnAnchor({ file: '/f', after: 'x' }), { file: '/f', after: 'x' });
  assert.deepEqual(toTurnAnchor({ file: '/f', before: 'y' }), { file: '/f', before: 'y' });
  assert.equal(toTurnAnchor({ file: '/f' }), undefined);
  assert.equal(toTurnAnchor({ after: 'x' }), undefined);
  assert.equal(toTurnAnchor(null), undefined);
});
