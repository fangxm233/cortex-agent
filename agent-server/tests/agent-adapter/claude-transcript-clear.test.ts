import { afterEach, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import {
  CLEARED_TOOL_RESULT, clearOldToolResults, clearToolResultsForColdResume, liveContextTokens,
  type TranscriptFs,
} from '../../src/agent-adapter/claude/transcript-clear.js';
import { noteCacheRefresh, resetCacheTouches } from '../../src/agent-adapter/claude/cache-touch.js';
import { ClaudeAdapter } from '../../src/agent-adapter/claude/adapter.js';
import { computeTranscriptPath } from '../../src/agent-adapter/claude/transcript-path.js';
import { AGENT_CWD } from '../../src/core/paths.js';
import { updateSettings } from '../../src/core/settings.js';
import { engineSpecFixture } from '../engine-spec-fixture.js';

const SID = '7b1e2c4a-0d3f-4e5a-9b6c-1d2e3f4a5b6c';
const MINUTE = 60_000;
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const BIG = 'x'.repeat(5_000);

let toolSeq = 0;

function toolUse(): { id: string; line: string } {
  const id = `toolu_${++toolSeq}`;
  const line = JSON.stringify({
    type: 'assistant', sessionId: SID,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/a' } }] },
  });
  return { id, line };
}

function toolResult(id: string, content: unknown = BIG): string {
  return JSON.stringify({
    parentUuid: 'p', type: 'user', sessionId: SID,
    message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, is_error: false }] },
    toolUseResult: { stdout: 'kept verbatim' },
  });
}

function exchanges(count: number, content: unknown = BIG): string[] {
  return Array.from({ length: count }, () => {
    const use = toolUse();
    return [use.line, toolResult(use.id, content)];
  }).flat();
}

function assistantUsage(
  read: number, at = NOW, { created = 0, input = 3, model = 'claude-opus-5' } = {},
): string {
  return JSON.stringify({
    type: 'assistant', sessionId: SID, timestamp: new Date(at).toISOString(),
    message: {
      model, role: 'assistant', content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: input, cache_creation_input_tokens: created, cache_read_input_tokens: read, output_tokens: 9 },
    },
  });
}

const BOUNDARY = JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' });
const COST_STATE = JSON.stringify({ type: 'cost-state', sessionId: SID, totalCostUSD: 4.25, modelUsage: {} });

function resultContents(lines: string[]): unknown[] {
  return lines.flatMap((line) => {
    try {
      const record = JSON.parse(line);
      const content = record.message?.content;
      return Array.isArray(content) ? content.filter((b: any) => b.type === 'tool_result').map((b: any) => b.content) : [];
    } catch {
      return [];
    }
  });
}

