import { afterEach, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  lastCacheTouch, lastModelActivity, noteCacheRefresh, resetCacheTouches,
} from '../../src/agent-adapter/claude/cache-touch.js';

const dirs: string[] = [];

function transcript(lines: unknown[], mtime?: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-touch-'));
  dirs.push(dir);
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n');
  if (mtime !== undefined) fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}

const T = Date.parse('2026-01-02T03:04:05.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

afterEach(() => {
  resetCacheTouches();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('lastModelActivity', () => {
  test('ignores the untimestamped entries a process appends on exit', () => {
    const file = transcript([
      { type: 'user', timestamp: iso(T - 60_000), message: { role: 'user', content: 'hi' } },
      { type: 'assistant', timestamp: iso(T), message: { model: 'claude-x', content: [] } },
      { type: 'last-prompt', lastPrompt: 'hi' },
      { type: 'cost-state', sessionId: 's', totalCostUSD: 1 },
    ], T + 65 * 60_000);
    assert.equal(lastModelActivity(file), T);
  });

  test('skips synthetic assistant records', () => {
    const file = transcript([
      { type: 'assistant', timestamp: iso(T), message: { model: 'claude-x', content: [] } },
      { type: 'assistant', timestamp: iso(T + 5_000), message: { model: '<synthetic>', content: [] } },
    ]);
    assert.equal(lastModelActivity(file), T);
  });

  test('falls back to mtime without a timestamped record, and tolerates junk lines', () => {
    const file = transcript(['{not json', { type: 'cost-state', totalCostUSD: 1 }], T);
    assert.equal(Math.round(lastModelActivity(file)!), T);
  });

  test('is null for a missing transcript', () => {
    assert.equal(lastModelActivity(path.join(os.tmpdir(), 'no-such-transcript.jsonl')), null);
  });
});

describe('lastCacheTouch', () => {
  test('takes the later of model activity and a keep-warm refresh', () => {
    const file = transcript([{ type: 'assistant', timestamp: iso(T), message: { model: 'claude-x' } }]);
    assert.equal(lastCacheTouch(file, 's'), T);
    noteCacheRefresh('s', T + 50 * 60_000);
    assert.equal(lastCacheTouch(file, 's'), T + 50 * 60_000);
    noteCacheRefresh('s', T - 1);
    assert.equal(lastCacheTouch(file, 's'), T);
  });

  test('falls back to the refresh when the transcript is missing', () => {
    noteCacheRefresh('s', T);
    assert.equal(lastCacheTouch(path.join(os.tmpdir(), 'no-such-transcript.jsonl'), 's'), T);
  });
});
