import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readRestoredSessionCost } from '../../src/agent-adapter/claude/transcript-path.js';
import { _test } from '../../src/agent-adapter/claude/adapter.js';

const SID = 'd37f2bc6-a44b-4afd-8a8d-043035b83817';

function costState(total: number, sessionId = SID): object {
  return { type: 'cost-state', sessionId, totalCostUSD: total, totalAPIDuration: 1, modelUsage: {} };
}

function message(text: string): object {
  return { type: 'user', sessionId: SID, timestamp: '2026-09-27T09:00:00.000Z', message: { role: 'user', content: text } };
}

function writeTranscript(lines: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-resume-cost-'));
  const file = path.join(dir, `${SID}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

describe('readRestoredSessionCost', () => {
  test('returns the last cost-state of the session', () => {
    const file = writeTranscript([message('a'), costState(131.23), message('b'), costState(133.19), message('c')]);
    assert.equal(readRestoredSessionCost(file, SID), 133.19);
  });

  test('ignores other sessions, quoted mentions and malformed entries', () => {
    const file = writeTranscript([
      costState(12.5),
      costState(99, 'other-session'),
      message('the transcript entry looks like {"type":"cost-state","totalCostUSD":500}'),
      { type: 'cost-state', sessionId: SID, totalCostUSD: 'NaN' },
    ]);
    assert.equal(readRestoredSessionCost(file, SID), 12.5);
  });

  test('finds an entry split across read chunks and far from the end', () => {
    const filler = Array.from({ length: 40 }, (_, i) => message(`turn ${i} `.repeat(20)));
    const file = writeTranscript([message('start'), costState(7.25), ...filler]);
    for (const chunk of [16, 97, 1024]) assert.equal(readRestoredSessionCost(file, SID, chunk), 7.25);
  });

  test('is 0 without a cost-state or without a transcript', () => {
    assert.equal(readRestoredSessionCost(writeTranscript([message('a')]), SID), 0);
    assert.equal(readRestoredSessionCost('/nonexistent/transcript.jsonl', SID), 0);
  });
});

describe('resumed process cost accounting', () => {
  const FAKE_STREAM = { write() {}, end() {} } as any;

  function runResult(session: any, totalCostUsd: number): number {
    let resolved: any = null;
    session.currentTurn = {
      resolve: (value: any) => { resolved = value; }, reject: () => {},
      resultData: null, planFilePath: null, enteredPlanMode: false, exitedPlanMode: false,
      finalOutput: null, longestOutput: null, turnCount: 0, subagentTurnCount: 0,
      onProgress: null, onAssistantDelta: null, onCompact: null, onSubagentActivity: null, onSubagentEnd: null,
      rawStream: FAKE_STREAM, txtStream: FAKE_STREAM, killed: false, spontaneous: false,
    };
    session.handleLine(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, session_id: 'test-session',
      total_cost_usd: totalCostUsd, num_turns: 2, usage: { input_tokens: 4, output_tokens: 1503 },
      modelUsage: { 'claude-opus-5-5[1m]': {} }, result: 'ok',
    }));
    return resolved.total_cost_usd;
  }

  test('bills the first resumed turn only what it added to the restored total', (t) => {
    const session: any = _test.makeSessionForTest();
    t.onTestFinished(() => session.close());
    session.turns.resetCostBaseline(133.19);
    assert.ok(Math.abs(runResult(session, 135.04) - 1.85) < 1e-9);
    assert.ok(Math.abs(runResult(session, 135.30) - 0.26) < 1e-9);
  });

  test('a new session starts from zero', (t) => {
    const session: any = _test.makeSessionForTest();
    t.onTestFinished(() => session.close());
    session.turns.resetCostBaseline(0);
    assert.equal(runResult(session, 0.4), 0.4);
  });
});