describe('clearOldToolResults', () => {
  test('stubs all but the most recent 10 tool results', () => {
    const lines = exchanges(13);
    const out = clearOldToolResults(lines);
    const contents = resultContents(out.lines);
    assert.deepEqual(contents.slice(0, 3), Array(3).fill(CLEARED_TOOL_RESULT));
    assert.deepEqual(contents.slice(3), Array(10).fill(BIG));
    assert.equal(out.clearedCount, 3);
    assert.equal(out.charsRemoved, 3 * (JSON.stringify(BIG).length - JSON.stringify(CLEARED_TOOL_RESULT).length));
  });

  test('does nothing with 10 or fewer tool results', () => {
    const lines = exchanges(10);
    const out = clearOldToolResults(lines);
    assert.equal(out.clearedCount, 0);
    assert.deepEqual(out.lines, lines);
  });

  test('only counts and clears tool results after the last compact boundary', () => {
    const before = exchanges(5);
    const lines = [...exchanges(4), BOUNDARY, ...before, BOUNDARY, ...exchanges(12)];
    const out = clearOldToolResults(lines);
    assert.equal(out.clearedCount, 2);
    assert.deepEqual(out.lines.slice(0, 20), lines.slice(0, 20));
    assert.deepEqual(resultContents(out.lines.slice(20)).slice(0, 2), [CLEARED_TOOL_RESULT, CLEARED_TOOL_RESULT]);
  });

  test('keeps every untouched line byte-identical and changes nothing else on a cleared line', () => {
    const lines = [
      COST_STATE,
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'a "tool_result" mentioned in text' } }),
      '{"type":"attachment", "spacing":  "odd"}',
      ...exchanges(11),
      COST_STATE,
      '',
    ];
    const out = clearOldToolResults(lines);
    assert.equal(out.clearedCount, 1);
    const changed = out.lines.map((line, i) => (line === lines[i] ? null : i)).filter((i) => i !== null);
    assert.deepEqual(changed, [4]);
    const original = JSON.parse(lines[4]);
    original.message.content[0].content = CLEARED_TOOL_RESULT;
    assert.deepEqual(JSON.parse(out.lines[4]), original);
    assert.equal(JSON.parse(out.lines[4]).toolUseResult.stdout, 'kept verbatim');
  });

  test('keeps a malformed line verbatim', () => {
    const torn = '{"type":"user","message":{"content":[{"type":"tool_result","content":"cut';
    const lines = [...exchanges(11), torn];
    const out = clearOldToolResults(lines);
    assert.equal(out.clearedCount, 1);
    assert.equal(out.lines.at(-1), torn);
  });

  test('clears image and document results, but keeps a result no longer than the stub', () => {
    const image = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(4_000) } }];
    const lines = [...exchanges(1, image), ...exchanges(1, 'ok'), ...exchanges(10)];
    const out = clearOldToolResults(lines);
    assert.equal(out.clearedCount, 1);
    assert.deepEqual(resultContents(out.lines).slice(0, 2), [CLEARED_TOOL_RESULT, 'ok']);
  });

  test('counts each result of a parallel tool call separately', () => {
    const blocks = Array.from({ length: 12 }, (_, i) => ({ type: 'tool_result', tool_use_id: `t${i}`, content: BIG }));
    const lines = [JSON.stringify({ type: 'user', message: { role: 'user', content: blocks } })];
    const out = clearOldToolResults(lines);
    assert.equal(out.clearedCount, 2);
    assert.deepEqual(resultContents(out.lines).slice(0, 3), [CLEARED_TOOL_RESULT, CLEARED_TOOL_RESULT, BIG]);
  });
});

describe('liveContextTokens', () => {
  test('reads the last real request after the last compact boundary', () => {
    const lines = [
      assistantUsage(500_000), BOUNDARY, assistantUsage(90_000, NOW, { created: 20_000, input: 5 }),
      assistantUsage(0, NOW, { input: 0, model: '<synthetic>' }),
    ];
    assert.equal(liveContextTokens(lines), 110_005);
  });

  test('is null when no request followed the last compact boundary', () => {
    assert.equal(liveContextTokens([assistantUsage(500_000), BOUNDARY, ...exchanges(2)]), null);
  });
});

/** Written now, like the `cost-state` the CLI appends when the idle process exits; the cache's
 *  age comes from the last model record's timestamp. */
function writeTranscript(lines: string[], file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cold-clear-')), `${SID}.jsonl`)): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  return file;
}

function minutesBefore(minutes: number, now = NOW): number {
  return now - minutes * MINUTE;
}

function coldTranscript(lastRequestAt = minutesBefore(70)): string[] {
  return [...exchanges(3), BOUNDARY, COST_STATE, ...exchanges(25), assistantUsage(150_000, lastRequestAt), COST_STATE];
}

const nodeIo: TranscriptFs = {
  readFileSync: (p) => fs.readFileSync(p),
  statSync: (p) => fs.statSync(p),
  writeFileSync: (p, data, mode) => fs.writeFileSync(p, data, { mode }),
  appendFileSync: (p, data) => fs.appendFileSync(p, data),
  renameSync: (from, to) => fs.renameSync(from, to),
  unlinkSync: (p) => fs.unlinkSync(p),
};

afterEach(async () => {
  resetCacheTouches();
  await updateSettings({ coldResumeClearToolResults: true });
});

