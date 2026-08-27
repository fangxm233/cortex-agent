import '../_test-home.js'; // MUST be first — repoints CORTEX_HOME before paths bind
// input:  agent-decision-send module with injected history and event sinks
// output: regressions for decision recording, id minting, limits and shared ts
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
// pos:    guards the agent-announced decision delivery path

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  sendAgentDecisions,
  MAX_DECISION_FIELD_CHARS,
  MAX_DECISIONS_PER_CALL,
  type SendAgentDecisionsDeps,
} from '../../src/orchestration/agent-decision-send.js';
import type { SessionMessagePayload } from '../../src/orchestration/session-events.js';

function harness(): { deps: SendAgentDecisionsDeps; appended: any[]; published: SessionMessagePayload[] } {
  const appended: any[] = [];
  const published: SessionMessagePayload[] = [];
  let n = 0;
  return {
    appended, published,
    deps: {
      appendAssistant: async (sid, o) => { appended.push({ sid, ...o }); },
      publish: (p) => { published.push(p); },
      now: () => '2026-08-27T00:00:00.000Z',
      newId: () => `d${++n}`,
    },
  };
}

const DECISION = {
  title: 'Store results in SQLite',
  decision: 'Run outputs go into results.db instead of JSONL files.',
  context: 'Both stores were possible; queries were getting slow.',
  reasoning: 'Indexed queries stay fast as runs accumulate.',
};

test('one call lands one assistant row carrying every decision, with minted ids', async () => {
  const h = harness();
  const items = await sendAgentDecisions(
    { sessionId: 'sess-1', decisions: [DECISION, { ...DECISION, title: 'Second choice' }] },
    h.deps,
  );

  assert.deepEqual(items.map(d => d.id), ['d1', 'd2'], 'each decision gets a server-side id');
  assert.equal(h.appended.length, 1, 'one call → ONE persisted assistant row');
  assert.equal(h.appended[0].sid, 'sess-1');
  assert.equal(h.appended[0].text, '');
  assert.equal(h.appended[0].decisions.length, 2);
  assert.equal(h.appended[0].decisions[0].title, 'Store results in SQLite');
  assert.equal(h.appended[0].decisions[0].actions, undefined, 'raw rows carry no action log');
});

test('history and bus share one ts; the event carries empty action logs', async () => {
  const h = harness();
  await sendAgentDecisions({ sessionId: 'sess-1', decisions: [DECISION] }, h.deps);

  assert.equal(h.published.length, 1);
  assert.equal(h.appended[0].ts, '2026-08-27T00:00:00.000Z');
  assert.equal(h.published[0].ts, '2026-08-27T00:00:00.000Z', 'history + bus share one ts for de-dup');
  assert.equal(h.published[0].channel, 'web:sess-1');
  assert.equal(h.published[0].role, 'assistant');
  assert.deepEqual(h.published[0].decisions![0].actions, [], 'the live event mirrors the DTO shape');
});

test('every field is required and whitespace-only values are refused', async () => {
  const h = harness();
  for (const missing of ['title', 'decision', 'context', 'reasoning'] as const) {
    await assert.rejects(
      () => sendAgentDecisions({ sessionId: 's', decisions: [{ ...DECISION, [missing]: '  ' }] }, h.deps),
      new RegExp(missing),
    );
  }
  assert.equal(h.appended.length, 0, 'nothing is recorded when validation fails');
});

test('oversize fields and oversize batches are refused, not truncated', async () => {
  const h = harness();
  await assert.rejects(
    () => sendAgentDecisions(
      { sessionId: 's', decisions: [{ ...DECISION, reasoning: 'x'.repeat(MAX_DECISION_FIELD_CHARS + 1) }] },
      h.deps,
    ),
    /reasoning.*limit/,
  );
  await assert.rejects(
    () => sendAgentDecisions(
      { sessionId: 's', decisions: Array.from({ length: MAX_DECISIONS_PER_CALL + 1 }, () => DECISION) },
      h.deps,
    ),
    /limit/,
  );
  await assert.rejects(
    () => sendAgentDecisions({ sessionId: 's', decisions: [] }, h.deps),
    /non-empty/,
  );
});