describe('clearToolResultsForColdResume', () => {
  test('rewrites a cold, large transcript in place', () => {
    const lines = coldTranscript();
    const file = writeTranscript(lines);
    const before = fs.readFileSync(file);
    const outcome = clearToolResultsForColdResume(file, SID, NOW);
    assert.deepEqual(outcome, {
      cleared: true, clearedCount: 15,
      charsRemoved: 15 * (JSON.stringify(BIG).length - JSON.stringify(CLEARED_TOOL_RESULT).length),
    });
    const after = fs.readFileSync(file);
    const head = Buffer.from(lines.slice(0, 7).join('\n') + '\n');
    assert.ok(after.subarray(0, head.length).equals(before.subarray(0, head.length)));
    assert.equal(after.toString().split('\n').length, lines.length + 1);
    assert.ok(after.toString().endsWith(`${COST_STATE}\n`));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), [`${SID}.jsonl`]);
  });

  const skips: Array<[string, () => Promise<void> | void, string[], string]> = [
    ['the setting is off', () => updateSettings({ coldResumeClearToolResults: false }), coldTranscript(), 'disabled'],
    ['the model was last called within 65 minutes', () => {}, coldTranscript(minutesBefore(64)), 'warm'],
    ['a keep-warm refresh touched the cache recently', () => noteCacheRefresh(SID, minutesBefore(10)), coldTranscript(minutesBefore(300)), 'warm'],
    ['the context is under 100k tokens', () => {}, [...exchanges(25), assistantUsage(80_000, minutesBefore(70))], 'small-context'],
    ['less than 40k characters would go', () => {}, [...exchanges(17), assistantUsage(150_000, minutesBefore(70))], 'too-little'],
  ];
  for (const [name, arrange, lines, reason] of skips) {
    test(`leaves the transcript alone when ${name}`, async () => {
      await arrange();
      const file = writeTranscript(lines);
      const before = fs.readFileSync(file);
      assert.deepEqual(clearToolResultsForColdResume(file, SID, NOW), { cleared: false, reason });
      assert.ok(fs.readFileSync(file).equals(before));
    });
  }

  test('a missing transcript is a no-op', () => {
    assert.deepEqual(clearToolResultsForColdResume('/nonexistent/x.jsonl', SID, NOW), { cleared: false, reason: 'warm' });
  });

  test('a failed rename keeps the original transcript and removes the temp file', () => {
    const file = writeTranscript(coldTranscript());
    const before = fs.readFileSync(file);
    const io: TranscriptFs = { ...nodeIo, renameSync: () => { throw new Error('EXDEV'); } };
    assert.deepEqual(clearToolResultsForColdResume(file, SID, NOW, io), { cleared: false, reason: 'write-failed' });
    assert.ok(fs.readFileSync(file).equals(before));
    assert.deepEqual(fs.readdirSync(path.dirname(file)), [`${SID}.jsonl`]);
  });

  test('a live segment that is not valid UTF-8 is left alone', () => {
    const file = writeTranscript(coldTranscript());
    fs.appendFileSync(file, Buffer.from([0xff, 0xfe, 0x0a]));
    assert.deepEqual(clearToolResultsForColdResume(file, SID, NOW), { cleared: false, reason: 'unreadable' });
  });
});

describe('ClaudeSession resume spawn', () => {
  function fakeChild() {
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.exitCode = null;
    child.kill = () => true;
    return child;
  }

  function openResumed(resume: boolean) {
    const engine = new ClaudeAdapter().open(engineSpecFixture({
      sessionId: SID, sessionKey: `clear-${resume}`, resume, captureTranscriptLogs: false,
      processSpawner: (() => ({ process: fakeChild() })) as any,
    }));
    return engine;
  }

  // The spawn path reads the real clock.
  function transcriptIdleFor(minutes: number): string {
    return writeTranscript(coldTranscript(minutesBefore(minutes, Date.now())), computeTranscriptPath(AGENT_CWD, SID));
  }

  test('clears a cold transcript before resuming it', async () => {
    const file = transcriptIdleFor(70);
    const engine = openResumed(true);
    try {
      assert.equal(resultContents(fs.readFileSync(file, 'utf8').split('\n')).filter((c) => c === CLEARED_TOOL_RESULT).length, 15);
    } finally {
      await engine.close?.();
    }
  });

  test('a new-session spawn never touches the transcript', async () => {
    const file = transcriptIdleFor(70);
    const before = fs.readFileSync(file);
    const engine = openResumed(false);
    try {
      assert.ok(fs.readFileSync(file).equals(before));
    } finally {
      await engine.close?.();
    }
  });

  test('leaves a warm transcript as it is', async () => {
    const file = transcriptIdleFor(30);
    const before = fs.readFileSync(file);
    const engine = openResumed(true);
    try {
      assert.ok(fs.readFileSync(file).equals(before));
    } finally {
      await engine.close?.();
    }
  });
});
